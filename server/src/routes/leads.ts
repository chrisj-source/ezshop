import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { notify } from '../notify';
import { daysBetweenSql, shopToday, tzOffset } from '../lib/shoptime';

const SOURCES = ['phone', 'walk-in', 'website', 'referral', 'google', 'scheduler', 'sales app', 'other'];
const STATES = ['new', 'contacted', 'estimate_sent', 'appraisal_booked', 'won', 'lost'];
const LOST_REASONS = [
  'Price', 'Went elsewhere', 'Insurance totalled it', 'No answer', 'Not repairing',
  'Too far out', 'Outside what we do', 'Other'
];

interface FollowupCfg { days: number; windowDays: number }

/**
 * The shop's own follow-up numbers. Three days of silence suits a shop that
 * works its leads hard; two weeks suits one that does not.
 */
async function leadFollowupCfg(cid: number): Promise<FollowupCfg> {
  const rows = await tq<Array<RowDataPacket & { setting_key: string; setting_value: string }>>(
    cid, `SELECT setting_key, setting_value FROM shop_settings
          WHERE setting_key IN ('lead_followup_days', 'lead_appointment_window_days')`
  ).catch(() => []);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.setting_key] = r.setting_value;
  return {
    days: Math.max(1, Number(map.lead_followup_days ?? 3) || 3),
    windowDays: Math.max(1, Number(map.lead_appointment_window_days ?? 30) || 30)
  };
}

/**
 * Does this lead need chasing? Quiet for N days, still live, and nothing on the
 * calendar for them — a booked lead is already followed up.
 */
function markFollowup(l: Record<string, unknown>, cfg: FollowupCfg, today: string): void {
  const settled = l.state === 'won' || l.state === 'lost';
  const quiet = Number(l.quiet_days ?? 0);
  const booked = !!l.next_appointment;
  /* A hold that runs out today is over. Compared as plain date strings so the
     server's own clock never enters into it. */
  const snoozed = !!l.followup_snooze_until &&
    String(l.followup_snooze_until).slice(0, 10) >= today;

  l.needs_followup = !settled && !booked && !snoozed && quiet >= cfg.days;
  l.followup_due_in = settled || booked ? null : Math.max(0, cfg.days - quiet);
  l.followup_reason = settled ? null
    : booked ? 'booked'
    : snoozed ? 'held'
    : quiet >= cfg.days ? 'quiet'
    : 'waiting';
}

