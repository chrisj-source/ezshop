import { FastifyInstance } from 'fastify';
import { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { parseEms, EmsEstimate, partTypeToEnum, splitSets } from '../lib/ems';
import { emsExtAllowed, extensionOf, storagePrefix, writeBuffer } from '../lib/storage';
import { notify } from '../notify';
import { auditIn, Area } from '../lib/audit';
import { isSuppressed, noteSuppressionHit } from '../lib/suppression';

interface FieldSpec {
  /** Column on the target table. */
  col: string;
  /** What to call it on screen and in the log. */
  label: string;
  /** What the estimate says. Null or '' means the estimate is silent. */
  next: string | number | null;
  /** Money and dates read differently in a log line than raw values do. */
  format?: (v: unknown) => string;
}

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim() === '' || String(v) === '0';

/**
 * Write a set of fields onto one row, recording what moved.
 *
 * `overwrite` is the whole point of this: the estimate is the authority on the
 * claim, and the first one a shop imports is a guess. What comes back approved
 * replaces it, and a supplement replaces that. Filling blanks only — the old
 * behaviour — left a file carrying a deductible and an approval amount from a
 * draft nobody had agreed to.
 *
 * A silent overwrite would be worse than no overwrite, so every field that moves
 * lands in `ems_import_changes` (scoped to the import, for the screen) and in the
 * audit log (shop-wide, permanent). Nothing is overwritten quietly.
 */
async function applyFields(
  c: PoolConnection,
  opts: {
    table: string;
    where: string;
    whereParams: unknown[];
    fields: FieldSpec[];
    overwrite: boolean;
    importId: number;
    roId: number | null;
    target: string;
    actor: { user: { id: number; name: string }; roleLabel?: string | null };
    area: Area;
  }
): Promise<Array<{ field: string; label: string; from: string; to: string }>> {
  const cols = opts.fields.map(f => f.col);
  const [rows] = await c.query<RowDataPacket[]>(
    'SELECT ' + cols.join(', ') + ' FROM ' + opts.table + ' WHERE ' + opts.where + ' LIMIT 1',
    opts.whereParams
  );
  if (!rows.length) return [];
  const before = rows[0];

  const moved: Array<{ field: string; label: string; from: string; to: string }> = [];
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const f of opts.fields) {
    if (isBlank(f.next)) continue;                  // the estimate is silent
    const had = before[f.col];
    if (!opts.overwrite && !isBlank(had)) continue; // fill-blanks mode

    const show = f.format ?? ((v: unknown) => (isBlank(v) ? '—' : String(v)));
    const from = show(had);
    const to = show(f.next);
    if (from === to) continue;                      // nothing actually moved

    sets.push(f.col + ' = ?');
    params.push(f.next);
    moved.push({ field: f.col, label: f.label, from, to });
  }

  if (!sets.length) return [];

  await c.query(
    'UPDATE ' + opts.table + ' SET ' + sets.join(', ') + ' WHERE ' + opts.where,
    [...params, ...opts.whereParams]
  );

  for (const m of moved) {
    await c.query(
      `INSERT INTO ems_import_changes
         (import_id, ro_id, target, field, label, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [opts.importId, opts.roId, opts.target, m.field, m.label,
       m.from.slice(0, 255), m.to.slice(0, 255)]
    );
  }

  await auditIn(c, { ...opts.actor, source: 'ems' }, {
    entity: opts.target === 'ro' ? 'repair_order' : opts.target,
    roId: opts.roId,
    action: 'ems_import_overwrite',
    area: opts.area,
    label: moved.length === 1
      ? moved[0].label + ' changed by an EMS import — ' + moved[0].from + ' → ' + moved[0].to
      : moved.length + ' fields changed by an EMS import',
    changes: moved.map(m => ({ field: m.label, from: m.from, to: m.to })),
    note: null
  });

  return moved;
}

/**
 * EMS import. A file set lands, is parsed, and WAITS. Nothing touches a repair
 * order until someone accepts it on the import screen — that was the explicit
 * requirement: shops import when they choose to, not on every drop.
 */
export async function registerEms(app: FastifyInstance): Promise<void> {

  /** Upload one or more estimates' file sets. Multipart, any number of files; split by base name. */
  app.post('/api/ems/upload', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'ems', reply)) return;
    if (!req.isMultipart()) return reply.code(400).send({ error: 'Expected a file upload' });

    const cid = ctx.company!.id;
    const files: Array<{ filename: string; buffer: Buffer }> = [];

    for await (const part of req.parts()) {
      if (part.type === 'field') continue;
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk as Buffer);
      files.push({ filename: part.filename ?? 'unnamed', buffer: Buffer.concat(chunks) });
    }

    if (!files.length) return reply.code(400).send({ error: 'No files received' });

    /* Checked across the whole drop before anything is stored, so a bad file
       cannot leave half the sets imported. */
    for (const f of files) {
      const ext = extensionOf(f.filename);
      if (!emsExtAllowed(ext)) {
        return reply.code(415).send({ error: `Cannot accept a .${ext} file in an estimate set.` });
      }
    }

    /* One import per estimate set. Several vehicles dropped together are
       several imports, never one merged parse (lib/ems.ts splitSets). */
    const { sets, stray } = splitSets(files);
    if (!sets.length) return reply.code(400).send({ error: 'No EMS files found in that upload.' });

    const importSet = async (base: string, files: Array<{ filename: string; buffer: Buffer }>) => {
      let est: EmsEstimate;
      try {
        est = parseEms(files);
      } catch (e) {
        const res = await texec(cid, `
          INSERT INTO ems_imports (source, state, parse_error, envelope_name, line_count)
          VALUES ('upload', 'failed', ?, ?, 0)`,
          [(e as Error).message.slice(0, 500), files[0]?.filename.slice(0, 190) ?? null]
        );
        return { ok: false as const, base, error: (e as Error).message, importId: res.insertId };
      }

      // Keep the raw set so a bad parse can be re-run after a fix. One folder per
      // import: the row stores the folder, not a list of twenty file keys.
      /* An estimate set is a bag of whatever the writer produced, so the list is
         wider than the document one — but it is still a list. These files are
         parsed and never served back to a browser; the allowlist is here to stop
         the storage directory becoming somewhere arbitrary files can be put. */
      const prefix = storagePrefix(cid, 'ems');
      for (let i = 0; i < files.length; i++) {
        const ext = extensionOf(files[i].filename);
        const name = String(i + 1).padStart(2, '0') + '.' + ext;
        await writeBuffer(prefix + '/' + name, files[i].buffer);
      }

      const match = await findMatch(cid, est);

      // EMS fields are wider than our columns (CCC's RO_ID is 40 chars, the model
      // description 50) — clip rather than let a long value throw.
      const clip = (v: string | null, n: number): string | null =>
        v === null || v === undefined ? null : v.slice(0, n);

      // Everything the estimate said about the claim is kept, not just the claim
      // number: without these the carrier had to be typed in again by hand after
      // every import.
      const res = await texec(cid, `
        INSERT INTO ems_imports
          (source, estimating_system, envelope_name, ro_number, claim_number,
           insurer_name, policy_number, deductible_cents, deductible_waived,
           date_of_loss, adjuster, estimator, vin,
           customer_name, customer_phone, customer_phone2, customer_email,
           customer_addr, customer_city, customer_state, customer_zip,
           insurer_phone, adjuster_phone, adjuster_email,
           vehicle_text, vehicle_color, plate, plate_state, mileage,
           supplement_seq, total_cents, line_count,
           matched_ro_id, match_confidence, state, storage_key)
        VALUES ('upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [clip(est.estimatingSystem, 32), clip(est.envelopeName, 190), clip(est.roNumber, 32),
         clip(est.claimNumber, 64),
         clip(est.insurer, 190), clip(est.policyNumber, 64),
         est.deductibleCents, est.deductibleWaived ? 1 : 0,
         est.dateOfLoss, clip(est.adjuster, 120), clip(est.estimator, 120),
         clip(est.vin, 24), clip(est.customerName, 160),
         clip(est.customerPhone, 32), clip(est.customerPhone2, 32),
         clip(est.customerEmail, 190), clip(est.customerAddress, 190),
         clip(est.customerCity, 96), clip(est.customerState, 8), clip(est.customerZip, 16),
         clip(est.insurerPhone, 32), clip(est.adjusterPhone, 32), clip(est.adjusterEmail, 190),
         clip([est.year, est.make, est.model].filter(Boolean).join(' ') || null, 160),
         clip(est.color, 48), clip(est.plate, 16), clip(est.plateState, 8), est.mileage,
         est.supplementSeq, est.grossCents ?? est.netCents, est.lines.length,
         match.roId, match.confidence, prefix]
      );
      const importId = res.insertId;

      if (est.lines.length) {
        const rows = est.lines.map(l => [
          importId, l.lineNo, clip(l.operation, 32), clip(l.description, 255),
          clip(l.partNumber, 64), clip(l.partType, 24),
          Math.max(1, Math.round(l.qty)), l.priceCents, l.laborHours, clip(l.laborType, 24), 1
        ]);
        await texec(cid, `
          INSERT INTO ems_import_lines
            (import_id, line_no, operation, description, part_number, part_type,
             qty, price_cents, labor_hours, labor_type, is_new)
          VALUES ?`, [rows]
        );
      }

      await notify({
        companyId: cid,
        event: 'supp.decision',
        roId: match.roId,
        title: est.supplementSeq
          ? `Supplement ${est.supplementSeq} imported — ${est.roNumber ?? est.vin ?? 'unmatched'}`
          : `Estimate imported — ${est.roNumber ?? est.vin ?? 'unmatched'}`,
        body: `${est.lines.length} lines waiting for review on the import screen.`,
        actorUserId: ctx.user.id,
        dedupeKey: `ems:${importId}`
      }).catch(() => {});


      return {
        ok: true as const, base, importId, estimate: est, match,
        candidates: match.roId ? [] : await candidates(cid, est)
      };
    };

    const results = [];
    for (const s of sets) results.push(await importSet(s.base, s.files));

    const good = results.filter(r => r.ok);
    if (!good.length) {
      const first = results[0] as { error: string; importId: number };
      return reply.code(400).send({
        error: results.length === 1 ? first.error : `None of the ${results.length} estimates could be read.`,
        importId: first.importId, results
      });
    }

    /* The single-set shape is kept for anything that read it before. */
    const one = good.length === 1 && results.length === 1 ? good[0] : null;
    return {
      ok: true,
      count: results.length,
      imported: good.length,
      stray,
      results,
      ...(one ? { importId: one.importId, estimate: one.estimate, match: one.match, candidates: one.candidates } : {})
    };
  });

  /** Pending and recent imports. */
  app.get('/api/ems/imports', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'ems', reply)) return;

    const q = req.query as { state?: string };
    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT i.*, r.ro_number AS matched_ro_number
      FROM ems_imports i
      LEFT JOIN repair_orders r ON r.id = i.matched_ro_id
      ${q.state ? 'WHERE i.state = ?' : "WHERE i.state IN ('pending','failed') OR i.decided_at > DATE_SUB(NOW(), INTERVAL 14 DAY)"}
      ORDER BY i.received_at DESC
      LIMIT 200`,
      q.state ? [q.state] : []
    );

    const [counts] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT SUM(state = 'pending') AS pending,
             SUM(state = 'failed') AS failed,
             SUM(state = 'accepted' AND decided_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS accepted_week
      FROM ems_imports`);

    return {
      imports: rows,
      counts: {
        pending: Number(counts.pending ?? 0),
        failed: Number(counts.failed ?? 0),
        acceptedWeek: Number(counts.accepted_week ?? 0)
      }
    };
  });

  /** One import, with its lines and its match candidates. */
  app.get('/api/ems/imports/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const imp = await tqOne<RowDataPacket>(cid, 'SELECT * FROM ems_imports WHERE id = ?', [id]);
    if (!imp) return reply.code(404).send({ error: 'No such import' });

    const lines = await tq<RowDataPacket[]>(cid,
      'SELECT * FROM ems_import_lines WHERE import_id = ? ORDER BY line_no, id', [id]);

    const cands = await candidates(cid, {
      roNumber: imp.ro_number as string | null,
      vin: imp.vin as string | null,
      claimNumber: imp.claim_number as string | null
    });

    /* What an accepted import overwrote. Empty on a pending one. */
    const changes = await tq<RowDataPacket[]>(cid,
      `SELECT target, field, label, old_value, new_value, created_at
       FROM ems_import_changes WHERE import_id = ? ORDER BY id`, [id]);

    return { import: imp, lines, candidates: cands, changes };
  });

  /**
   * Accept an import onto a repair order — either an existing one or a new
   * file created from the estimate. Everything happens in one transaction.
   */
  app.post('/api/ems/imports/:id/accept', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'ems', reply)) return;
    if (!ctx.caps.acceptImports) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const body = req.body as {
      roId?: number | null;
      createNew?: boolean;
      importParts?: boolean;
      importSublets?: boolean;
      updateVehicle?: boolean;
      updateCustomer?: boolean;
      updateMoney?: boolean;
      /* An accepted import overwrites what the estimate is authoritative about.
         An initial estimate is a guess; what comes back approved is the answer,
         and a supplement is more authoritative still. Set false to fill blanks
         only — the old behaviour, kept for a shop that wants it. */
      overwrite?: boolean;
    };

    const imp = await tqOne<RowDataPacket & { state: string; storage_key: string | null }>(
      cid, 'SELECT * FROM ems_imports WHERE id = ?', [id]);
    if (!imp) return reply.code(404).send({ error: 'No such import' });
    if (imp.state === 'accepted') return reply.code(409).send({ error: 'That import was already accepted.' });

    const lines = await tq<RowDataPacket[]>(cid,
      'SELECT * FROM ems_import_lines WHERE import_id = ? ORDER BY line_no, id', [id]);

    const result = await withTenantTx(cid, async (c) => {
      let roId = body.roId ?? null;
      let created = false;

      if (!roId && body.createNew) {
        /* An RO number is the last six of the VIN — never CCC's RO_ID, which is
           the estimator's own reference and is how an import used to land on
           somebody else's car. "Create" means create: a number already held is
           refused by name, never quietly attached to. */
        const vin = normVin(imp.vin as string | null);
        if (!vin || vin.length < 6) {
          throw new Error('The estimate has no VIN, so there is no RO number to give the file. Add the VIN in the estimating system and export again.');
        }
        const roNumber = vin.slice(-6);

        const [dup] = await c.query<RowDataPacket[]>(
          `SELECT r.ro_number, r.closed_at, r.voided_at,
                  CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle
           FROM repair_orders r LEFT JOIN vehicles v ON v.id = r.vehicle_id
           WHERE r.ro_number = ?`, [roNumber]);
        if (dup.length) {
          const d = dup[0];
          const what = [d.vehicle, d.voided_at ? 'voided' : d.closed_at ? 'closed' : 'open']
            .filter(Boolean).join(', ');
          throw new Error(`RO ${roNumber} is already taken (${what}). Pick that file above if it is this car, or open it and renumber it.`);
        }
        {
          let clientId: number | null = null;
          if (imp.customer_name) {
            const [r] = await c.query<ResultSetHeader>(
              `INSERT INTO clients (kind, name, phone, phone2, email, address, city, state, zip)
               VALUES ('retail', ?, ?, ?, ?, ?, ?, ?, ?)`,
              [imp.customer_name, imp.customer_phone ?? null, imp.customer_phone2 ?? null,
               imp.customer_email ?? null, imp.customer_addr ?? null, imp.customer_city ?? null,
               imp.customer_state ?? null, imp.customer_zip ?? null]);
            clientId = r.insertId;
          }

          let vehicleId: number | null = null;
          if (imp.vin || imp.vehicle_text) {
            const parts = String(imp.vehicle_text ?? '').split(' ');
            const year = Number(parts[0]) || null;
            const [r] = await c.query<ResultSetHeader>(
              `INSERT INTO vehicles (client_id, vin, year, make, model, color, plate, plate_state, mileage)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [clientId, imp.vin ?? null, year, parts[1] ?? null, parts.slice(2).join(' ') || null,
               imp.vehicle_color ?? null, imp.plate ?? null, imp.plate_state ?? null,
               imp.mileage ?? null]);
            vehicleId = r.insertId;
          }

          const insurerId = await insurerIdFor(c, imp.insurer_name as string | null);

          const [r] = await c.query<ResultSetHeader>(
            `INSERT INTO repair_orders
               (ro_number, client_id, vehicle_id, insurer_client_id, ro_type, repair_path,
                status_slot, status_since, claim_number, policy_number, date_of_loss,
                deductible_cents, deductible_waived, adjuster, adjuster_phone, adjuster_email,
                amount_cents, created_by)
             VALUES (?, ?, ?, ?, 'repair', 'undecided', 'intake.arrived', NOW(),
                     ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [roNumber, clientId, vehicleId, insurerId, imp.claim_number ?? null,
             imp.policy_number ?? null, imp.date_of_loss ?? null,
             imp.deductible_cents ?? null, imp.deductible_waived ? 1 : 0,
             imp.adjuster ?? null, imp.adjuster_phone ?? null, imp.adjuster_email ?? null,
             imp.total_cents ?? 0, ctx.user.id]);
          roId = r.insertId;
          created = true;

          await c.query(
            `INSERT INTO ro_status_history (ro_id, from_slot, to_slot, to_label, reason, user_id, user_name)
             VALUES (?, NULL, 'intake.arrived', 'Vehicle Arrived', 'Created from an EMS import', ?, ?)`,
            [roId, ctx.user.id, ctx.user.name]);
        }
      }

      if (!roId) throw new Error('Pick the repair order this estimate belongs to.');

      const suppSeq = imp.supplement_seq as number | null;

      /* Default is overwrite. An initial estimate is a guess; what comes back
         approved is the answer. Pass overwrite:false to fill blanks only. */
      const over = body.overwrite !== false;
      const actor = { user: ctx.user, roleLabel: ctx.roleLabel ?? null };
      const dollars = (v: unknown) => (isBlank(v) ? '—' : '$' + (Number(v) / 100).toFixed(2));
      const changed: Array<{ field: string; label: string; from: string; to: string }> = [];
      /* Things the import deliberately did NOT do. Reported beside what it did,
         because a field silently not moving is worse than one that moved. */
      const heldBack: string[] = [];

      if (body.updateMoney !== false && imp.total_cents) {
        const hours = lines.reduce((a, l) => a + Number(l.labor_hours ?? 0), 0);
        changed.push(...await applyFields(c, {
          table: 'repair_orders', where: 'id = ?', whereParams: [roId],
          overwrite: over, importId: id, roId, target: 'ro', area: 'Money', actor,
          fields: [
            { col: 'amount_cents', label: 'Approval amount', next: imp.total_cents as number, format: dollars },
            { col: 'labor_hours', label: 'Labor hours', next: hours || null }
          ]
        }));
        /* The approval stamp is set once and never moved by a re-import — it is
           what the commission ledger dates its line from. */
        await c.query(
          'UPDATE repair_orders SET approved_at = COALESCE(approved_at, NOW()) WHERE id = ?', [roId]);
      }

      if (body.updateVehicle !== false) {
        changed.push(...await applyFields(c, {
          table: 'vehicles v JOIN repair_orders r ON r.vehicle_id = v.id',
          where: 'r.id = ?', whereParams: [roId],
          overwrite: over, importId: id, roId, target: 'vehicle', area: 'Repair order', actor,
          fields: [
            { col: 'v.vin', label: 'VIN', next: (imp.vin as string) ?? null },
            { col: 'v.color', label: 'Colour', next: (imp.vehicle_color as string) ?? null },
            { col: 'v.plate', label: 'Plate', next: (imp.plate as string) ?? null },
            { col: 'v.plate_state', label: 'Plate state', next: (imp.plate_state as string) ?? null },
            { col: 'v.mileage', label: 'Mileage', next: (imp.mileage as number) ?? null }
          ]
        }));
      }

      /* Customer contact. The estimate is where the phone and email came from in
         the first place, so a corrected one on a later estimate is a correction
         to us too. Nothing here is ever blanked — a silent estimate leaves what
         the desk typed alone. */
      if (body.updateCustomer !== false) {
        /**
         * The estimate does not get to un-block an address.
         *
         * An import is authoritative about the claim, not about consent. If the
         * estimate carries an address this shop's customer has unsubscribed,
         * writing it onto the client record would look like the suppression had
         * been lifted — it has not, and only the customer can lift it. So the
         * email field is dropped from this import's field list and REPORTED
         * instead, on `heldBack`, which the confirm screen shows next to
         * everything that did move.
         *
         * Every other field still overwrites as normal.
         */
        const estEmail = (imp.customer_email as string) ?? null;
        const emailBlocked = estEmail
          ? await isSuppressed('email', estEmail, cid)
          : false;

        if (emailBlocked && estEmail) {
          await noteSuppressionHit(cid, 'email', estEmail, 'carried by an estimate import');
          heldBack.push(
            `Email left as it was — the estimate carries ${estEmail}, which has ` +
            `unsubscribed. Only the customer can switch it back on.`
          );
        }

        changed.push(...await applyFields(c, {
          table: 'clients cl JOIN repair_orders r ON r.client_id = cl.id',
          where: 'r.id = ?', whereParams: [roId],
          overwrite: over, importId: id, roId, target: 'client', area: 'Repair order', actor,
          fields: [
            { col: 'cl.name', label: 'Customer name', next: (imp.customer_name as string) ?? null },
            { col: 'cl.phone', label: 'Phone', next: (imp.customer_phone as string) ?? null },
            { col: 'cl.phone2', label: 'Second phone', next: (imp.customer_phone2 as string) ?? null },
            ...(emailBlocked ? [] : [
              { col: 'cl.email', label: 'Email', next: estEmail } as FieldSpec
            ]),
            { col: 'cl.address', label: 'Address', next: (imp.customer_addr as string) ?? null },
            { col: 'cl.city', label: 'City', next: (imp.customer_city as string) ?? null },
            { col: 'cl.state', label: 'State', next: (imp.customer_state as string) ?? null },
            { col: 'cl.zip', label: 'ZIP', next: (imp.customer_zip as string) ?? null }
          ]
        }));
      }

      /* Insurance, straight off the estimate. This is the block that used to fill
         blanks only, which is how a file ended up with a draft's deductible. */
      if (imp.insurer_name || imp.claim_number || imp.policy_number || imp.date_of_loss || imp.adjuster) {
        const insurerId = await insurerIdFor(c, imp.insurer_name as string | null);
        changed.push(...await applyFields(c, {
          table: 'repair_orders', where: 'id = ?', whereParams: [roId],
          overwrite: over, importId: id, roId, target: 'ro', area: 'Money', actor,
          fields: [
            { col: 'insurer_client_id', label: 'Insurer', next: insurerId },
            { col: 'claim_number', label: 'Claim number', next: (imp.claim_number as string) ?? null },
            { col: 'policy_number', label: 'Policy number', next: (imp.policy_number as string) ?? null },
            { col: 'date_of_loss', label: 'Date of loss', next: (imp.date_of_loss as string) ?? null },
            { col: 'deductible_cents', label: 'Deductible', next: (imp.deductible_cents as number) ?? null, format: dollars },
            { col: 'adjuster', label: 'Adjuster', next: (imp.adjuster as string) ?? null },
            { col: 'adjuster_phone', label: 'Adjuster phone', next: (imp.adjuster_phone as string) ?? null },
            { col: 'adjuster_email', label: 'Adjuster email', next: (imp.adjuster_email as string) ?? null }
          ]
        }));
        /* Waived only ever turns on from an import; turning it off is a decision
           somebody makes on the file, not something a re-import undoes. */
        if (imp.deductible_waived) {
          await c.query('UPDATE repair_orders SET deductible_waived = 1 WHERE id = ?', [roId]);
        }
      }

      if (body.importParts !== false) {
        const partLines = lines.filter(l =>
          Number(l.price_cents ?? 0) > 0 && (l.part_number || l.part_type));
        for (const l of partLines) {
          const [exists] = await c.query<RowDataPacket[]>(
            `SELECT id FROM parts_lines WHERE ro_id = ? AND line_no = ? AND description = ?`,
            [roId, l.line_no ?? null, l.description ?? '']);
          if (exists.length) continue;

          await c.query(
            `INSERT INTO parts_lines
               (ro_id, line_no, description, part_number, part_type, part_type_estimated,
                qty, price_cents, state, gating)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'need', 1)`,
            [roId, l.line_no ?? null, String(l.description ?? 'Part').slice(0, 255),
             l.part_number ?? null, partTypeToEnum(l.part_type as string | null),
             /* The estimate's own type, kept apart from the type the shop ends
                up buying. Both columns start the same; only the ordered one
                moves when the desk buys something else. */
             partTypeToEnum(l.part_type as string | null),
             Number(l.qty ?? 1), Number(l.price_cents ?? 0)]);
        }
      }

      if (suppSeq) {
        const [existing] = await c.query<RowDataPacket[]>(
          'SELECT id FROM supplements WHERE ro_id = ? AND seq = ?', [roId, suppSeq]);
        if (!existing.length) {
          await c.query(
            `INSERT INTO supplements (ro_id, seq, state, requested_cents, approved_cents, sent_at, created_by)
             VALUES (?, ?, 'approved', ?, ?, CURDATE(), ?)`,
            [roId, suppSeq, imp.total_cents ?? 0, imp.total_cents ?? 0, ctx.user.id]);
        }
      }

      await c.query(
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [roId,
         `${suppSeq ? `Supplement ${suppSeq}` : 'Estimate'} imported from ` +
         `${String(imp.estimating_system ?? 'EMS').toUpperCase()} — ${lines.length} lines` +
         `${created ? ', file created from the import' : ''}.` +
         (changed.length
           ? ' Overwritten: ' + changed.map(m => `${m.label} ${m.from} → ${m.to}`).join('; ') + '.'
           : '') +
         (heldBack.length ? ' ' + heldBack.join(' ') : ''),
         ctx.user.id, ctx.user.name]);

      await c.query(
        `UPDATE ems_imports SET state = 'accepted', matched_ro_id = ?, decided_at = NOW(), decided_by = ?
         WHERE id = ?`, [roId, ctx.user.id, id]);

      // An older pending import for the same file is now stale.
      await c.query(
        `UPDATE ems_imports SET state = 'superseded'
         WHERE state = 'pending' AND id <> ? AND ro_number = ? AND COALESCE(supplement_seq,0) <= ?`,
        [id, imp.ro_number ?? '', suppSeq ?? 0]);

      return { roId, created, changed, heldBack };
    });

    return { ok: true, ...result };
  });

  app.post('/api/ems/imports/:id/reject', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.acceptImports) return reply.code(403).send({ error: 'Not permitted' });
    const id = Number((req.params as { id: string }).id);

    await texec(ctx.company!.id,
      `UPDATE ems_imports SET state = 'rejected', decided_at = NOW(), decided_by = ? WHERE id = ?`,
      [ctx.user.id, id]);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ matching */

