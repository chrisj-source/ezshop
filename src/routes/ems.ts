import { FastifyInstance } from 'fastify';
import { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { parseEms, EmsEstimate, partTypeToEnum } from '../lib/ems';
import { emsExtAllowed, extensionOf, storagePrefix, writeBuffer } from '../lib/storage';
import { notify } from '../notify';
import { auditIn, Area } from '../lib/audit';

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

  /** Upload one estimate's file set. Multipart, any number of files. */
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

    let est: EmsEstimate;
    try {
      est = parseEms(files);
    } catch (e) {
      const res = await texec(cid, `
        INSERT INTO ems_imports (source, state, parse_error, envelope_name, line_count)
        VALUES ('upload', 'failed', ?, ?, 0)`,
        [(e as Error).message.slice(0, 500), files[0]?.filename.slice(0, 190) ?? null]
      );
      return reply.code(400).send({ error: (e as Error).message, importId: res.insertId });
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
      if (!emsExtAllowed(ext)) {
        return reply.code(415).send({
          error: `Cannot accept a .${ext} file in an estimate set.`
        });
      }
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
      ok: true,
      importId,
      estimate: est,
      match,
      candidates: match.roId ? [] : await candidates(cid, est)
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
        const vinTail = ((imp.vin as string | null) ?? '').slice(-6);
        const roNumber = (imp.ro_number as string | null) || vinTail || null;
        if (!roNumber) throw new Error('The estimate has no RO number and no VIN to build one from.');

        const [dup] = await c.query<RowDataPacket[]>(
          'SELECT id FROM repair_orders WHERE ro_number = ?', [roNumber]);
        if (dup.length) {
          roId = dup[0].id as number;
        } else {
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

      if (body.updateMoney !== false && imp.total_cents) {
        const hours = lines.reduce((a, l) => a + Number(l.labor_hours ?? 0), 0);
        changed.push(...await applyFields(c, {
          table: 'repair_orders', where: 'id = ?', whereParams: [roId],
          overwrite: over, importId: id, roId, target: 'ro', area: 'Money', actor,
          fields: [
            { col: 'amount_cents', label: 'Approval amount', next: imp.total_cents as number, format: dollars },
            { col: 'labor_hours', label: 'Labour hours', next: hours || null }
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
        changed.push(...await applyFields(c, {
          table: 'clients cl JOIN repair_orders r ON r.client_id = cl.id',
          where: 'r.id = ?', whereParams: [roId],
          overwrite: over, importId: id, roId, target: 'client', area: 'Repair order', actor,
          fields: [
            { col: 'cl.name', label: 'Customer name', next: (imp.customer_name as string) ?? null },
            { col: 'cl.phone', label: 'Phone', next: (imp.customer_phone as string) ?? null },
            { col: 'cl.phone2', label: 'Second phone', next: (imp.customer_phone2 as string) ?? null },
            { col: 'cl.email', label: 'Email', next: (imp.customer_email as string) ?? null },
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
           : ''),
         ctx.user.id, ctx.user.name]);

      await c.query(
        `UPDATE ems_imports SET state = 'accepted', matched_ro_id = ?, decided_at = NOW(), decided_by = ?
         WHERE id = ?`, [roId, ctx.user.id, id]);

      // An older pending import for the same file is now stale.
      await c.query(
        `UPDATE ems_imports SET state = 'superseded'
         WHERE state = 'pending' AND id <> ? AND ro_number = ? AND COALESCE(supplement_seq,0) <= ?`,
        [id, imp.ro_number ?? '', suppSeq ?? 0]);

      return { roId, created, changed };
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
 */
async function findMatch(cid: number, k: MatchKeys): Promise<{ roId: number | null; confidence: 'exact' | 'likely' | 'none'; how: string | null }> {
  if (k.roNumber) {
    const hit = await tqOne<RowDataPacket & { id: number }>(cid,
      'SELECT id FROM repair_orders WHERE ro_number = ? AND close_date IS NULL AND closed_at IS NULL AND voided_at IS NULL', [k.roNumber]);
    if (hit) return { roId: hit.id, confidence: 'exact', how: 'RO number' };
  }

  if (k.vin) {
    const hit = await tqOne<RowDataPacket & { id: number }>(cid, `
      SELECT r.id FROM repair_orders r JOIN vehicles v ON v.id = r.vehicle_id
      WHERE v.vin = ? AND r.close_date IS NULL AND r.closed_at IS NULL AND r.voided_at IS NULL
      ORDER BY r.opened_at DESC LIMIT 1`, [k.vin]);
    if (hit) return { roId: hit.id, confidence: 'exact', how: 'VIN' };

    // Wholesale files are numbered off the tail of the VIN — and CCC's own
    // RO_ID field is often the last eight, not a shop RO number at all.
    for (const n of [8, 6]) {
      const tail = k.vin.slice(-n);
      const byTail = await tqOne<RowDataPacket & { id: number }>(cid,
        'SELECT id FROM repair_orders WHERE ro_number = ? AND close_date IS NULL AND closed_at IS NULL AND voided_at IS NULL', [tail]);
      if (byTail) return { roId: byTail.id, confidence: 'likely', how: `last ${n === 8 ? 'eight' : 'six'} of the VIN` };
    }
  }

  if (k.claimNumber) {
    const hit = await tqOne<RowDataPacket & { id: number }>(cid,
      'SELECT id FROM repair_orders WHERE claim_number = ? AND close_date IS NULL AND closed_at IS NULL AND voided_at IS NULL', [k.claimNumber]);
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

/** Open files that look plausible, for the human to choose from. */
async function candidates(cid: number, k: MatchKeys): Promise<RowDataPacket[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (k.vin) {
    where.push('v.vin = ?', 'RIGHT(v.vin, 8) = ?');
    params.push(k.vin, k.vin.slice(-8));
  }
  if (k.roNumber) { where.push('r.ro_number LIKE ?'); params.push(`%${k.roNumber}%`); }
  if (k.claimNumber) { where.push('r.claim_number = ?'); params.push(k.claimNumber); }

  return tq<RowDataPacket[]>(cid, `
    SELECT r.id, r.ro_number, r.claim_number, r.opened_at, v.vin,
           CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle,
           c.name AS customer_name, s.label AS status_label
    FROM repair_orders r
    LEFT JOIN vehicles v ON v.id = r.vehicle_id
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN statuses s ON s.slot_id = r.status_slot
    WHERE r.close_date IS NULL AND r.closed_at IS NULL AND r.voided_at IS NULL ${where.length ? 'AND (' + where.join(' OR ') + ')' : ''}
    ORDER BY r.opened_at DESC
    LIMIT 25`, params);
}
