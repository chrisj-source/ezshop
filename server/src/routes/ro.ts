import { FastifyInstance } from 'fastify';
import { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { texec, tq, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature, Ctx } from '../middleware/context';
import { canMoveTo, scrubMoney } from '../permissions';
import { notify } from '../notify';

export async function registerRepairOrders(app: FastifyInstance): Promise<void> {

  /** One repair order, everything the drawer shows. */
  app.get('/api/ro/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    if (!await mayTouch(ctx, id)) return reply.code(403).send({ error: 'Not your file' });

    const ro = await tqOne<RowDataPacket>(cid, `
      SELECT r.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
             c.kind AS customer_kind,
             ins.name AS insurer_name,
             v.vin, v.year, v.make, v.model, v.color, v.plate, v.plate_state, v.mileage,
             s.label AS status_label, s.customer_label, s.group_id, s.lane_key, s.kind AS status_kind,
             g.label AS group_label
      FROM repair_orders r
      LEFT JOIN clients c   ON c.id = r.client_id
      LEFT JOIN clients ins ON ins.id = r.insurer_client_id
      LEFT JOIN vehicles v  ON v.id = r.vehicle_id
      LEFT JOIN statuses s  ON s.slot_id = r.status_slot
      LEFT JOIN status_groups g ON g.group_id = s.group_id
      WHERE r.id = ?`, [id]);

    if (!ro) return reply.code(404).send({ error: 'No such repair order' });

    const [assigned, notes, history, promises, supplements, sublets, parts, docs] = await Promise.all([
      tq<RowDataPacket[]>(cid, `SELECT position_key, user_id, display_name, assigned_at FROM ro_assignments WHERE ro_id = ?`, [id]),
      tq<RowDataPacket[]>(cid, `SELECT id, kind, body, user_name, created_at FROM ro_notes WHERE ro_id = ? ORDER BY created_at DESC, id DESC`, [id]),
      tq<RowDataPacket[]>(cid, `SELECT id, from_slot, to_slot, from_label, to_label, lane_changed, reason, is_rework, user_name, created_at
                                FROM ro_status_history WHERE ro_id = ? ORDER BY created_at DESC, id DESC`, [id]),
      tq<RowDataPacket[]>(cid, `SELECT id, body, done, created_at FROM ro_promises WHERE ro_id = ? ORDER BY id`, [id]),
      tq<RowDataPacket[]>(cid, `SELECT id, seq, state, block_level, requested_cents, approved_cents, sent_at, decided_at, note
                                FROM supplements WHERE ro_id = ? ORDER BY seq`, [id]),
      tq<RowDataPacket[]>(cid, `SELECT id, service, vendor, state, out_at, back_at, cost_cents, po_number FROM sublets WHERE ro_id = ? ORDER BY id`, [id]),
      tq<RowDataPacket[]>(cid, `SELECT p.id, p.description, p.part_number, p.part_type, p.qty, p.qty_received,
                                       p.price_cents, p.state, p.gating, p.ordered_at, p.eta, p.received_at, p.note,
                                       v.name AS vendor_name
                                FROM parts_lines p LEFT JOIN vendors v ON v.id = p.vendor_id
                                WHERE p.ro_id = ? ORDER BY p.id`, [id]),
      tq<RowDataPacket[]>(cid, `SELECT id, doc_type, label, mime_type, size_bytes, is_money_doc, uploaded_name, created_at
                                FROM documents WHERE ro_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`, [id])
    ]);

    const assignedMap: Record<string, { userId: number | null; name: string | null }> = {};
    for (const a of assigned) {
      assignedMap[a.position_key as string] = { userId: a.user_id as number | null, name: a.display_name as string | null };
    }

    return {
      ro: scrubMoney(ro as Record<string, unknown>, ctx.caps),
      assigned: assignedMap,
      notes,
      history,
      promises,
      supplements: ctx.caps.money ? supplements : supplements.map(s => scrubMoney(s as Record<string, unknown>, ctx.caps)),
      sublets: sublets.map(s => scrubMoney(s as Record<string, unknown>, ctx.caps)),
      parts: parts.map(p => scrubMoney(p as Record<string, unknown>, ctx.caps)),
      documents: ctx.caps.money ? docs : docs.filter(d => d.is_money_doc !== 1)
    };
  });

  /**
   * Move a file, optionally with a note. Both land in the activity log, as
   * separate lines, with who and when — that is what the drawer reads back.
   */
  app.post('/api/ro/:id/status', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const { slot, note, reason } = req.body as { slot?: string; note?: string; reason?: string };

    if (!slot && !note) return reply.code(400).send({ error: 'Nothing to save' });
    if (!await mayTouch(ctx, id)) return reply.code(403).send({ error: 'Not your file' });

    const current = await tqOne<RowDataPacket & { status_slot: string | null; lane: string | null; label: string | null }>(
      cid, `SELECT r.status_slot, s.lane_key AS lane, s.label
            FROM repair_orders r LEFT JOIN statuses s ON s.slot_id = r.status_slot
            WHERE r.id = ?`, [id]
    );
    if (!current) return reply.code(404).send({ error: 'No such repair order' });

    let target: (RowDataPacket & { slot_id: string; label: string; lane_key: string | null; is_terminal: number; owner_role: string }) | null = null;

    if (slot) {
      target = await tqOne(cid,
        `SELECT slot_id, label, lane_key, is_terminal, owner_role FROM statuses WHERE slot_id = ?`, [slot]);
      if (!target) return reply.code(400).send({ error: 'Unknown status' });

      if (!canMoveTo(ctx.role!, ctx.positionKey, target.lane_key)) {
        return reply.code(403).send({ error: 'You cannot move a file into that status.' });
      }
    }

    await withTenantTx(cid, async (c: PoolConnection) => {
      if (target) {
        const laneChanged = (current.lane ?? null) !== (target.lane_key ?? null);

        await c.query(
          `UPDATE repair_orders SET status_slot = ?, status_since = NOW(),
             closed_at = IF(? = 1, NOW(), closed_at)
           WHERE id = ?`,
          [target.slot_id, target.is_terminal, id]
        );

        await c.query(
          `INSERT INTO ro_status_history
             (ro_id, from_slot, to_slot, from_label, to_label, lane_changed, reason, user_id, user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, current.status_slot, target.slot_id, current.label, target.label,
           laneChanged ? 1 : 0, reason ?? null, ctx.user.id, ctx.user.name]
        );

        const lanePart = laneChanged
          ? ` — moved from ${current.lane ?? 'unassigned'} to ${target.lane_key ?? 'unassigned'}.`
          : '.';
        await c.query(
          `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
          [id, `Status changed from “${current.label ?? 'unset'}” to “${target.label}”${lanePart}`,
           ctx.user.id, ctx.user.name]
        );
      }

      if (note && note.trim()) {
        await c.query(
          `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'note', ?, ?, ?)`,
          [id, note.trim(), ctx.user.id, ctx.user.name]
        );
      }
    });

    if (target) {
      const ro = await tqOne<RowDataPacket & { ro_number: string; vehicle: string | null }>(
        cid, `SELECT r.ro_number, CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle
              FROM repair_orders r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = ?`, [id]
      );
      await notify({
        companyId: cid,
        event: 'status.change',
        roId: id,
        ownerRole: target.owner_role,
        title: `${target.label} — RO ${ro?.ro_number ?? id}`,
        body: `${ro?.vehicle || 'A file'} moved from “${current.label ?? 'unset'}” to “${target.label}”.`,
        actorUserId: ctx.user.id,
        dedupeKey: `status:${id}:${target.slot_id}:${Date.now()}`
      }).catch(e => req.log.error(e));
    }

    return { ok: true };
  });

  app.post('/api/ro/:id/notes', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const { body } = req.body as { body?: string };
    if (!body || !body.trim()) return reply.code(400).send({ error: 'Note is empty' });
    if (!await mayTouch(ctx, id)) return reply.code(403).send({ error: 'Not your file' });

    const r = await texec(ctx.company!.id,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'note', ?, ?, ?)`,
      [id, body.trim(), ctx.user.id, ctx.user.name]
    );
    return { ok: true, id: r.insertId };
  });

  app.post('/api/ro', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editRepairOrders) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;

    const b = req.body as {
      roNumber: string; customerName?: string; phone?: string; email?: string;
      vin?: string; year?: number; make?: string; model?: string; color?: string; plate?: string;
      insurerName?: string; claimNumber?: string; dateOfLoss?: string;
      repairPath?: 'pdr' | 'conventional' | 'both' | 'undecided';
      roType?: 'repair' | 'wholesale' | 'warranty';
      amountCents?: number; laborHours?: number; targetDays?: number;
    };

    if (!b.roNumber) return reply.code(400).send({ error: 'RO number is required' });

    const dup = await tqOne<RowDataPacket>(cid, 'SELECT id FROM repair_orders WHERE ro_number = ?', [b.roNumber]);
    if (dup) return reply.code(409).send({ error: `RO ${b.roNumber} already exists.` });

    const id = await withTenantTx(cid, async (c) => {
      let clientId: number | null = null;
      if (b.customerName) {
        const [r] = await c.query<ResultSetHeader>(
          `INSERT INTO clients (kind, name, phone, email) VALUES ('retail', ?, ?, ?)`,
          [b.customerName, b.phone ?? null, b.email ?? null]
        );
        clientId = r.insertId;
      }

      let vehicleId: number | null = null;
      if (b.vin || b.make) {
        const [r] = await c.query<ResultSetHeader>(
          `INSERT INTO vehicles (client_id, vin, year, make, model, color, plate) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [clientId, b.vin ?? null, b.year ?? null, b.make ?? null, b.model ?? null, b.color ?? null, b.plate ?? null]
        );
        vehicleId = r.insertId;
      }

      let insurerId: number | null = null;
      if (b.insurerName) {
        const [rows] = await c.query<RowDataPacket[]>(
          `SELECT id FROM clients WHERE kind = 'insurance' AND name = ?`, [b.insurerName]
        );
        if (rows.length) insurerId = rows[0].id as number;
        else {
          const [r] = await c.query<ResultSetHeader>(
            `INSERT INTO clients (kind, name) VALUES ('insurance', ?)`, [b.insurerName]
          );
          insurerId = r.insertId;
        }
      }

      const [r] = await c.query<ResultSetHeader>(
        `INSERT INTO repair_orders
           (ro_number, client_id, vehicle_id, insurer_client_id, ro_type, repair_path,
            status_slot, status_since, claim_number, date_of_loss,
            amount_cents, labor_hours, target_days, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'intake.arrived', NOW(), ?, ?, ?, ?, ?, ?)`,
        [b.roNumber, clientId, vehicleId, insurerId, b.roType ?? 'repair', b.repairPath ?? 'undecided',
         b.claimNumber ?? null, b.dateOfLoss ?? null,
         b.amountCents ?? 0, b.laborHours ?? 0, b.targetDays ?? null, ctx.user.id]
      );

      await c.query(
        `INSERT INTO ro_status_history (ro_id, from_slot, to_slot, to_label, user_id, user_name)
         VALUES (?, NULL, 'intake.arrived', 'Vehicle Arrived', ?, ?)`,
        [r.insertId, ctx.user.id, ctx.user.name]
      );

      return r.insertId;
    });

    return { ok: true, id };
  });

  app.put('/api/ro/:id/assign/:position', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editAssignments) return reply.code(403).send({ error: 'Not permitted' });
    const id = Number((req.params as { id: string }).id);
    const position = (req.params as { position: string }).position;
    const { userId, displayName } = req.body as { userId: number | null; displayName: string | null };

    await texec(ctx.company!.id,
      `INSERT INTO ro_assignments (ro_id, position_key, user_id, display_name, assigned_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), display_name = VALUES(display_name),
         assigned_at = NOW(), assigned_by = VALUES(assigned_by)`,
      [id, position, userId, displayName, ctx.user.id]
    );

    await texec(ctx.company!.id,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, displayName ? `${position} assigned to ${displayName}.` : `${position} assignment cleared.`,
       ctx.user.id, ctx.user.name]
    );

    if (userId) {
      const ro = await tqOne<RowDataPacket & { ro_number: string; vehicle: string | null }>(
        ctx.company!.id, `SELECT r.ro_number, CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle
                          FROM repair_orders r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = ?`, [id]
      );
      await notify({
        companyId: ctx.company!.id,
        event: 'assign.file',
        roId: id,
        directUserIds: [userId],
        title: `Assigned to you — RO ${ro?.ro_number ?? id}`,
        body: `${ro?.vehicle || 'A file'} is yours as ${position}.`,
        actorUserId: ctx.user.id,
        dedupeKey: `assign:${id}:${position}:${userId}`
      }).catch(e => req.log.error(e));
    }

    return { ok: true };
  });
}

/** A technician may only open a file they are on, when the shop says so. */
async function mayTouch(ctx: Ctx, roId: number): Promise<boolean> {
  if (ctx.caps.seesAllRepairOrders) return true;
  const hit = await tqOne<RowDataPacket>(ctx.company!.id,
    `SELECT 1 AS x FROM ro_assignments WHERE ro_id = ? AND user_id = ?`, [roId, ctx.user.id]);
  return !!hit;
}