interface MatchKeys { roNumber: string | null; vin: string | null; claimNumber: string | null; }

/**
 * RO number first, then VIN, then claim number — and the confidence says which,
 * so the screen can ask rather than guess.
 *
 * A file whose VIN disagrees with the estimate's is never a match, whatever
 * else lines up. CCC's RO_ID and a claim number are both free text somebody
 * typed; a VIN is the car. Only a full-VIN hit is 'exact' enough for the
 * screen to preselect — everything else is offered, and the default with no
 * exact hit is a new file.
 */
const OPEN_RO = 'r.close_date IS NULL AND r.closed_at IS NULL AND r.voided_at IS NULL';
const normVin = (v: string | null) => (v ?? '').replace(/\s+/g, '').toUpperCase() || null;

async function findMatch(cid: number, k: MatchKeys): Promise<{ roId: number | null; confidence: 'exact' | 'likely' | 'none'; how: string | null }> {
  const vin = normVin(k.vin);
  /* Same car, or a file that has no VIN yet to disagree with. */
  const sameCar = vin ? ' AND (v.vin IS NULL OR v.vin = \'\' OR UPPER(v.vin) = ?)' : '';
  const carParam = vin ? [vin] : [];
  const one = (where: string, params: unknown[]) =>
    tqOne<RowDataPacket & { id: number }>(cid, `
      SELECT r.id FROM repair_orders r LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE ${OPEN_RO} AND ${where}${sameCar}
      ORDER BY r.opened_at DESC LIMIT 1`, [...params, ...carParam]);

  if (vin) {
    const hit = await one('UPPER(v.vin) = ?', [vin]);
    if (hit) return { roId: hit.id, confidence: 'exact', how: 'VIN' };
  }

  if (k.roNumber) {
    const hit = await one('r.ro_number = ?', [k.roNumber]);
    if (hit) return { roId: hit.id, confidence: 'likely', how: 'RO number' };
  }

  if (vin) {
    // A file numbered off the VIN that has no VIN on it yet.
    const hit = await one('r.ro_number = ?', [vin.slice(-6)]);
    if (hit) return { roId: hit.id, confidence: 'likely', how: 'last six of the VIN' };
  }

  if (k.claimNumber) {
    const hit = await one('r.claim_number = ?', [k.claimNumber]);
    if (hit) return { roId: hit.id, confidence: 'likely', how: 'claim number' };
  }

  return { roId: null, confidence: 'none', how: null };
}

