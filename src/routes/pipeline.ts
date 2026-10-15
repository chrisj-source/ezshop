import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { LANES, PARKED, STATUS, laneOf, laneStatuses, meta, syncPipe } from '../lib/pipeline';
import { routeUnowned } from '../lib/leadops';

export async function registerPipeline(app: FastifyInstance): Promise<void> {

  app.get('/api/pipeline/meta', async () => meta());

  /** Every working lead, by lane, oldest first. Won and lost drop off after 30 days. */
  app.get('/api/pipeline', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewLeads) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;
    await routeUnowned(cid).catch(e => req.log.error(e));
    await syncPipe(cid).catch(e => req.log.error(e));
    const rows = await tq<RowDataPacket[]>(cid, `
      SELECT l.id, l.lead_number, TRIM(CONCAT_WS(' ', l.first_name, l.last_name)) AS name, l.phone, l.vehicle_text,
             l.source, l.campaign, l.state, l.pipe_status, l.pipe_status_at, l.owner_user_id, s.display_name AS owner_name,
             l.received_at, r.ro_number, l.ro_id,
             TIMESTAMPDIFF(HOUR, l.received_at, NOW()) AS age_hours,
             TIMESTAMPDIFF(HOUR, GREATEST(l.received_at, COALESCE(l.last_followup_at, l.received_at), COALESCE(l.pipe_status_at, l.received_at)), NOW()) AS quiet_hours
      FROM leads l
      LEFT JOIN staff s ON s.user_id = l.owner_user_id
      LEFT JOIN repair_orders r ON r.id = l.ro_id
      WHERE l.deleted_at IS NULL
        AND (l.state NOT IN ('won','lost') OR COALESCE(l.settled_at, l.received_at) >= DATE_SUB(NOW(), INTERVAL 30 DAY))
      ORDER BY l.received_at ASC
      LIMIT 2000`);
    const own = !ctx.caps.salesManager && !ctx.caps.admin && ctx.caps.ownWorkOnly;
    const out = rows.filter(r => !own || Number(r.owner_user_id) === ctx.user.id).map(r => {
      const lane = laneOf(r.source);
      const st = r.pipe_status && STATUS[String(r.pipe_status)] ? String(r.pipe_status) : lane.statuses[0];
      const calm = ['appointment_set', 'in_shop', 'not_repairing', ...PARKED].includes(st);
      return { ...r, lane: lane.key, status: st, parked: PARKED.includes(st),
        overdue: !calm && r.state !== 'won' && r.state !== 'lost' && Number(r.quiet_hours) >= lane.overdueHours };
    });
    return { lanes: LANES.map(l => ({ key: l.key, label: l.label })), leads: out };
  });

  /** A person moves a lead. Only to a status its lane uses, or a parked one. */
  app.post('/api/leads/:id/pipe', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const to = String((req.body as { status?: string })?.status ?? '');
    const lead = await tqOne<RowDataPacket>(cid, 'SELECT id, source, pipe_status FROM leads WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    const lane = laneOf(lead.source);
    if (!laneStatuses(lane.key).includes(to) && !PARKED.includes(to)) {
      return reply.code(400).send({ error: `${lane.label} leads do not use that status.` });
    }
    if (to === lead.pipe_status) return { ok: true };
    await texec(cid, 'UPDATE leads SET pipe_status = ?, pipe_status_at = NOW() WHERE id = ?', [to, id]);
    await texec(cid, `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, `Moved to ${STATUS[to].label}.`, ctx.user.id, ctx.user.name]);
    return { ok: true };
  });
}
