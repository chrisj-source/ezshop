import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec, withTenantTx } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { notify } from '../notify';
import { reconcile } from '../lib/pay';

/**
 * Total loss.
 *
 * The insurer totals the car. It is not a repair any more, but it is still in
 * the shop and still has to be handled, so it does not leave the board — it goes
 * to the top of it.
 *
 * This is a flag on the file, not a status. The board synthesises the `00` lane
 * above Body from the flag, which means a shop reconfiguring its status board
 * cannot break it, the file keeps whatever slot it was in, and — the point of it
 * — the assignments stay exactly where they were. The car simply stops appearing
 * in a technician's own list. Nobody is unassigned; the work is just not theirs
 * any more.
 *
 * On the pay side a totalled car earns the shop's total-loss amount and no
 * commission at all. `lib/pay` handles that; marking the flag only has to
 * settle the ledger behind it.
 */
export async function registerTotalLoss(app: FastifyInstance): Promise<void> {

  app.post('/api/ro/:id/total-loss', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.markTotalLoss) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const note = String((req.body as { note?: string }).note ?? '').trim().slice(0, 255);

    const ro = await tqOne<RowDataPacket & {
      ro_number: string; total_loss_at: Date | null; voided_at: Date | null;
      close_date: string | null; vehicle: string | null;
    }>(cid, `
      SELECT r.ro_number, r.total_loss_at, r.voided_at, r.close_date,
             CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle
      FROM repair_orders r LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.id = ?`, [id]);

    if (!ro) return reply.code(404).send({ error: 'No such repair order' });
    if (ro.voided_at) return reply.code(400).send({ error: 'That file is voided.' });
    if (ro.total_loss_at) return reply.code(400).send({ error: 'That file is already a total loss.' });

    /* Parts on order are the shop's problem the moment a car totals, so say so
       rather than silently leaving them. */
    const parts = await tqOne<RowDataPacket & { on_order: number }>(cid,
      `SELECT COUNT(*) AS on_order FROM parts_lines
       WHERE ro_id = ? AND state IN ('ordered','partial')`, [id]);

    await withTenantTx(cid, async (c) => {
      await c.query(
        `UPDATE repair_orders SET total_loss_at = NOW(), total_loss_by = ?, total_loss_note = ?
         WHERE id = ?`, [ctx.user.id, note || null, id]);

      await c.query(
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [id, `Marked a total loss${note ? ` — ${note}` : ''}. Off the technicians’ lists; assignments left as they are.`,
         ctx.user.id, ctx.user.name]);

      await c.query(
        `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
         VALUES (?, ?, 'repair_order', ?, 'total_loss', ?)`,
        [ctx.user.id, ctx.user.name, id, JSON.stringify({ roNumber: ro.ro_number, note })]);
    });

    /* No commission on a totalled car — the ledger rewrites itself around the
       total-loss amount, and anything already paid comes back as an adjustment. */
    await reconcile(cid, id, `total loss marked by ${ctx.user.name}`).catch(() => undefined);

    await notify({
      companyId: cid,
      event: 'status.change',
      roId: id,
      title: `Total loss — RO ${ro.ro_number}`,
      body: `${ro.vehicle || 'A file'} was marked a total loss by ${ctx.user.name}.` +
        (Number(parts?.on_order ?? 0) ? ` ${parts!.on_order} part lines are still on order.` : ''),
      actorUserId: ctx.user.id,
      dedupeKey: `tl:${id}`
    }).catch(() => undefined);

    return {
      ok: true,
      partsOnOrder: Number(parts?.on_order ?? 0),
      note: 'The file is at the head of the board and out of the technicians’ lists. Assignments are untouched.'
    };
  });

  /** Wrongly marked, or the insurer changed their mind. */
  app.delete('/api/ro/:id/total-loss', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.markTotalLoss) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const ro = await tqOne<RowDataPacket & { ro_number: string; total_loss_at: Date | null }>(cid,
      'SELECT ro_number, total_loss_at FROM repair_orders WHERE id = ?', [id]);
    if (!ro) return reply.code(404).send({ error: 'No such repair order' });
    if (!ro.total_loss_at) return reply.code(400).send({ error: 'That file is not a total loss.' });

    await withTenantTx(cid, async (c) => {
      await c.query(
        `UPDATE repair_orders SET total_loss_at = NULL, total_loss_by = NULL, total_loss_note = NULL
         WHERE id = ?`, [id]);
      await c.query(
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [id, 'Total loss lifted. Back on the board in its own lane, and back on the technicians’ lists.',
         ctx.user.id, ctx.user.name]);
      await c.query(
        `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
         VALUES (?, ?, 'repair_order', ?, 'total_loss_undo', ?)`,
        [ctx.user.id, ctx.user.name, id, JSON.stringify({ roNumber: ro.ro_number })]);
    });

    await reconcile(cid, id, `total loss lifted by ${ctx.user.name}`).catch(() => undefined);
    return { ok: true };
  });

  /** The head of the board: what is totalled and how long it has sat. */
  app.get('/api/total-losses', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT r.id, r.ro_number, r.total_loss_at, r.total_loss_note, r.status_slot,
             s.label AS status_label,
             DATEDIFF(NOW(), r.total_loss_at) AS days_totalled,
             c.name AS client_name,
             CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle, v.color,
             (SELECT COUNT(*) FROM parts_lines p
               WHERE p.ro_id = r.id AND p.state IN ('ordered','partial')) AS parts_on_order
      FROM repair_orders r
      LEFT JOIN statuses s ON s.slot_id = r.status_slot
      LEFT JOIN clients c ON c.id = r.client_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.total_loss_at IS NOT NULL AND r.voided_at IS NULL AND r.close_date IS NULL
      ORDER BY r.total_loss_at`);

    return { files: rows, lane: { key: 'total_loss', label: 'Total loss', number: '00' } };
  });
}
