import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { LANES, PARKED, CLOSED, STATUS, laneOf, laneStatuses, meta, syncPipe } from '../lib/pipeline';
import { routeUnowned, laneCfgs } from '../lib/leadops';

export async function registerPipeline(app: FastifyInstance): Promise<void> {

  app.get('/api/pipeline/meta', async () => meta());

  /**
   * Every lead, by lane, oldest first — the 1c columns. Each lane carries its
   * ladder (hours per step) and who its new leads go to. A row's step is how far
   * up the ladder its silence has gone; the clock stops once it is booked, in
   * the shop, lost or parked.
   */
  app.get('/api/pipeline', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewLeads) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;
    await routeUnowned(cid).catch(e => req.log.error(e));
    await syncPipe(cid).catch(e => req.log.error(e));
    const cfgs = await laneCfgs(cid);
    const groups = await tq<RowDataPacket[]>(cid, 'SELECT id, name FROM notify_groups').catch(() => []);
    const staffN = await tq<RowDataPacket[]>(cid, 'SELECT user_id, display_name FROM staff').catch(() => []);
    const rows = await tq<RowDataPacket[]>(cid, `
      SELECT l.id, l.lead_number, TRIM(CONCAT_WS(' ', l.first_name, l.last_name)) AS name, l.phone, l.vehicle_text,
             l.source, l.campaign, l.state, l.pipe_status, l.owner_user_id, s.display_name AS owner_name,
             l.received_at, r.ro_number, l.ro_id, l.estimate_written_at, l.esc_step,
             TIMESTAMPDIFF(MINUTE, l.received_at, NOW()) AS age_min,
             TIMESTAMPDIFF(MINUTE, GREATEST(l.received_at, COALESCE(l.last_followup_at, l.received_at)), NOW()) AS quiet_min,
             (SELECT MIN(a.starts_at) FROM appointments a WHERE a.lead_id = l.id AND a.cancelled_at IS NULL AND a.starts_at >= NOW()) AS next_appt
      FROM leads l
      LEFT JOIN staff s ON s.user_id = l.owner_user_id
      LEFT JOIN repair_orders r ON r.id = l.ro_id
      WHERE l.deleted_at IS NULL
        AND (l.state NOT IN ('won','lost') OR COALESCE(l.settled_at, l.received_at) >= DATE_SUB(NOW(), INTERVAL 30 DAY))
      ORDER BY l.received_at ASC
      LIMIT 2000`);
    const own = !ctx.caps.salesManager && !ctx.caps.admin && ctx.caps.ownWorkOnly;
    const out = rows.filter(r => !own || Number(r.owner_user_id) === ctx.user.id).map(r => {
      const lane = laneOf(r.source), c = cfgs[lane.key];
      let st = r.pipe_status && STATUS[String(r.pipe_status)] ? String(r.pipe_status) : '';
      if (!st) st = r.ro_id ? 'in_shop' : r.state === 'lost' ? 'not_repairing'
        : lane.key === 'walkin' ? (r.estimate_written_at ? 'estimate_written' : 'estimate_written') : lane.statuses[0];
      const stopped = CLOSED.includes(st) || st === 'appointment_set' || r.state === 'won' || r.state === 'lost' || !!r.next_appt;
      const q = Number(r.quiet_min) || 0;
      const ladder = [c.step1_hours, c.step2_hours, c.step3_hours].map(h => Math.round(h * 60));
      const step = stopped ? 0 : q >= ladder[2] ? 3 : q >= ladder[1] ? 2 : q >= ladder[0] ? 1 : 0;
      return { ...r, lane: lane.key, status: st, parked: PARKED.includes(st), closed: CLOSED.includes(st) || r.state === 'won' || r.state === 'lost',
        step, overMin: step ? q - ladder[step - 1] : 0, overdue: step > 0 };
    });
    const routeLabel = (c: typeof cfgs[string]) => c.route_mode === 'writer' ? 'The rep who wrote it'
      : c.route_mode === 'person' ? (staffN.find(s => Number(s.user_id) === Number(c.route_user_id))?.display_name ?? 'One person')
      : c.route_mode === 'group_rr' ? `${groups.find(g => Number(g.id) === Number(c.route_group_id))?.name ?? 'A group'}, round robin`
      : 'Sales managers, round robin';
    return {
      lanes: LANES.map(l => ({ key: l.key, label: l.label, sources: l.sources, statuses: l.statuses,
        off: String(cfgs[l.key].statuses_off ?? '').split(',').filter(Boolean),
        ladderMin: [cfgs[l.key].step1_hours, cfgs[l.key].step2_hours, cfgs[l.key].step3_hours].map(h => Math.round(h * 60)),
        step2Who: cfgs[l.key].step2_group_id ? (groups.find(g => Number(g.id) === Number(cfgs[l.key].step2_group_id))?.name ?? 'A group') : 'Sales managers',
        route: routeLabel(cfgs[l.key]) })),
      staff: staffN.map(s => ({ userId: Number(s.user_id), name: s.display_name })),
      leads: out, me: ctx.user.id
    };
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