export async function registerLeads(app: FastifyInstance): Promise<void> {

  app.get('/api/lead-meta', async () => ({
    sources: SOURCES,
    states: [
      { key: 'new', label: 'New' },
      { key: 'contacted', label: 'Contacted' },
      { key: 'estimate_sent', label: 'Estimate sent' },
      { key: 'appraisal_booked', label: 'Appraisal booked' },
      { key: 'won', label: 'Won' },
      { key: 'lost', label: 'Lost' }
    ],
    lostReasons: LOST_REASONS
  }));

  app.get('/api/leads', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;

    const q = req.query as { state?: string; mine?: string; settled?: string };
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.state) { where.push('l.state = ?'); params.push(q.state); }
    else if (q.settled !== '1') where.push("l.state NOT IN ('won','lost')");

    if (q.mine === '1') { where.push('l.owner_user_id = ?'); params.push(ctx.user.id); }

    const cfg = await leadFollowupCfg(ctx.company!.id);
    /* The shop's day, not the server's. See lib/shoptime. */
    const tz = tzOffset(ctx.company!.timezone);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT l.*, r.ro_number, sf.display_name AS owner_name,
             TIMESTAMPDIFF(HOUR, l.received_at, COALESCE(l.first_reply_at, NOW())) AS hours_to_reply,
             TIMESTAMPDIFF(HOUR, l.received_at, NOW()) AS age_hours,
             /* Calendar days in the shop's timezone. Elapsed hours called a lead
                taken at 4pm yesterday “today”; counting UTC days called one taken
                at 8pm yesterday “today” as well, because it had already rolled
                over in UTC. */
             ${daysBetweenSql('l.received_at', 'NOW()')} AS age_days,
             ${daysBetweenSql('COALESCE(l.last_followup_at, l.received_at)', 'NOW()')} AS quiet_days,
             (SELECT MIN(a.starts_at) FROM appointments a
               WHERE a.lead_id = l.id AND a.cancelled_at IS NULL
                 AND a.starts_at >= NOW()
                 AND a.starts_at < DATE_ADD(NOW(), INTERVAL ? DAY)) AS next_appointment
      FROM leads l
      LEFT JOIN repair_orders r ON r.id = l.ro_id
      LEFT JOIN staff sf ON sf.user_id = l.owner_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (l.first_reply_at IS NULL) DESC, l.received_at DESC
      LIMIT 300`, ([tz, tz, tz, tz, cfg.windowDays] as unknown[]).concat(params));

    /* The flag is computed here rather than stored, so changing the shop's
       number re-flags everything at once instead of on next touch. */
    for (const l of rows) markFollowup(l as Record<string, unknown>, cfg, shopToday(ctx.company!.timezone));

    const [sum] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COUNT(*) AS total,
             SUM(state = 'new') AS fresh,
             SUM(first_reply_at IS NULL AND state NOT IN ('won','lost')) AS unanswered,
             SUM(state = 'won') AS won,
             SUM(state = 'lost') AS lost,
             AVG(TIMESTAMPDIFF(HOUR, received_at, first_reply_at)) AS avg_reply_hours
      FROM leads
      WHERE received_at > DATE_SUB(NOW(), INTERVAL 90 DAY)`);

    const staff = await mq<RowDataPacket[]>(
      `SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? AND m.status = 'active' ORDER BY u.name`, [ctx.company!.id]);

    const won = Number(sum.won ?? 0), lost = Number(sum.lost ?? 0);
    return {
      leads: rows,
      staff,
      followup: cfg,
      summary: {
        total: Number(sum.total ?? 0),
        fresh: Number(sum.fresh ?? 0),
        unanswered: Number(sum.unanswered ?? 0),
        needFollowup: rows.filter(r => (r as { needs_followup?: boolean }).needs_followup).length,
        won, lost,
        closeRate: won + lost ? Math.round((won / (won + lost)) * 100) : null,
        avgReplyHours: sum.avg_reply_hours === null ? null : Math.round(Number(sum.avg_reply_hours) * 10) / 10
      }
    };
  });

  app.get('/api/leads/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const lead = await tqOne<RowDataPacket>(cid, `
      SELECT l.*, r.ro_number,
             ${daysBetweenSql('l.received_at', 'NOW()')} AS age_days,
             TIMESTAMPDIFF(HOUR, l.received_at, NOW()) AS age_hours,
             ${daysBetweenSql('COALESCE(l.last_followup_at, l.received_at)', 'NOW()')} AS quiet_days
      FROM leads l
      LEFT JOIN repair_orders r ON r.id = l.ro_id WHERE l.id = ?`,
      [tzOffset(ctx.company!.timezone), tzOffset(ctx.company!.timezone),
       tzOffset(ctx.company!.timezone), tzOffset(ctx.company!.timezone), id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });

    const cfg = await leadFollowupCfg(cid);

    /* Every appointment for this lead, not just the one inside the window — the
       detail view should show a booking that is further out than the flag cares
       about, rather than pretending there is none. */
    const appointments = await tq<RowDataPacket[]>(cid, `
      SELECT id, kind, starts_at, duration_min, customer_name, vehicle_text, note,
             assigned_user_id, cancelled_at
      FROM appointments WHERE lead_id = ? ORDER BY starts_at`, [id]);

    const next = appointments.filter(a =>
      !a.cancelled_at && new Date(String(a.starts_at)) >= new Date())[0];
    (lead as Record<string, unknown>).next_appointment = next ? next.starts_at : null;
    markFollowup(lead as Record<string, unknown>, cfg, shopToday(ctx.company!.timezone));

    const events = await tq<RowDataPacket[]>(cid,
      'SELECT * FROM lead_events WHERE lead_id = ? ORDER BY created_at DESC, id DESC', [id]);

    return { lead, events, appointments, followup: cfg };
  });

  /**
   * "I chased this one." Resets the follow-up clock for another N days and
   * records what was done, so the history reads as a sequence of attempts rather
   * than a flag that blinked off.
   */
  app.post('/api/leads/:id/followup', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as { how?: string; note?: string; holdDays?: number };

    const lead = await tqOne<RowDataPacket & { state: string }>(
      cid, 'SELECT state FROM leads WHERE id = ?', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });

    const hold = Math.max(0, Number(b.holdDays ?? 0) || 0);
    await texec(cid, `
      UPDATE leads
      SET last_followup_at = NOW(),
          /* Held from the shop's today, so a hold set at 9pm is not a day short. */
          followup_snooze_until = ${hold ? 'DATE_ADD(?, INTERVAL ? DAY)' : 'NULL'},
          first_reply_at = COALESCE(first_reply_at, NOW())
      WHERE id = ?`, hold ? [shopToday(ctx.company!.timezone), hold, id] : [id]);

    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'followup', ?, ?, ?)`,
      [id,
       (b.how ? 'Followed up by ' + b.how : 'Followed up') +
       (b.note ? ' — ' + b.note : '') +
       (hold ? '. Held for ' + hold + ' days.' : '.'),
       ctx.user.id, ctx.user.name]);

    return { ok: true };
  });

  /**
   * Book this lead onto the calendar without leaving the lead. The appointment
   * carries lead_id, which is what stops the follow-up flag firing — a booked
   * lead has already been followed up.
   */
  app.post('/api/leads/:id/appointment', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as {
      startsAt: string; kind?: string; durationMin?: number;
      note?: string; assignedUserId?: number | null;
    };
    if (!b.startsAt) return reply.code(400).send({ error: 'Pick a date and time.' });

    const kind = ['estimate', 'drop', 'appraiser', 'pickup', 'return'].includes(b.kind ?? '')
      ? b.kind! : 'estimate';

    const lead = await tqOne<RowDataPacket & {
      first_name: string | null; last_name: string | null;
      phone: string | null; vehicle_text: string | null; lead_number: string;
    }>(cid, `SELECT lead_number, first_name, last_name, phone, vehicle_text
             FROM leads WHERE id = ?`, [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });

    const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Lead ' + lead.lead_number;

    const res = await texec(cid, `
      INSERT INTO appointments
        (kind, starts_at, duration_min, lead_id, customer_name, vehicle_text, phone,
         note, assigned_user_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, b.startsAt, b.durationMin ?? 30, id, who, lead.vehicle_text, lead.phone,
       b.note ?? null, b.assignedUserId ?? null, ctx.user.id]);

    /* The lead points at its appointment too, so the scheduler and the lead
       agree without a join in either direction. */
    await texec(cid, `
      UPDATE leads
      SET appointment_id = ?,
          state = IF(state IN ('new','contacted'), 'appraisal_booked', state),
          first_reply_at = COALESCE(first_reply_at, NOW()),
          last_followup_at = NOW()
      WHERE id = ?`, [res.insertId, id]);

    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'appointment', ?, ?, ?)`,
      [id, `Booked ${kind} for ${b.startsAt.replace('T', ' ')}.`, ctx.user.id, ctx.user.name]);

    return { ok: true, appointmentId: res.insertId };
  });

  app.post('/api/leads', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const b = req.body as {
      firstName?: string; lastName?: string; phone?: string; email?: string;
      vehicleText?: string; damageNote?: string; source?: string;
      ownerUserId?: number | null; receivedAt?: string;
    };

    if (!b.phone && !b.email && !b.lastName) {
      return reply.code(400).send({ error: 'A lead needs at least a name, a phone or an email.' });
    }

    const cid = ctx.company!.id;
    const id = await withTenantTx(cid, async (c) => {
      const [seq] = await c.query<RowDataPacket[]>(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(lead_number, 2) AS UNSIGNED)), 0) + 1 AS n FROM leads`);
      const num = 'L' + String(Number(seq[0].n ?? 1)).padStart(5, '0');

      const [r] = await c.query<ResultSetHeader>(`
        INSERT INTO leads
          (lead_number, source, state, first_name, last_name, phone, email,
           vehicle_text, damage_note, owner_user_id, received_at)
        VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()))`,
        [num, b.source ?? 'phone', b.firstName ?? null, b.lastName ?? null,
         b.phone ?? null, b.email ?? null, b.vehicleText ?? null, b.damageNote ?? null,
         b.ownerUserId ?? ctx.user.id, b.receivedAt ?? null]);

      await c.query(
        `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
         VALUES (?, 'auto', ?, ?, ?)`,
        [r.insertId, `Lead created from ${b.source ?? 'phone'}.`, ctx.user.id, ctx.user.name]);

      return r.insertId;
    });

    return { ok: true, id };
  });

  app.patch('/api/leads/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as Record<string, unknown>;

    const before = await tqOne<RowDataPacket & { state: string; first_reply_at: Date | null }>(
      cid, 'SELECT state, first_reply_at FROM leads WHERE id = ?', [id]);
    if (!before) return reply.code(404).send({ error: 'No such lead' });

    const map: Record<string, string> = {
      firstName: 'first_name', lastName: 'last_name', phone: 'phone', email: 'email',
      vehicleText: 'vehicle_text', damageNote: 'damage_note', source: 'source',
      ownerUserId: 'owner_user_id', lostReason: 'lost_reason'
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    const notes: string[] = [];

    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(b[k]);
    }

    if (b.state !== undefined) {
      const next = String(b.state);
      if (!STATES.includes(next)) return reply.code(400).send({ error: 'Unknown state' });
      sets.push('state = ?');
      vals.push(next);
      notes.push(`Moved from ${before.state.replace(/_/g, ' ')} to ${next.replace(/_/g, ' ')}`);

      if (next === 'won' || next === 'lost') sets.push('settled_at = NOW()');
      // First move off "new" is the first reply — that is the clock that matters.
      if (!before.first_reply_at && next !== 'new') sets.push('first_reply_at = NOW()');
    }

    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await texec(cid, `UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, vals);

    if (notes.length) {
      await texec(cid,
        `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [id, notes.join('. ') + '.', ctx.user.id, ctx.user.name]);
    }

    return { ok: true };
  });

  app.post('/api/leads/:id/notes', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const { body } = req.body as { body?: string };
    if (!body?.trim()) return reply.code(400).send({ error: 'Note is empty' });

    const cid = ctx.company!.id;
    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'note', ?, ?, ?)`,
      [id, body.trim(), ctx.user.id, ctx.user.name]);

    // Writing a note counts as making contact.
    await texec(cid,
      `UPDATE leads SET first_reply_at = COALESCE(first_reply_at, NOW()),
         state = IF(state = 'new', 'contacted', state)
       WHERE id = ?`, [id]);

    return { ok: true };
  });

  /** Turn a lead into a repair order and close the lead as won. */
  app.post('/api/leads/:id/convert', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as { roNumber: string; vin?: string; year?: number; make?: string; model?: string };
    if (!b.roNumber?.trim()) return reply.code(400).send({ error: 'An RO number is required.' });

    const lead = await tqOne<RowDataPacket>(cid, 'SELECT * FROM leads WHERE id = ?', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    if (lead.ro_id) return reply.code(409).send({ error: 'That lead is already on a repair order.' });

    const dup = await tqOne<RowDataPacket>(cid,
      'SELECT id FROM repair_orders WHERE ro_number = ?', [b.roNumber.trim()]);
    if (dup) return reply.code(409).send({ error: `RO ${b.roNumber.trim()} already exists.` });

    const roId = await withTenantTx(cid, async (c) => {
      const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Customer';
      const [cl] = await c.query<ResultSetHeader>(
        `INSERT INTO clients (kind, name, phone, email) VALUES ('retail', ?, ?, ?)`,
        [name, lead.phone ?? null, lead.email ?? null]);

      const text = String(lead.vehicle_text ?? '').split(' ');
      const [vh] = await c.query<ResultSetHeader>(
        `INSERT INTO vehicles (client_id, vin, year, make, model) VALUES (?, ?, ?, ?, ?)`,
        [cl.insertId, b.vin ?? null, b.year ?? (Number(text[0]) || null),
         b.make ?? text[1] ?? null, b.model ?? (text.slice(2).join(' ') || null)]);

      const [r] = await c.query<ResultSetHeader>(
        `INSERT INTO repair_orders
           (ro_number, client_id, vehicle_id, ro_type, repair_path, status_slot, status_since, created_by)
         VALUES (?, ?, ?, 'repair', 'undecided', 'intake.arrived', NOW(), ?)`,
        [b.roNumber.trim(), cl.insertId, vh.insertId, ctx.user.id]);

      await c.query(
        `INSERT INTO ro_status_history (ro_id, from_slot, to_slot, to_label, reason, user_id, user_name)
         VALUES (?, NULL, 'intake.arrived', 'Vehicle Arrived', ?, ?, ?)`,
        [r.insertId, `Converted from lead ${lead.lead_number}`, ctx.user.id, ctx.user.name]);

      if (lead.damage_note) {
        await c.query(
          `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'note', ?, ?, ?)`,
          [r.insertId, String(lead.damage_note), ctx.user.id, ctx.user.name]);
      }

      await c.query(
        `UPDATE leads SET state = 'won', ro_id = ?, settled_at = NOW(),
           first_reply_at = COALESCE(first_reply_at, NOW())
         WHERE id = ?`, [r.insertId, id]);

      await c.query(
        `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [id, `Converted to RO ${b.roNumber.trim()}.`, ctx.user.id, ctx.user.name]);

      return r.insertId;
    });

    await notify({
      companyId: cid, event: 'assign.file', roId,
      title: `New file from a lead — ${b.roNumber.trim()}`,
      body: `${lead.lead_number} converted to a repair order.`,
      actorUserId: ctx.user.id,
      dedupeKey: `leadconv:${id}`
    }).catch(() => {});

    return { ok: true, roId };
  });
}
