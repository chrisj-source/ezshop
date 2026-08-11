import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { parseEms, EmsEstimate, partTypeToEnum } from '../lib/ems';
import { extensionOf, storagePrefix, writeBuffer } from '../lib/storage';
import { notify } from '../notify';

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
    const prefix = storagePrefix(cid, 'ems');
    for (let i = 0; i < files.length; i++) {
      const name = String(i + 1).padStart(2, '0') + '.' + extensionOf(files[i].filename);
      await writeBuffer(prefix + '/' + name, files[i].buffer);
    }

    const match = await findMatch(cid, est);

    // EMS fields are wider than our columns (CCC's RO_ID is 40 chars, the model
    // description 50) — clip rather than let a long value throw.
    const clip = (v: string | null, n: number): string | null =>
      v === null || v === undefined ? null : v.slice(0, n);

    const res = await texec(cid, `
      INSERT INTO ems_imports
        (source, estimating_system, envelope_name, ro_number, claim_number, vin,
         customer_name, vehicle_text, supplement_seq, total_cents, line_count,
         matched_ro_id, match_confidence, state, storage_key)
      VALUES ('upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [clip(est.estimatingSystem, 32), clip(est.envelopeName, 190), clip(est.roNumber, 32),
       clip(est.claimNumber, 64), clip(est.vin, 24), clip(est.customerName, 160),
       clip([est.year, est.make, est.model].filter(Boolean).join(' ') || null, 160),
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

    return { import: imp, lines, candidates: cands };
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
              `INSERT INTO clients (kind, name, phone) VALUES ('retail', ?, ?)`,
              [imp.customer_name, null]);
            clientId = r.insertId;
          }

          let vehicleId: number | null = null;
          if (imp.vin || imp.vehicle_text) {
            const parts = String(imp.vehicle_text ?? '').split(' ');
            const year = Number(parts[0]) || null;
            const [r] = await c.query<ResultSetHeader>(
              `INSERT INTO vehicles (client_id, vin, year, make, model) VALUES (?, ?, ?, ?, ?)`,
              [clientId, imp.vin ?? null, year, parts[1] ?? null, parts.slice(2).join(' ') || null]);
            vehicleId = r.insertId;
          }

          let insurerId: number | null = null;
          const [r] = await c.query<ResultSetHeader>(
            `INSERT INTO repair_orders
               (ro_number, client_id, vehicle_id, insurer_client_id, ro_type, repair_path,
                status_slot, status_since, claim_number, amount_cents, created_by)
             VALUES (?, ?, ?, ?, 'repair', 'undecided', 'intake.arrived', NOW(), ?, ?, ?)`,
            [roNumber, clientId, vehicleId, insurerId, imp.claim_number ?? null,
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

      if (body.updateMoney !== false && imp.total_cents) {
        const hours = lines.reduce((a, l) => a + Number(l.labor_hours ?? 0), 0);
        await c.query(
          `UPDATE repair_orders
           SET amount_cents = ?, labor_hours = ?, approved_at = COALESCE(approved_at, NOW())
           WHERE id = ?`,
          [imp.total_cents, hours || 0, roId]);
      }

      if (body.updateVehicle !== false && imp.vin) {
        await c.query(
          `UPDATE vehicles v JOIN repair_orders r ON r.vehicle_id = v.id
           SET v.vin = COALESCE(NULLIF(v.vin, ''), ?)
           WHERE r.id = ?`, [imp.vin, roId]);
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
               (ro_id, line_no, description, part_number, part_type, qty, price_cents, state, gating)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'need', 1)`,
            [roId, l.line_no ?? null, String(l.description ?? 'Part').slice(0, 255),
             l.part_number ?? null, partTypeToEnum(l.part_type as string | null),
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
         `${created ? ', file created from the import' : ''}.`,
         ctx.user.id, ctx.user.name]);

      await c.query(
        `UPDATE ems_imports SET state = 'accepted', matched_ro_id = ?, decided_at = NOW(), decided_by = ?
         WHERE id = ?`, [roId, ctx.user.id, id]);

      // An older pending import for the same file is now stale.
      await c.query(
        `UPDATE ems_imports SET state = 'superseded'
         WHERE state = 'pending' AND id <> ? AND ro_number = ? AND COALESCE(supplement_seq,0) <= ?`,
        [id, imp.ro_number ?? '', suppSeq ?? 0]);

      return { roId, created };
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
      'SELECT id FROM repair_orders WHERE ro_number = ? AND closed_at IS NULL AND voided_at IS NULL', [k.roNumber]);
    if (hit) return { roId: hit.id, confidence: 'exact', how: 'RO number' };
  }

  if (k.vin) {
    const hit = await tqOne<RowDataPacket & { id: number }>(cid, `
      SELECT r.id FROM repair_orders r JOIN vehicles v ON v.id = r.vehicle_id
      WHERE v.vin = ? AND r.closed_at IS NULL AND r.voided_at IS NULL
      ORDER BY r.opened_at DESC LIMIT 1`, [k.vin]);
    if (hit) return { roId: hit.id, confidence: 'exact', how: 'VIN' };

    // Wholesale files are numbered off the tail of the VIN — and CCC's own
    // RO_ID field is often the last eight, not a shop RO number at all.
    for (const n of [8, 6]) {
      const tail = k.vin.slice(-n);
      const byTail = await tqOne<RowDataPacket & { id: number }>(cid,
        'SELECT id FROM repair_orders WHERE ro_number = ? AND closed_at IS NULL AND voided_at IS NULL', [tail]);
      if (byTail) return { roId: byTail.id, confidence: 'likely', how: `last ${n === 8 ? 'eight' : 'six'} of the VIN` };
    }
  }

  if (k.claimNumber) {
    const hit = await tqOne<RowDataPacket & { id: number }>(cid,
      'SELECT id FROM repair_orders WHERE claim_number = ? AND closed_at IS NULL AND voided_at IS NULL', [k.claimNumber]);
    if (hit) return { roId: hit.id, confidence: 'likely', how: 'claim number' };
  }

  return { roId: null, confidence: 'none', how: null };
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
    WHERE r.closed_at IS NULL AND r.voided_at IS NULL ${where.length ? 'AND (' + where.join(' OR ') + ')' : ''}
    ORDER BY r.opened_at DESC
    LIMIT 25`, params);
}