/**
 * The carrier as an insurance client. Matched by name, created if the shop has
 * not seen it before — the same rule the drawer's carrier field follows, so an
 * imported file and a hand-typed one end up pointing at one client.
 */
async function insurerIdFor(c: PoolConnection, name: string | null): Promise<number | null> {
  const clean = (name ?? '').trim().slice(0, 190);
  if (!clean) return null;

  const [hit] = await c.query<RowDataPacket[]>(
    `SELECT id FROM clients WHERE kind = 'insurance' AND name = ? LIMIT 1`, [clean]);
  if (hit.length) return hit[0].id as number;

  const [ins] = await c.query<ResultSetHeader>(
    `INSERT INTO clients (kind, name) VALUES ('insurance', ?)`, [clean]);
  return ins.insertId;
}

/** Open files that look plausible, for the human to choose from. Same VIN
    guard as findMatch; no keys means no candidates, never "every open file". */
async function candidates(cid: number, k: MatchKeys): Promise<RowDataPacket[]> {
  const vin = normVin(k.vin);
  const where: string[] = [];
  const params: unknown[] = [];

  if (vin) {
    where.push('UPPER(v.vin) = ?', 'r.ro_number = ?');
    params.push(vin, vin.slice(-6));
  }
  if (k.roNumber) { where.push('r.ro_number = ?'); params.push(k.roNumber); }
  if (k.claimNumber) { where.push('r.claim_number = ?'); params.push(k.claimNumber); }
  if (!where.length) return [];

  const sameCar = vin ? " AND (v.vin IS NULL OR v.vin = '' OR UPPER(v.vin) = ?)" : '';
  if (vin) params.push(vin);

  return tq<RowDataPacket[]>(cid, `
    SELECT r.id, r.ro_number, r.claim_number, r.opened_at, v.vin,
           CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle,
           c.name AS customer_name, s.label AS status_label
    FROM repair_orders r
    LEFT JOIN vehicles v ON v.id = r.vehicle_id
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN statuses s ON s.slot_id = r.status_slot
    WHERE ${OPEN_RO} AND (${where.join(' OR ')})${sameCar}
    ORDER BY r.opened_at DESC
    LIMIT 25`, params);
}
