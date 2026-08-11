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

    const [assigned, notes, history, promises, supplements, sublets, parts, docs, voids] = await Promise.all([
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
                                FROM documents WHERE ro_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`, [id]),
      tq<RowDataPacket[]>(cid, `SELECT id, ro_number, reason, note, status_slot, parts_cancelled, parts_flagged,
                                       voided_at, voided_by_name, reopened_at, reopened_by_name, reopened_number
                                FROM ro_voids WHERE ro_id = ? ORDER BY id DESC`, [id])
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
      documents: ctx.caps.money ? docs : docs.filter(d => d.is_money_doc !== 1),
      voids,
      canVoid: ctx.caps.voidRepairOrders
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

  /**
   * Correct the dates on a file. These are entered after the fact — a car
   * that arrived Friday and got written up Monday, a delivery logged late —
   * so they are editable rather than derived from the status history.
   */
  /** Money and promise fields the counter corrects on the file. */
  /** Promises: what someone told the customer, and whether it was kept. */
  app.post('/api/ro/:id/promises', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const { body } = req.body as { body?: string };
    if (!body?.trim()) return reply.code(400).send({ error: 'Write what was promised.' });

    const res = await texec(ctx.company!.id,
      'INSERT INTO ro_promises (ro_id, body, created_by) VALUES (?, ?, ?)',
      [id, body.trim().slice(0, 255), ctx.user.id]);

    await texec(ctx.company!.id,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, `Promised: ${body.trim()}`, ctx.user.id, ctx.user.name]);

    return { ok: true, id: res.insertId };
  });

  app.patch('/api/promises/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const { done, body } = req.body as { done?: boolean; body?: string };
    const cid = ctx.company!.id;

    const before = await tqOne<RowDataPacket & { ro_id: number; body: string; done: number }>(
      cid, 'SELECT ro_id, body, done FROM ro_promises WHERE id = ?', [id]);
    if (!before) return reply.code(404).send({ error: 'No such promise' });

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (done !== undefined) { sets.push('done = ?'); vals.push(done ? 1 : 0); }
    if (body !== undefined) { sets.push('body = ?'); vals.push(body.slice(0, 255)); }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await texec(cid, `UPDATE ro_promises SET ${sets.join(', ')} WHERE id = ?`, vals);

    if (done !== undefined && (before.done === 1) !== done) {
      await texec(cid,
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [before.ro_id, `Promise ${done ? 'kept' : 'reopened'}: ${before.body}`,
         ctx.user.id, ctx.user.name]);
    }

    return { ok: true };
  });

  app.delete('/api/promises/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    await texec(ctx.company!.id, 'DELETE FROM ro_promises WHERE id = ?',
      [Number((req.params as { id: string }).id)]);
    return { ok: true };
  });

  app.patch('/api/ro/:id/money', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.money) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const b = req.body as { amountCents?: number; deductibleCents?: number; laborHours?: number };

    const sets: string[] = [];
    const vals: unknown[] = [];
    const notes: string[] = [];
    const dollars = (c: number) => '$' + (c / 100).toLocaleString('en-US');

    if (b.amountCents !== undefined) {
      sets.push('amount_cents = ?'); vals.push(Math.max(0, Math.round(b.amountCents)));
      notes.push('Amount set to ' + dollars(Math.max(0, Math.round(b.amountCents))));
    }
    if (b.deductibleCents !== undefined) {
      sets.push('deductible_cents = ?'); vals.push(Math.max(0, Math.round(b.deductibleCents)));
      notes.push('Deductible set to ' + dollars(Math.max(0, Math.round(b.deductibleCents))));
    }
    if (b.laborHours !== undefined) {
      sets.push('labor_hours = ?'); vals.push(Math.max(0, Number(b.laborHours)));
      notes.push('Labour hours set to ' + Number(b.laborHours));
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await texec(ctx.company!.id, `UPDATE repair_orders SET ${sets.join(', ')} WHERE id = ?`, vals);
    await texec(ctx.company!.id,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, notes.join('. ') + '.', ctx.user.id, ctx.user.name]
    );
    return { ok: true };
  });

  app.patch('/api/ro/:id/dates', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as Record<string, string | null>;

    const map: Record<string, { col: string; label: string; time: boolean }> = {
      openedAt:    { col: 'opened_at',    label: 'Date in',        time: true },
      approvedAt:  { col: 'approved_at',  label: 'Date approved',  time: true },
      deliveredAt: { col: 'delivered_at', label: 'Date completed', time: true },
      closedAt:    { col: 'closed_at',    label: 'Date picked up', time: true },
      promisedAt:  { col: 'promised_at',  label: 'Promised',       time: false },
      dateOfLoss:  { col: 'date_of_loss', label: 'Date of loss',   time: false }
    };

    const before = await tqOne<RowDataPacket>(cid,
      `SELECT opened_at, approved_at, delivered_at, closed_at, promised_at, date_of_loss
       FROM repair_orders WHERE id = ?`, [id]);
    if (!before) return reply.code(404).send({ error: 'No such repair order' });

    const sets: string[] = [];
    const vals: unknown[] = [];
    const changes: string[] = [];

    for (const [key, def] of Object.entries(map)) {
      if (b[key] === undefined) continue;
      const raw = b[key];

      if (raw === null || raw === '') {
        if (def.col === 'opened_at') {
          return reply.code(400).send({ error: 'Date in cannot be emptied.' });
        }
        sets.push(`${def.col} = NULL`);
        vals.push();
        changes.push(`${def.label} cleared`);
        continue;
      }

      // Accept "2026-08-06" or "2026-08-06T14:30" from either input type.
      const d = new Date(def.time && raw.length === 10 ? raw + 'T12:00' : raw);
      if (isNaN(d.getTime())) {
        return reply.code(400).send({ error: `${def.label} is not a valid date.` });
      }

      sets.push(`${def.col} = ?`);
      vals.push(def.time ? d : raw.slice(0, 10));
      changes.push(`${def.label} set to ${d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      })}`);
    }

    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    // A picked-up date means the file is delivered; sanity-check the order.
    const opened = b.openedAt ? new Date(b.openedAt) : new Date(before.opened_at as string);
    for (const later of ['deliveredAt', 'closedAt'] as const) {
      if (b[later]) {
        const d = new Date(b[later] as string);
        if (d < opened) {
          return reply.code(400).send({
            error: `${map[later].label} cannot be before the date in.`
          });
        }
      }
    }

    vals.push(id);
    await texec(cid, `UPDATE repair_orders SET ${sets.join(', ')} WHERE id = ?`, vals);

    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, changes.join('. ') + '.', ctx.user.id, ctx.user.name]
    );

    return { ok: true };
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

  /**
   * Void a file. Not a status and not a hold: the file keeps the slot it was in
   * and the flag takes it off the board. Parts still needed are cancelled;
   * anything already ordered is flagged for return and the desk hears about it.
   * The number is released so it can be reused straight away.
   */
  app.post('/api/ro/:id/void', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.voidRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as { reason?: string; note?: string };
    const reason = (b.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'A reason is required to void a file.' });

    const result = await withTenantTx(cid, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT r.id, r.ro_number, r.status_slot, r.amount_cents, r.voided_at, r.closed_at,
                s.label AS status_label
         FROM repair_orders r LEFT JOIN statuses s ON s.slot_id = r.status_slot
         WHERE r.id = ? FOR UPDATE`, [id]);
      const ro = rows[0];
      if (!ro) return { error: 'No such repair order', code: 404 };
      if (ro.voided_at) return { error: 'That file is already voided.', code: 409 };

      // Parts still on paper go away; parts already bought have to come back.
      const [cancelled] = await c.query<ResultSetHeader>(
        `UPDATE parts_lines SET state = 'not_needed', gating = 0
         WHERE ro_id = ? AND state = 'need'`, [id]);
      const [flagged] = await c.query<ResultSetHeader>(
        `UPDATE parts_lines SET return_flagged_at = NOW(), return_cleared_at = NULL, gating = 0
         WHERE ro_id = ? AND state IN ('ordered','partial','received','backordered')
           AND return_flagged_at IS NULL`, [id]);

      const [v] = await c.query<ResultSetHeader>(
        `INSERT INTO ro_voids
           (ro_id, ro_number, reason, note, status_slot, amount_cents,
            parts_cancelled, parts_flagged, voided_by, voided_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ro.ro_number, reason.slice(0, 48), (b.note ?? '').trim().slice(0, 255) || null,
         ro.status_slot, ro.amount_cents ?? 0, cancelled.affectedRows, flagged.affectedRows,
         ctx.user.id, ctx.user.name]);

      // The number goes back in the pool. uq_ro_number still has to hold, so the
      // row parks on a placeholder until a reopen gives it a real one.
      await c.query(
        `UPDATE repair_orders
         SET voided_at = NOW(), ro_number = ?,
             on_hold = 0, hold_reason = NULL, hold_owner = NULL, hold_since = NULL
         WHERE id = ?`,
        [`VOID-${id}`, id]);

      if (ro.status_slot) {
        await c.query(
          `INSERT INTO ro_status_history
             (ro_id, from_slot, to_slot, from_label, to_label, reason, user_id, user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, ro.status_slot, ro.status_slot, ro.status_label, ro.status_label,
           `Voided — ${reason}`, ctx.user.id, ctx.user.name]);
      }

      await c.query(
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [id, `RO ${ro.ro_number} voided — ${reason}.` +
             (flagged.affectedRows ? ` ${flagged.affectedRows} ordered part line${flagged.affectedRows === 1 ? '' : 's'} flagged for return.` : '') +
             (cancelled.affectedRows ? ` ${cancelled.affectedRows} line${cancelled.affectedRows === 1 ? '' : 's'} cancelled.` : '') +
             ` The number is free to reuse.`,
         ctx.user.id, ctx.user.name]);

      await c.query(
        `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
         VALUES (?, ?, 'repair_order', ?, 'void', ?)`,
        [ctx.user.id, ctx.user.name, id, JSON.stringify({
          roNumber: ro.ro_number, reason, note: b.note ?? null,
          statusSlot: ro.status_slot, voidId: v.insertId,
          partsCancelled: cancelled.affectedRows, partsFlagged: flagged.affectedRows
        })]);

      return {
        voidId: v.insertId, roNumber: ro.ro_number as string,
        partsCancelled: cancelled.affectedRows, partsFlagged: flagged.affectedRows
      };
    });

    if ('error' in result) return reply.code(result.code ?? 400).send({ error: result.error });

    // The void itself goes unannounced — it is in the log. The returns are not:
    // somebody has to send those parts back.
    if (result.partsFlagged) {
      await notify({
        companyId: cid,
        event: 'parts.return',
        roId: id,
        title: `Returns to make — RO ${result.roNumber} voided`,
        body: `${result.partsFlagged} ordered part line${result.partsFlagged === 1 ? '' : 's'} to send back. They stay on the returns list until cleared.`,
        actorUserId: ctx.user.id,
        dedupeKey: `void-return:${result.voidId}`
      }).catch(e => req.log.error(e));
    }

    return { ok: true, ...result };
  });

  /**
   * Bring a voided file back. Same record, renumbered — its old number may
   * already be in use. Everything it carried comes with it; whoever reopens
   * picks the slot and says whether the cancelled parts come back.
   */
  app.post('/api/ro/:id/reopen', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.voidRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as { slot?: string; roNumber?: string; restoreParts?: boolean };
    if (!b.slot) return reply.code(400).send({ error: 'Pick the status it comes back into.' });

    const slot = await tqOne<RowDataPacket & { label: string }>(cid,
      'SELECT slot_id, label FROM statuses WHERE slot_id = ?', [b.slot]);
    if (!slot) return reply.code(400).send({ error: 'No such status.' });

    const result = await withTenantTx(cid, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT id, ro_number, voided_at, voided_days FROM repair_orders WHERE id = ? FOR UPDATE`, [id]);
      const ro = rows[0];
      if (!ro) return { error: 'No such repair order', code: 404 };
      if (!ro.voided_at) return { error: 'That file is not voided.', code: 409 };

      const [vrows] = await c.query<RowDataPacket[]>(
        `SELECT id, ro_number FROM ro_voids WHERE ro_id = ? AND reopened_at IS NULL
         ORDER BY id DESC LIMIT 1`, [id]);
      const voidRow = vrows[0];

      let roNumber = (b.roNumber ?? '').trim();
      if (roNumber) {
        const [dup] = await c.query<RowDataPacket[]>(
          'SELECT id FROM repair_orders WHERE ro_number = ? AND id <> ?', [roNumber, id]);
        if (dup.length) return { error: `RO ${roNumber} is already taken.`, code: 409 };
      } else {
        // Next in the shop's own sequence. Shops that number off the VIN have no
        // sequence to follow, so they are asked to type one.
        const [seq] = await c.query<RowDataPacket[]>(
          `SELECT MAX(CAST(ro_number AS UNSIGNED)) AS top FROM repair_orders
           WHERE ro_number REGEXP '^[0-9]+$'`);
        const top = Number(seq[0]?.top ?? 0);
        if (!top) {
          return {
            error: 'This shop does not number in sequence — type the number it should come back as.',
            code: 400
          };
        }
        roNumber = String(top + 1);
      }

      // The clock was stopped while it sat voided, so those days come off the
      // days in shop rather than the original date in being rewritten.
      await c.query(
        `UPDATE repair_orders
         SET ro_number = ?, voided_at = NULL, reopen_count = reopen_count + 1,
             voided_days = voided_days + GREATEST(DATEDIFF(NOW(), voided_at), 0),
             status_slot = ?, status_since = NOW()
         WHERE id = ?`, [roNumber, b.slot, id]);

      if (voidRow) {
        await c.query(
          `UPDATE ro_voids SET reopened_at = NOW(), reopened_by = ?, reopened_by_name = ?,
                               reopened_number = ? WHERE id = ?`,
          [ctx.user.id, ctx.user.name, roNumber, voidRow.id]);
      }

      let restored = 0;
      if (b.restoreParts) {
        const [r] = await c.query<ResultSetHeader>(
          `UPDATE parts_lines SET state = 'need', gating = 1
           WHERE ro_id = ? AND state = 'not_needed'`, [id]);
        restored = r.affectedRows;
      }

      await c.query(
        `INSERT INTO ro_status_history
           (ro_id, from_slot, to_slot, to_label, reason, user_id, user_name)
         VALUES (?, NULL, ?, ?, ?, ?, ?)`,
        [id, b.slot, slot.label,
         `Reopened from void as RO ${roNumber}`, ctx.user.id, ctx.user.name]);

      await c.query(
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [id, `Reopened as RO ${roNumber}, was ${voidRow?.ro_number ?? ro.ro_number}. ` +
             `Back in ${slot.label}.` +
             (restored ? ` ${restored} cancelled part line${restored === 1 ? '' : 's'} restored.` : ' Parts not restored.'),
         ctx.user.id, ctx.user.name]);

      await c.query(
        `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
         VALUES (?, ?, 'repair_order', ?, 'reopen', ?)`,
        [ctx.user.id, ctx.user.name, id, JSON.stringify({
          roNumber, wasRoNumber: voidRow?.ro_number ?? null, slot: b.slot, partsRestored: restored
        })]);

      return { roNumber, slot: b.slot, partsRestored: restored };
    });

    if ('error' in result) return reply.code(result.code ?? 400).send({ error: result.error });
    return { ok: true, ...result };
  });
}

/** A technician may only open a file they are on, when the shop says so. */
async function mayTouch(ctx: Ctx, roId: number): Promise<boolean> {
  if (ctx.caps.seesAllRepairOrders) return true;
  const hit = await tqOne<RowDataPacket>(ctx.company!.id,
    `SELECT 1 AS x FROM ro_assignments WHERE ro_id = ? AND user_id = ?`, [roId, ctx.user.id]);
  return !!hit;
}
