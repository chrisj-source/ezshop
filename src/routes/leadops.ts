import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { audit } from '../lib/audit';
import { actorFrom } from './audit';
import { notify } from '../notify';
import { LANES, ALWAYS, laneOf, STATUS, PARKED } from '../lib/pipeline';
import { groupMembers, laneCfgs, touched, usersWithCap } from '../lib/leadops';
import { referralFor } from '../lib/referrals';

const ROUTE_MODES = ['managers_rr', 'group_rr', 'person', 'writer'];

export async function registerLeadOps(app: FastifyInstance): Promise<void> {

  /* ------------------------------------------------ the customer record (2b / 3a / 3b)

     Won or lost, the lead becomes the customer record and is kept. Opened from a
     lead (?lead=) or from a file on the board (?ro=). How they came in, the
     referral, every file, and one timeline: lead events plus status moves on
     their files. File notes are not in it — internal notes have their own gate
     and the record does not re-implement it. */
  app.get('/api/customer-record', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const q = req.query as { lead?: string; ro?: string };
    if (!ctx.caps.viewLeads && !ctx.caps.seesRepairOrders) return reply.code(403).send({ error: 'Not permitted' });
    let ro: RowDataPacket | null = null, lead: RowDataPacket | null = null;
    if (q.ro) {
      ro = await tqOne<RowDataPacket>(cid, `SELECT r.id, r.ro_number, r.client_id, r.opened_at, c.name AS customer, c.phone, c.email
        FROM repair_orders r LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ?`, [Number(q.ro)]);
      if (!ro) return reply.code(404).send({ error: 'No such file' });
      lead = await tqOne<RowDataPacket>(cid, 'SELECT * FROM leads WHERE ro_id = ? AND deleted_at IS NULL', [ro.id]);
    } else if (q.lead) {
      lead = await tqOne<RowDataPacket>(cid, 'SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [Number(q.lead)]);
      if (!lead) return reply.code(404).send({ error: 'No such lead' });
      if (lead.ro_id) ro = await tqOne<RowDataPacket>(cid, `SELECT r.id, r.ro_number, r.client_id, r.opened_at, c.name AS customer, c.phone, c.email
        FROM repair_orders r LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ?`, [lead.ro_id]);
    } else return reply.code(400).send({ error: 'Which record?' });
    if (lead && !ctx.caps.viewLeads) lead = null;

    const owner = lead?.owner_user_id ? await tqOne<RowDataPacket>(cid, 'SELECT display_name FROM staff WHERE user_id = ?', [lead.owner_user_id]) : null;
    const lane = lead ? laneOf(lead.source) : null;
    const cfg = lane ? (await laneCfgs(cid))[lane.key] : null;
    const off = String(cfg?.statuses_off ?? '').split(',');
    const files = ro?.client_id && ctx.caps.seesRepairOrders ? await tq<RowDataPacket[]>(cid, `
      SELECT r.id, r.ro_number, r.opened_at, r.closed_at, s.label AS status_label, CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle
      FROM repair_orders r LEFT JOIN statuses s ON s.slot_id = r.status_slot LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.client_id = ? ORDER BY r.opened_at DESC LIMIT 40`, [ro.client_id]) : [];
    const leadEvents = lead ? await tq<RowDataPacket[]>(cid,
      'SELECT kind, body, user_name, created_at FROM lead_events WHERE lead_id = ? ORDER BY created_at DESC LIMIT 300', [lead.id]) : [];
    const moves = files.length ? await tq<RowDataPacket[]>(cid, `
      SELECT h.ro_id, h.created_at, h.user_name, s.label, r.ro_number FROM ro_status_history h
      JOIN repair_orders r ON r.id = h.ro_id LEFT JOIN statuses s ON s.slot_id = h.to_slot
      WHERE h.ro_id IN (?) ORDER BY h.created_at DESC LIMIT 300`, [files.map(f => f.id)]).catch(() => []) : [];
    const appts = lead ? await tq<RowDataPacket[]>(cid, `SELECT a.starts_at, a.kind, a.cancelled_at, s.display_name AS assigned
      FROM appointments a LEFT JOIN staff s ON s.user_id = a.assigned_user_id WHERE a.lead_id = ? ORDER BY a.starts_at DESC`, [lead.id]) : [];
    const timeline = [
      ...leadEvents.map(e => ({ src: 'lead', at: e.created_at, text: e.body, who: e.user_name })),
      ...moves.map(m => ({ src: 'files', at: m.created_at, text: `RO ${m.ro_number} → ${m.label ?? 'status changed'}`, who: m.user_name, roId: m.ro_id }))
    ].sort((a, b) => new Date(String(b.at)).getTime() - new Date(String(a.at)).getTime());

    return {
      name: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || ro?.customer : ro?.customer,
      phone: lead?.phone ?? ro?.phone, email: lead?.email ?? ro?.email,
      lead: lead ? {
        id: lead.id, number: lead.lead_number, source: lead.source, campaign: lead.campaign, state: lead.state, lostReason: lead.lost_reason,
        lane: lane?.label, laneKey: lane?.key, owner: owner?.display_name ?? null, receivedAt: lead.received_at, vehicle: lead.vehicle_text,
        estimateCents: ctx.caps.money ? lead.estimate_cents : null, escStep: Number(lead.esc_step) || 0,
        status: lead.pipe_status || lane?.statuses[0], path: lane ? [...lane.statuses.filter(k => !off.includes(k)), ...ALWAYS].map(k => STATUS[k]) : [],
        leadToRoHours: ro && lead.received_at ? Math.round((new Date(ro.opened_at).getTime() - new Date(lead.received_at).getTime()) / 3600e3) : null,
        ladder: cfg ? [cfg.step1_hours, cfg.step2_hours, cfg.step3_hours] : null
      } : null,
      startsAtCheckIn: !lead,
      ro: ro ? { id: ro.id, number: ro.ro_number } : null,
      referral: lead ? await referralFor(cid, 'lead', Number(lead.id), ctx.caps).catch(() => null) : null,
      appointments: appts, files, timeline
    };
  });

  /* ------------------------------------------------ Admin › Leads: sources */

  app.get('/api/admin/lead-lanes', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id;
    const cfgs = await laneCfgs(cid);
    const groups = await tq<RowDataPacket[]>(cid, 'SELECT id, name, system_key FROM notify_groups ORDER BY system_key IS NULL, name');
    const staff = await tq<RowDataPacket[]>(cid, 'SELECT user_id, display_name FROM staff ORDER BY display_name').catch(() => []);
    return {
      lanes: LANES.map(l => ({ key: l.key, label: l.label, statuses: l.statuses.map(k => STATUS[k]), always: ALWAYS.map(k => STATUS[k]), cfg: cfgs[l.key] })),
      groups, staff, managers: await usersWithCap(cid, 'salesManager')
    };
  });

  app.put('/api/admin/lead-lanes/:key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id, key = (req.params as { key: string }).key;
    const lane = LANES.find(l => l.key === key);
    if (!lane) return reply.code(404).send({ error: 'No such source' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const mode = key === 'field' ? 'writer' : String(b.routeMode ?? 'managers_rr');
    if (!ROUTE_MODES.includes(mode) || (key !== 'field' && mode === 'writer')) return reply.code(400).send({ error: 'Pick who a new lead goes to.' });
    if (mode === 'group_rr' && !b.routeGroupId) return reply.code(400).send({ error: 'Pick the group.' });
    if (mode === 'person' && !b.routeUserId) return reply.code(400).send({ error: 'Pick the person.' });
    const h1 = Math.round(Number(b.step1Hours)), h2 = Math.round(Number(b.step2Hours)), h3 = Math.round(Number(b.step3Hours));
    if (!(h1 > 0 && h2 > h1 && h3 > h2)) return reply.code(400).send({ error: 'Ladder steps must increase: step 1 < step 2 < step 3 hours.' });
    const off = (Array.isArray(b.statusesOff) ? b.statusesOff : []).map(String).filter(k => lane.statuses.includes(k));
    if (off.length >= lane.statuses.length) return reply.code(400).send({ error: 'Leave at least one status on in the lane.' });
    await texec(cid, `
      INSERT INTO lead_lanes (lane_key, route_mode, route_group_id, route_user_id, step1_hours, step2_hours, step2_group_id, step3_hours, chase_quote_days, statuses_off)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE route_mode = VALUES(route_mode), route_group_id = VALUES(route_group_id), route_user_id = VALUES(route_user_id),
        step1_hours = VALUES(step1_hours), step2_hours = VALUES(step2_hours), step2_group_id = VALUES(step2_group_id),
        step3_hours = VALUES(step3_hours), chase_quote_days = VALUES(chase_quote_days), statuses_off = VALUES(statuses_off)`,
      [key, mode, mode === 'group_rr' ? Number(b.routeGroupId) : null, mode === 'person' ? Number(b.routeUserId) : null,
       h1, h2, b.step2GroupId ? Number(b.step2GroupId) : null, h3, Math.max(1, Math.round(Number(b.chaseQuoteDays) || 3)), off.join(',') || null]);
    await audit(cid, actorFrom(req), { entity: 'settings', action: 'lead_lane', area: 'Setup', label: `Lead source settings — ${lane.label}`,
      changes: [{ field: 'Route', from: null, to: mode }, { field: 'Ladder', from: null, to: `${h1}/${h2}/${h3}h` }] });
    return { ok: true };
  });

  /* ------------------------------------------------ notification groups */

  app.get('/api/admin/notify-groups', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id;
    const groups = await tq<RowDataPacket[]>(cid, 'SELECT id, name, system_key FROM notify_groups ORDER BY system_key IS NULL, name');
    const out = [];
    for (const g of groups) out.push({ ...g, members: await groupMembers(cid, Number(g.id)) });
    return { groups: out };
  });

  app.post('/api/admin/notify-groups', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const name = String((req.body as { name?: string })?.name ?? '').trim().slice(0, 80);
    if (!name) return reply.code(400).send({ error: 'Name the group.' });
    const r = await texec(ctx.company!.id, 'INSERT INTO notify_groups (name) VALUES (?)', [name]);
    return { ok: true, id: r.insertId };
  });

  app.put('/api/admin/notify-groups/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const g = await tqOne<RowDataPacket>(cid, 'SELECT system_key FROM notify_groups WHERE id = ?', [id]);
    if (!g) return reply.code(404).send({ error: 'No such group' });
    if (g.system_key) return reply.code(400).send({ error: 'Sales managers follows the Sales manager permission. Change it in Roles.' });
    const b = (req.body ?? {}) as { name?: string; members?: number[] };
    if (b.name !== undefined) await texec(cid, 'UPDATE notify_groups SET name = ? WHERE id = ?', [String(b.name).trim().slice(0, 80) || 'Group', id]);
    if (Array.isArray(b.members)) {
      await texec(cid, 'DELETE FROM notify_group_members WHERE group_id = ?', [id]);
      for (const u of [...new Set(b.members.map(Number).filter(Boolean))]) {
        await texec(cid, 'INSERT IGNORE INTO notify_group_members (group_id, user_id) VALUES (?, ?)', [id, u]);
      }
    }
    return { ok: true };
  });

  app.delete('/api/admin/notify-groups/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const g = await tqOne<RowDataPacket>(cid, 'SELECT system_key FROM notify_groups WHERE id = ?', [id]);
    if (!g) return reply.code(404).send({ error: 'No such group' });
    if (g.system_key) return reply.code(400).send({ error: 'Sales managers cannot be deleted.' });
    const used = await tqOne<RowDataPacket>(cid, 'SELECT lane_key FROM lead_lanes WHERE route_group_id = ? OR step2_group_id = ? LIMIT 1', [id, id]);
    if (used) return reply.code(409).send({ error: `Still used by the ${LANES.find(l => l.key === used.lane_key)?.label ?? used.lane_key} source. Change that first.` });
    await texec(cid, 'DELETE FROM notify_group_members WHERE group_id = ?', [id]);
    await texec(cid, 'DELETE FROM notify_groups WHERE id = ?', [id]);
    return { ok: true };
  });

  /* ------------------------------------------------ teams */

  app.get('/api/teams', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const teams = await tq<RowDataPacket[]>(cid, `SELECT t.id, t.name, t.manager_user_id, s.display_name AS manager_name
      FROM teams t LEFT JOIN staff s ON s.user_id = t.manager_user_id ORDER BY t.name`);
    const members = await tq<RowDataPacket[]>(cid, 'SELECT user_id, team_id FROM team_members');
    return { teams: teams.map(t => ({ ...t, members: members.filter(m => Number(m.team_id) === Number(t.id)).map(m => Number(m.user_id)) })) };
  });

  app.post('/api/admin/teams', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const b = (req.body ?? {}) as { name?: string; managerUserId?: number | null };
    const name = String(b.name ?? '').trim().slice(0, 80);
    if (!name) return reply.code(400).send({ error: 'Name the team.' });
    const r = await texec(ctx.company!.id, 'INSERT INTO teams (name, manager_user_id) VALUES (?, ?)', [name, b.managerUserId || null]);
    return { ok: true, id: r.insertId };
  });

  app.put('/api/admin/teams/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { name?: string; managerUserId?: number | null; members?: number[] };
    if (b.name !== undefined) await texec(cid, 'UPDATE teams SET name = ? WHERE id = ?', [String(b.name).trim().slice(0, 80) || 'Team', id]);
    if (b.managerUserId !== undefined) await texec(cid, 'UPDATE teams SET manager_user_id = ? WHERE id = ?', [b.managerUserId || null, id]);
    if (Array.isArray(b.members)) {
      await texec(cid, 'DELETE FROM team_members WHERE team_id = ?', [id]);
      /* A person is in one team: joining this one takes them out of any other. */
      for (const u of [...new Set(b.members.map(Number).filter(Boolean))]) {
        await texec(cid, 'INSERT INTO team_members (user_id, team_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)', [u, id]);
      }
    }
    return { ok: true };
  });

  app.delete('/api/admin/teams/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    await texec(cid, 'DELETE FROM team_members WHERE team_id = ?', [id]);
    await texec(cid, 'DELETE FROM teams WHERE id = ?', [id]);
    return { ok: true };
  });

  /* ------------------------------------------------ tasks (5a) */

  /**
   * Tasks are made by the system from the leads: Hand out, First call, Chase
   * quote, Confirm appt, Reschedule. The one a person makes is Callback, and
   * only as part of logging a touch. A rep sees his own; a sales manager her
   * own plus every lead at step 2 or 3; the owner sees everything.
   */
  app.get('/api/tasks', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewLeads) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;
    const cfgs = await laneCfgs(cid);
    const leads = await tq<RowDataPacket[]>(cid, `
      SELECT l.id, l.lead_number, TRIM(CONCAT_WS(' ', l.first_name, l.last_name)) AS name, l.vehicle_text, l.source,
             l.owner_user_id, l.state, l.pipe_status, l.pipe_status_at, l.first_reply_at, l.received_at, l.esc_step,
             l.estimate_written_at, COALESCE(l.last_followup_at, l.received_at) AS last_touch,
             (SELECT MIN(a.starts_at) FROM appointments a WHERE a.lead_id = l.id AND a.cancelled_at IS NULL AND a.starts_at >= NOW()) AS next_appt
      FROM leads l
      WHERE l.deleted_at IS NULL AND l.state NOT IN ('won','lost') AND l.ro_id IS NULL
        AND COALESCE(l.pipe_status,'') NOT IN ('not_repairing','${PARKED.join("','")}')`);
    const cbs = await tq<RowDataPacket[]>(cid, `
      SELECT c.id, c.lead_id, c.user_id, c.due_at, c.note, l.lead_number, TRIM(CONCAT_WS(' ', l.first_name, l.last_name)) AS name,
             l.vehicle_text, l.owner_user_id, l.esc_step
      FROM lead_callbacks c JOIN leads l ON l.id = c.lead_id WHERE c.done_at IS NULL AND l.deleted_at IS NULL`);
    const now = Date.now(), H = 3600e3;
    const tasks: Array<Record<string, unknown>> = [];
    const add = (l: RowDataPacket, kind: string, due: number, extra: Record<string, unknown> = {}) =>
      tasks.push({ kind, leadId: l.id, leadNumber: l.lead_number, name: l.name, vehicle: l.vehicle_text,
        userId: l.owner_user_id ? Number(l.owner_user_id) : null, step: Number(l.esc_step) || 0, due: new Date(due).toISOString(), ...extra });
    for (const l of leads) {
      const lane = laneOf(l.source), c = cfgs[lane.key];
      const recv = new Date(l.received_at).getTime(), touch = new Date(l.last_touch).getTime();
      if (!l.owner_user_id) { add(l, 'handout', recv); continue; }
      if (!l.first_reply_at) add(l, 'first_call', recv + c.step1_hours * H);
      else if (l.estimate_written_at && !l.next_appt) add(l, 'chase_quote', touch + c.chase_quote_days * 24 * H);
      if (l.next_appt) {
        const at = new Date(l.next_appt).getTime();
        if (at - now < 36 * H) add(l, 'confirm_appt', at - 24 * H, { at: new Date(at).toISOString() });
      }
      if (['needs_reschedule', 'no_show', 'cancelled_appt'].includes(String(l.pipe_status))) {
        add(l, 'reschedule', new Date(l.pipe_status_at ?? l.received_at).getTime());
      }
    }
    for (const c of cbs) {
      tasks.push({ kind: 'callback', callbackId: c.id, leadId: c.lead_id, leadNumber: c.lead_number, name: c.name, vehicle: c.vehicle_text,
        userId: c.user_id ? Number(c.user_id) : (c.owner_user_id ? Number(c.owner_user_id) : null), step: Number(c.esc_step) || 0,
        due: new Date(c.due_at).toISOString(), note: c.note });
    }
    const all = !!ctx.caps.admin;
    const mgr = !!ctx.caps.salesManager;
    const scoped = tasks.filter(t => all || t.userId === ctx.user.id || (mgr && (Number(t.step) >= 2 || t.userId === null)));
    const staff = await tq<RowDataPacket[]>(cid, 'SELECT user_id, display_name FROM staff ORDER BY display_name').catch(() => []);
    const tm = await tq<RowDataPacket[]>(cid, 'SELECT tm.user_id, t.id AS team_id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id');
    const ids = [...new Set(scoped.map(t => t.userId).filter(Boolean))] as number[];
    if (!all && !ids.includes(ctx.user.id)) ids.push(ctx.user.id);
    const people = ids.map(id => {
      const t = tm.find(x => Number(x.user_id) === id);
      return { userId: id, name: staff.find(s => Number(s.user_id) === id)?.display_name ?? `User ${id}`,
        teamId: t ? Number(t.team_id) : null, team: t ? t.name : null };
    }).sort((a, b) => String(a.team ?? '~').localeCompare(String(b.team ?? '~')) || a.name.localeCompare(b.name));
    return { tasks: scoped.sort((a, b) => String(a.due).localeCompare(String(b.due))), people, canHandOut: !!(ctx.caps.salesManager || ctx.caps.admin),
      staff: staff.map(s => ({ userId: Number(s.user_id), name: s.display_name })) };
  });

  /** A logged touch, with a callback booked. The touch resets the clock and the ladder. */
  app.post('/api/leads/:id/callback', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { dueAt?: string; note?: string; how?: string };
    const due = new Date(String(b.dueAt ?? ''));
    if (isNaN(due.getTime())) return reply.code(400).send({ error: 'Pick when to call back.' });
    const lead = await tqOne<RowDataPacket>(cid, 'SELECT owner_user_id FROM leads WHERE id = ?', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    await texec(cid, 'INSERT INTO lead_callbacks (lead_id, user_id, due_at, note, created_by) VALUES (?, ?, ?, ?, ?)',
      [id, lead.owner_user_id ?? ctx.user.id, due, String(b.note ?? '').slice(0, 255) || null, ctx.user.id]);
    await touched(cid, id);
    await texec(cid, `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'note', ?, ?, ?)`,
      [id, `${b.how ? b.how + '. ' : ''}Callback booked for ${due.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}${b.note ? ': ' + b.note : ''}.`, ctx.user.id, ctx.user.name]);
    return { ok: true };
  });

  app.post('/api/callbacks/:id/done', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });
    await texec(ctx.company!.id, 'UPDATE lead_callbacks SET done_at = NOW() WHERE id = ? AND done_at IS NULL', [Number((req.params as { id: string }).id)]);
    return { ok: true };
  });

  /** Hand out: the owner change, with its in-app notice and timeline line. */
  app.post('/api/leads/:id/handout', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.salesManager && !ctx.caps.admin) return reply.code(403).send({ error: 'Sales managers hand out leads.' });
    const cid = ctx.company!.id, id = Number((req.params as { id: string }).id);
    const uid = Number((req.body as { userId?: number })?.userId);
    if (!uid) return reply.code(400).send({ error: 'Pick the rep.' });
    const lead = await tqOne<RowDataPacket>(cid, 'SELECT lead_number FROM leads WHERE id = ?', [id]);
    const s = await tqOne<RowDataPacket>(cid, 'SELECT display_name FROM staff WHERE user_id = ?', [uid]);
    if (!lead || !s) return reply.code(404).send({ error: 'Not found' });
    await texec(cid, 'UPDATE leads SET owner_user_id = ?, esc_step = 0 WHERE id = ?', [uid, id]);
    await texec(cid, `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, `Handed to ${s.display_name}.`, ctx.user.id, ctx.user.name]);
    await notify({ companyId: cid, event: 'lead.chase', leadId: id, title: `Lead ${lead.lead_number} handed to you`,
      body: `${ctx.user.name} handed you a lead.`, actorUserId: ctx.user.id, directUserIds: [uid], onlyDirect: true, appOnly: true,
      dedupeKey: `handout:${id}:${uid}:${Date.now()}` }).catch(() => undefined);
    return { ok: true };
  });

}
