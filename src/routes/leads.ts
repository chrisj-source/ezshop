import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { notify } from '../notify';
import { daysBetweenSql, shopToday, tzOffset } from '../lib/shoptime';
import { audit } from '../lib/audit';
import { actorFrom } from './audit';
import { isSuppressed, noteSuppressionHit, refuseEmail } from '../lib/suppression';
import { scrubCustomer } from '../permissions';
import { shopCalendar, workingHoursBetween, Calendar } from '../lib/shophours';

/**
 * Re-measure the onboarding clock in WORKING hours.
 *
 * The SQL gives elapsed hours, which is what most shops want. A shop that
 * chooses the shop-hours clock gets the same span walked through its own open
 * windows instead — see lib/shophours. Done here, once per request, rather
 * than per row: the week is one query and the arithmetic is local.
 */
function applyShopClock(rows: Record<string, unknown>[], cal: Calendar): void {
  const now = new Date();
  for (const l of rows) {
    if (l.source !== 'sales app' || !l.received_at) continue;
    l.onboard_hours = workingHoursBetween(cal, new Date(String(l.received_at)), now);
  }
}

/**
 * Hide a lead's contact details from anyone without the capability — except
 * the person who created the lead, on their own lead.
 *
 * That exception is deliberate and it is enforced here rather than in the
 * capability: they typed the address in at the counter, so a screen that took
 * it back off them would be lying about what they had just entered. It applies
 * to their OWN leads only; a salesperson still cannot read the address on
 * somebody else's.
 */
function scrubLead<T extends Record<string, unknown>>(
  row: T, caps: Parameters<typeof scrubCustomer>[1], viewerId: number
): T {
  if (Number(row.owner_user_id) === viewerId) return row;
  return scrubCustomer(row, caps);
}

const SOURCES = ['phone', 'walk-in', 'website', 'referral', 'google', 'scheduler', 'sales app', 'other'];
const STATES = ['new', 'contacted', 'estimate_written', 'estimate_sent', 'appraisal_booked', 'won', 'lost'];
const PAYERS = ['cash', 'insurance'];
const LOST_REASONS = [
  'Price', 'Went elsewhere', 'Insurance totalled it', 'No answer', 'Not repairing',
  'Too far out', 'Outside what we do', 'Other'
];

interface FollowupCfg {
  /**
   * Hours of silence before a lead is flagged AND messaged. One number, not
   * two: it used to be `lead_followup_days` for the flag and
   * `lead_chase_hours` for the message, which could disagree and gave nobody a
   * way to say which was "the" setting.
   */
  chaseHours: number;
  windowDays: number;
  /**
   * A lead written on the sales screen is chased in HOURS, not days. Somebody
   * has been stood in front of the customer, the car is expected, and an
   * onboarding call has to happen before it goes cold. Twelve hours by default
   * against the normal three days.
   */
  salesRedHours: number;
  /**
   * 'actual' — real elapsed hours. Decided 15 Sep 2026: not shop hours, because
   * a Friday evening sale needs the call on Saturday and a clock that waits for
   * Monday defeats the point.
   *
   * 'shop' walks the span through the shop's own open windows instead — see
   * `applyShopClock` below and `lib/shophours`. Both are real; the shop picks.
   */
  salesClock: 'actual' | 'shop';
}

/**
 * The shop's own follow-up numbers. Three days of silence suits a shop that
 * works its leads hard; two weeks suits one that does not.
 */
async function leadFollowupCfg(cid: number): Promise<FollowupCfg> {
  const rows = await tq<Array<RowDataPacket & { setting_key: string; setting_value: string }>>(
    cid, `SELECT setting_key, setting_value FROM shop_settings
          WHERE setting_key IN ('lead_chase_hours', 'lead_followup_days',
                                'lead_appointment_window_days',
                                'sales_onboard_red_hours', 'sales_onboard_clock')`
  ).catch(() => []);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.setting_key] = r.setting_value;
  return {
    /* The old days setting is the fallback for a database that has not taken
       migration 028 yet, so the flag never silently becomes "never". */
    chaseHours: Math.max(1, Number(map.lead_chase_hours
      ?? (Number(map.lead_followup_days ?? 3) || 3) * 24) || 72),
    windowDays: Math.max(1, Number(map.lead_appointment_window_days ?? 30) || 30),
    salesRedHours: Math.max(1, Number(map.sales_onboard_red_hours ?? 12) || 12),
    salesClock: map.sales_onboard_clock === 'shop' ? 'shop' : 'actual'
  };
}

/**
 * Does this lead need chasing? Quiet for N days, still live, and nothing on the
 * calendar for them — a booked lead is already followed up.
 */
function markFollowup(l: Record<string, unknown>, cfg: FollowupCfg, today: string): void {
  const settled = l.state === 'won' || l.state === 'lost';
  /* Hours throughout now. `quiet_days` is still sent for the screen's wording
     but no longer decides anything. */
  const quiet = Number(l.quiet_hours ?? 0);
  const booked = !!l.next_appointment;
  /* A hold that runs out today is over. Compared as plain date strings so the
     server's own clock never enters into it. */
  const snoozed = !!l.followup_snooze_until &&
    String(l.followup_snooze_until).slice(0, 10) >= today;

  l.needs_followup = !settled && !booked && !snoozed && quiet >= cfg.chaseHours;
  l.followup_due_in_hours = settled || booked ? null : Math.max(0, cfg.chaseHours - quiet);
  /* Days as well, rounded up, because "due in 2 days" reads better than "due
     in 38 hours" on a list somebody scans. */
  l.followup_due_in = l.followup_due_in_hours === null
    ? null : Math.ceil(Number(l.followup_due_in_hours) / 24);
  l.followup_reason = settled ? null
    : booked ? 'booked'
    : snoozed ? 'held'
    : quiet >= cfg.chaseHours ? 'quiet'
    : 'waiting';

  /**
   * The sales-app clock, which runs alongside the one above rather than
   * replacing it.
   *
   * A lead written on the road is waiting on an onboarding call. It goes RED at
   * the shop's hour figure — twelve by default — and red here means red: the
   * screen should show it as overdue, not merely due.
   *
   * `onboarded` is what stops it: somebody logged contact after the lead was
   * written. A booked drop does NOT stop it, deliberately — the appointment is
   * the car arriving, the call is the shop making sure it does.
   */
  if (l.source === 'sales app' && !settled) {
    const hours = Number(l.onboard_hours ?? 0);
    const onboarded = !!l.onboard_done;
    l.onboard_red = !onboarded && hours >= cfg.salesRedHours;
    l.onboard_hours_left = onboarded ? null : Math.max(0, cfg.salesRedHours - hours);
    l.onboard_needed = !onboarded;
    /* The row is red for whichever clock fires first. */
    if (l.onboard_red) {
      l.needs_followup = true;
      l.followup_reason = 'onboarding';
    }
  } else {
    l.onboard_red = false;
    l.onboard_needed = false;
    l.onboard_hours_left = null;
  }
}

export async function registerLeads(app: FastifyInstance): Promise<void> {

  app.get('/api/lead-meta', async () => ({
    sources: SOURCES,
    states: [
      { key: 'new', label: 'New' },
      { key: 'contacted', label: 'Contacted' },
      /* Two estimate states. Written is the one done here at the counter and it
         carries the figure; sent is the insurer one and carries no amount of its
         own. Cash-pay work stops at written. */
      { key: 'estimate_written', label: 'Estimate written' },
      { key: 'estimate_sent', label: 'Estimate sent', insuranceOnly: true },
      { key: 'appraisal_booked', label: 'Appraisal booked' },
      { key: 'won', label: 'Won' },
      { key: 'lost', label: 'Lost' }
    ],
    payers: [
      { key: 'cash', label: 'Cash / customer pay' },
      { key: 'insurance', label: 'Insurance' }
    ],
    lostReasons: LOST_REASONS
  }));

  app.get('/api/leads', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;

    const q = req.query as { state?: string; mine?: string; settled?: string; deleted?: string };
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.state) { where.push('l.state = ?'); params.push(q.state); }
    else if (q.settled !== '1') where.push("l.state NOT IN ('won','lost')");

    /* A deleted lead is off the list and out of the response clock, but the
       record stays. deleted=1 shows them so one can be restored. */
    where.push(q.deleted === '1' ? 'l.deleted_at IS NOT NULL' : 'l.deleted_at IS NULL');

    if (q.mine === '1') { where.push('l.owner_user_id = ?'); params.push(ctx.user.id); }

    const cfg = await leadFollowupCfg(ctx.company!.id);
    /* The shop's day, not the server's. See lib/shoptime. */
    const tz = tzOffset(ctx.company!.timezone);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT l.*, r.ro_number, sf.display_name AS owner_name,
             TIMESTAMPDIFF(HOUR, l.received_at, COALESCE(l.first_reply_at, NOW())) AS hours_to_reply,
             TIMESTAMPDIFF(HOUR, l.received_at, NOW()) AS age_hours,
             /* The onboarding clock for a sales-app lead. Real elapsed hours,
                not shop hours: a Friday evening sale needs the call on
                Saturday. onboard_done is somebody having logged contact since
                the lead was written; the sales route stamps first_reply_at at
                creation, so that column cannot be the signal, but
                last_followup_at is only ever set by a human marking the lead
                chased. */
             TIMESTAMPDIFF(HOUR, l.received_at, NOW()) AS onboard_hours,
             (l.last_followup_at IS NOT NULL) AS onboard_done,
             /* Calendar days in the shop's timezone. Elapsed hours called a lead
                taken at 4pm yesterday “today”; counting UTC days called one taken
                at 8pm yesterday “today” as well, because it had already rolled
                over in UTC. */
             ${daysBetweenSql('l.received_at', 'NOW()')} AS age_days,
             ${daysBetweenSql('COALESCE(l.last_followup_at, l.received_at)', 'NOW()')} AS quiet_days,
             TIMESTAMPDIFF(HOUR, COALESCE(l.last_followup_at, l.received_at), NOW()) AS quiet_hours,
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
    if (cfg.salesClock === 'shop') {
      applyShopClock(rows as Record<string, unknown>[],
        await shopCalendar(ctx.company!.id, ctx.company!.timezone));
    }
    for (const l of rows) markFollowup(l as Record<string, unknown>, cfg, shopToday(ctx.company!.timezone));

    const [sum] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COUNT(*) AS total,
             SUM(state = 'new') AS fresh,
             SUM(first_reply_at IS NULL AND state NOT IN ('won','lost')) AS unanswered,
             SUM(state = 'won') AS won,
             SUM(state = 'lost') AS lost,
             AVG(TIMESTAMPDIFF(HOUR, received_at, first_reply_at)) AS avg_reply_hours,
             /* Quoted dollars. A lost lead's quote stays in the total — it is a
                lost quote, and leaving it out would flatter the close rate. */
             SUM(estimate_cents) AS quoted_cents,
             SUM(estimate_cents IS NOT NULL) AS quoted,
             SUM(IF(state = 'won', estimate_cents, 0)) AS won_cents,
             /* Written, still live, and nobody has chased it since. Chasing
                before the quote existed does not count. */
             SUM(estimate_written_at IS NOT NULL
                 AND state NOT IN ('won','lost')
                 AND (last_followup_at IS NULL OR last_followup_at < estimate_written_at)
                ) AS quotes_unchased
      FROM leads
      WHERE deleted_at IS NULL AND received_at > DATE_SUB(NOW(), INTERVAL 90 DAY)`);

    const staff = await mq<RowDataPacket[]>(
      `SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? AND m.status = 'active' ORDER BY u.name`, [ctx.company!.id]);

    const won = Number(sum.won ?? 0), lost = Number(sum.lost ?? 0);
    const quotedCents = Number(sum.quoted_cents ?? 0);
    const wonCents = Number(sum.won_cents ?? 0);
    const quoted = Number(sum.quoted ?? 0);
    return {
      leads: rows.map(l => scrubLead(l as Record<string, unknown>, ctx.caps, ctx.user.id)),
      staff,
      followup: cfg,
      summary: {
        total: Number(sum.total ?? 0),
        fresh: Number(sum.fresh ?? 0),
        unanswered: Number(sum.unanswered ?? 0),
        needFollowup: rows.filter(r => (r as { needs_followup?: boolean }).needs_followup).length,
        won, lost,
        closeRate: won + lost ? Math.round((won / (won + lost)) * 100) : null,
        avgReplyHours: sum.avg_reply_hours === null ? null : Math.round(Number(sum.avg_reply_hours) * 10) / 10,
        /* The money figures are a lead question, not a repair-order one, so they
           ride with leads rather than behind the money capability: a
           salesperson working their own quotes needs to see what they quoted. */
        quoted,
        quotedCents,
        wonCents,
        moneyCloseRate: quotedCents ? Math.round((wonCents / quotedCents) * 100) : null,
        avgQuoteCents: quoted ? Math.round(quotedCents / quoted) : null,
        quotesUnchased: Number(sum.quotes_unchased ?? 0)
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
             /* The onboarding clock for a sales-app lead. Real elapsed hours,
                not shop hours: a Friday evening sale needs the call on
                Saturday. onboard_done is somebody having logged contact since
                the lead was written; the sales route stamps first_reply_at at
                creation, so that column cannot be the signal, but
                last_followup_at is only ever set by a human marking the lead
                chased. */
             TIMESTAMPDIFF(HOUR, l.received_at, NOW()) AS onboard_hours,
             (l.last_followup_at IS NOT NULL) AS onboard_done,
             ${daysBetweenSql('COALESCE(l.last_followup_at, l.received_at)', 'NOW()')} AS quiet_days,
             TIMESTAMPDIFF(HOUR, COALESCE(l.last_followup_at, l.received_at), NOW()) AS quiet_hours
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
    if (cfg.salesClock === 'shop') {
      applyShopClock([lead as Record<string, unknown>],
        await shopCalendar(cid, ctx.company!.timezone));
    }
    markFollowup(lead as Record<string, unknown>, cfg, shopToday(ctx.company!.timezone));

    const events = await tq<RowDataPacket[]>(cid,
      'SELECT * FROM lead_events WHERE lead_id = ? ORDER BY created_at DESC, id DESC', [id]);

    return {
      lead: scrubLead(lead as Record<string, unknown>, ctx.caps, ctx.user.id),
      events, appointments, followup: cfg
    };
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
          /* The automatic chase message is per silence, not per lead: clearing
             the stamp means the NEXT stretch of quiet earns a fresh one
             instead of this lead never being reported again. */
          chase_notified_at = NULL,
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
    if (!b.startsAt || !wallClock(b.startsAt)) {
      return reply.code(400).send({ error: 'Pick a date and time.' });
    }

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
      [kind, wallClock(b.startsAt), b.durationMin ?? 30, id, who, lead.vehicle_text, lead.phone,
       b.note ?? null, b.assignedUserId ?? null, ctx.user.id]);

    /* The lead points at its appointment too, so the scheduler and the lead
       agree without a join in either direction. */
    await texec(cid, `
      UPDATE leads
      SET appointment_id = ?,
          state = IF(state IN ('new','contacted'), 'appraisal_booked', state),
          first_reply_at = COALESCE(first_reply_at, NOW()),
          last_followup_at = NOW(),
          chase_notified_at = NULL
      WHERE id = ?`, [res.insertId, id]);

    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'appointment', ?, ?, ?)`,
      [id, `Booked ${kind} for ${b.startsAt.replace('T', ' ')}.`, ctx.user.id, ctx.user.name]);

    return { ok: true, appointmentId: res.insertId };
  });

  /**
   * Mark an estimate written, or replace the figure on one already written.
   *
   * This is the estimate written HERE, at the counter, and the amount is the
   * point of it: it is what the follow-up is about, so it is required. The
   * insurer estimate is a different state (`estimate_sent`) and carries no
   * amount of its own.
   *
   * Re-quoting overwrites. The latest figure is the number the shop works
   * from; the one it replaced goes to the lead's history, which is the only
   * place a superseded quote belongs.
   */
  app.post('/api/leads/:id/estimate', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as { amountCents?: number; writtenOn?: string; note?: string };

    const amount = Math.round(Number(b.amountCents));
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'An estimate needs an amount. It is what the follow-up is about.' });
    }

    const lead = await tqOne<RowDataPacket & {
      state: string; lead_number: string; estimate_cents: number | null;
    }>(cid, 'SELECT state, lead_number, estimate_cents FROM leads WHERE id = ?', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });

    const had = lead.estimate_cents === null ? null : Number(lead.estimate_cents);
    const requote = had !== null;
    const money = (c: number) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    /* Written-on defaults to today and is editable, because an estimate written
       on Friday may not be entered until Monday. A settled lead keeps its
       state: recording what was quoted on a car that went elsewhere is exactly
       how the lost-quote figure gets its numbers. */
    const settled = lead.state === 'won' || lead.state === 'lost';
    await texec(cid, `
      UPDATE leads
      SET estimate_cents = ?,
          estimate_written_at = COALESCE(?, estimate_written_at, NOW()),
          estimate_written_by = ?,
          estimate_note = COALESCE(NULLIF(?, ''), estimate_note),
          estimate_requoted_at = ${requote ? 'NOW()' : 'estimate_requoted_at'},
          state = ${settled ? 'state' : "IF(state = 'estimate_sent', state, 'estimate_written')"},
          first_reply_at = COALESCE(first_reply_at, NOW())
      WHERE id = ?`,
      [amount, b.writtenOn || null, ctx.user.id, (b.note ?? '').trim().slice(0, 255), id]);

    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'estimate', ?, ?, ?)`,
      [id,
       requote
         ? `Quote changed from ${money(had!)} to ${money(amount)}.`
         : `Estimate written — ${money(amount)}.` + (b.note ? ' ' + b.note.trim() : ''),
       ctx.user.id, ctx.user.name]);

    await audit(cid, actorFrom(req), {
      entity: 'lead', entityId: id, action: requote ? 'lead_requote' : 'lead_estimate', area: 'Lead',
      label: `Lead ${lead.lead_number} — ` +
        (requote ? `re-quoted at ${money(amount)}` : `estimate written, ${money(amount)}`),
      changes: [{ field: 'Estimate', from: had === null ? null : String(had), to: String(amount) }]
    });

    return { ok: true, amountCents: amount, requote };
  });

  app.post('/api/leads', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const b = req.body as {
      firstName?: string; lastName?: string; phone?: string; email?: string;
      /* addrState, not state: on a lead, state is the status enum. */
      address?: string; city?: string; addrState?: string; zip?: string;
      vehicleText?: string; damageNote?: string; source?: string; payer?: string;
      ownerUserId?: number | null; receivedAt?: string;
    };

    if (!b.phone && !b.email && !b.lastName) {
      return reply.code(400).send({ error: 'A lead needs at least a name, a phone or an email.' });
    }

    const cid = ctx.company!.id;

    /* Typed at the counter, so it is refused here the same way it would be on a
       client record — this is the desk entering an address, not the customer
       giving one. */
    const refused = await refuseEmail(cid, b.email, 'new lead');
    if (refused) return reply.code(409).send({ error: refused, field: 'email' });

    const id = await withTenantTx(cid, async (c) => {
      const [seq] = await c.query<RowDataPacket[]>(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(lead_number, 2) AS UNSIGNED)), 0) + 1 AS n FROM leads`);
      const num = 'L' + String(Number(seq[0].n ?? 1)).padStart(5, '0');

      const [r] = await c.query<ResultSetHeader>(`
        INSERT INTO leads
          (lead_number, source, state, first_name, last_name, phone, email,
           address, city, addr_state, zip,
           vehicle_text, damage_note, payer, owner_user_id, received_at)
        VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()))`,
        [num, b.source ?? 'phone', b.firstName ?? null, b.lastName ?? null,
         b.phone ?? null, b.email ?? null,
         b.address ?? null, b.city ?? null, b.addrState ?? null, b.zip ?? null,
         b.vehicleText ?? null, b.damageNote ?? null,
         PAYERS.includes(b.payer ?? '') ? b.payer : 'cash',
         b.ownerUserId ?? ctx.user.id, b.receivedAt ?? null]);

      await c.query(
        `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
         VALUES (?, 'auto', ?, ?, ?)`,
        [r.insertId, `Lead created from ${b.source ?? 'phone'}.`, ctx.user.id, ctx.user.name]);

      return r.insertId;
    });

    return { ok: true, id };
  });

  /**
   * Delete a lead — soft, like a void. It comes off the list and out of the
   * response clock; the record, its notes and its history stay and it can be
   * restored. A converted lead belongs to an RO and cannot be deleted: mark it
   * lost instead.
   */
  app.delete('/api/leads/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { reason?: string };
    const cid = ctx.company!.id;

    const lead = await tqOne<RowDataPacket>(cid,
      `SELECT lead_number, ro_id, deleted_at FROM leads WHERE id = ?`, [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    if (lead.deleted_at) return reply.code(400).send({ error: 'That lead is already deleted.' });
    if (lead.ro_id) {
      return reply.code(400).send({
        error: 'That lead was converted to a repair order, so it cannot be deleted. Mark it lost instead.'
      });
    }

    const reason = (b.reason ?? '').trim().slice(0, 64) || 'No reason given';

    await texec(cid,
      `UPDATE leads SET deleted_at = NOW(), deleted_by = ?, delete_reason = ? WHERE id = ?`,
      [ctx.user.id, reason, id]);
    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'auto', ?, ?, ?)`,
      [id, `Lead deleted — ${reason}. Restorable.`, ctx.user.id, ctx.user.name]);
    await texec(cid,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (?, ?, 'lead', ?, 'delete', ?)`,
      [ctx.user.id, ctx.user.name, id, JSON.stringify({ leadNumber: lead.lead_number, reason })]);

    return { ok: true };
  });

  app.post('/api/leads/:id/restore', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const lead = await tqOne<RowDataPacket>(cid,
      `SELECT lead_number, deleted_at FROM leads WHERE id = ?`, [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    if (!lead.deleted_at) return reply.code(400).send({ error: 'That lead is not deleted.' });

    await texec(cid,
      `UPDATE leads SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = ?`,
      [id]);
    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'auto', 'Lead restored.', ?, ?)`,
      [id, ctx.user.id, ctx.user.name]);

    return { ok: true };
  });

  app.patch('/api/leads/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as Record<string, unknown>;

    const before = await tqOne<RowDataPacket & {
      state: string; first_reply_at: Date | null;
      estimate_cents: number | null; payer: string;
    }>(cid, 'SELECT state, first_reply_at, estimate_cents, payer FROM leads WHERE id = ?', [id]);
    if (!before) return reply.code(404).send({ error: 'No such lead' });

    const map: Record<string, string> = {
      firstName: 'first_name', lastName: 'last_name', phone: 'phone', email: 'email',
      address: 'address', city: 'city', addrState: 'addr_state', zip: 'zip',
      vehicleText: 'vehicle_text', damageNote: 'damage_note', source: 'source',
      payer: 'payer', ownerUserId: 'owner_user_id', lostReason: 'lost_reason'
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    const notes: string[] = [];

    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(b[k]);
    }

    if (b.payer !== undefined && !PAYERS.includes(String(b.payer))) {
      return reply.code(400).send({ error: 'Unknown payer' });
    }

    if (b.state !== undefined) {
      const next = String(b.state);
      if (!STATES.includes(next)) return reply.code(400).send({ error: 'Unknown state' });

      /* The amount is what makes the state mean anything, so the state cannot
         be reached without one. POST /estimate is the way in — it takes the
         figure in the same request. */
      if (next === 'estimate_written' && before.estimate_cents === null) {
        return reply.code(400).send({
          error: 'Mark the estimate written with its amount — the figure is what the follow-up is about.'
        });
      }

      /* Cash-pay work stops at written. There is nobody to send it to. */
      const payerNow = b.payer !== undefined ? String(b.payer) : before.payer;
      if (next === 'estimate_sent' && payerNow !== 'insurance') {
        return reply.code(400).send({
          error: 'Only insurance work reaches Estimate sent. This one is cash-pay, so it stops at Estimate written.'
        });
      }

      sets.push('state = ?');
      vals.push(next);
      notes.push(`Moved from ${before.state.replace(/_/g, ' ')} to ${next.replace(/_/g, ' ')}`);

      if (next === 'won' || next === 'lost') sets.push('settled_at = NOW()');
      /* Reaching `won` from the dropdown is the same act as the Won button, so
         it is the same capability and it is stamped the same way. Without this
         the select would be a way around the tick. */
      if (next === 'won' && before.state !== 'won') {
        if (!ctx.caps.winLeads) {
          return reply.code(403).send({
            error: 'Marking a lead won by hand is not yours to do. Convert it to a repair order, or ask somebody who holds that permission.'
          });
        }
        sets.push('won_by_hand = 1', 'won_at = NOW()', 'won_by_user_id = ?', 'won_by_name = ?');
        vals.push(ctx.user.id, ctx.user.name);
      }
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

    /* Every field that moved, named. A lead edited quietly — a promise date
       pushed, an owner swapped — is exactly what nobody writes a note about. */
    const FIELD_LABEL: Record<string, string> = {
      firstName: 'First name', lastName: 'Last name', phone: 'Phone', email: 'Email',
      vehicleText: 'Vehicle', damageNote: 'Damage note', source: 'Source', payer: 'Pays',
      ownerUserId: 'Owner', lostReason: 'Lost reason', state: 'State'
    };
    const changed = Object.keys(FIELD_LABEL)
      .filter(k => b[k] !== undefined)
      .map(k => ({
        field: FIELD_LABEL[k],
        from: k === 'state' ? before.state : null,
        to: b[k] == null ? null : String(b[k])
      }));

    const lead = await tqOne<RowDataPacket & { lead_number: string }>(
      cid, 'SELECT lead_number FROM leads WHERE id = ?', [id]);

    await audit(cid, actorFrom(req), {
      entity: 'lead', entityId: id, action: 'lead_edit', area: 'Lead',
      label: `Lead ${lead?.lead_number ?? id} — ` +
        (b.state !== undefined
          ? `moved to ${String(b.state).replace(/_/g, ' ')}`
          : changed.map(c => c.field.toLowerCase()).join(', ') + ' changed'),
      changes: changed
    });

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
         state = IF(state = 'new', 'contacted', state),
         /* A note is contact. It resets the silence the same as marking it
            chased does, or somebody who writes up a phone call still gets
            told the lead has gone quiet. */
         last_followup_at = NOW(), chase_notified_at = NULL
       WHERE id = ?`, [id]);

    return { ok: true };
  });

  /* ------------------------------------------------- won by hand, and linking
   *
   * Converting writes the file. This is the other half: the customer dropped
   * the car off, somebody at the desk opened a file for them, and the lead is
   * now stranded — converting it would write a SECOND file for the same car.
   *
   * Both routes are behind `win_lead`, owner-only until a shop ticks it
   * outward, because between them they are the way to reach `won` without the
   * step the close rate is measured off.
   */

  /** Open files, for the picker. Searchable, and already-claimed files are out. */
  app.get('/api/leads/open-files', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;
    if (!ctx.caps.winLeads) return reply.code(403).send({ error: 'Not permitted' });

    const q = String((req.query as { q?: string }).q ?? '').trim();
    const like = '%' + q + '%';
    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT r.id, r.ro_number, r.opened_at, s.label AS status_label,
             c.name AS customer_name,
             TRIM(CONCAT_WS(' ', v.year, v.make, v.model)) AS vehicle_text
      FROM repair_orders r
      LEFT JOIN clients c  ON c.id = r.client_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      LEFT JOIN statuses s ON s.slot_id = r.status_slot
      WHERE r.close_date IS NULL AND r.closed_at IS NULL AND r.voided_at IS NULL
        /* A file already answering to a lead is not offered. The unique index
           would refuse it anyway; this is so nobody picks it and finds out. */
        AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.ro_id = r.id)
        ${q ? `AND (r.ro_number LIKE ? OR c.name LIKE ?
                    OR TRIM(CONCAT_WS(' ', v.year, v.make, v.model)) LIKE ?)` : ''}
      ORDER BY r.opened_at DESC
      LIMIT 40`, q ? [like, like, like] : []);

    return { files: rows.map(r => scrubCustomer(r as Record<string, unknown>, ctx.caps)) };
  });

  /**
   * Mark this lead won without converting it, optionally pointing it at the
   * file somebody has already opened.
   *
   * The file is optional on purpose. A lead can be genuinely won with no file
   * yet — the car is booked in for next month — and refusing the mark until
   * there is one would leave the lead sitting in the follow-up queue being
   * chased for work the shop already has.
   */
  app.post('/api/leads/:id/win', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;
    if (!ctx.caps.winLeads) {
      return reply.code(403).send({
        error: 'Marking a lead won by hand is not yours to do. Convert it to a repair order, or ask somebody who holds that permission.'
      });
    }

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { roId?: number | null; note?: string };

    const lead = await tqOne<RowDataPacket & {
      lead_number: string; state: string; ro_id: number | null; deleted_at: Date | null;
    }>(cid, 'SELECT lead_number, state, ro_id, deleted_at FROM leads WHERE id = ?', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    if (lead.deleted_at) return reply.code(400).send({ error: 'That lead is deleted. Restore it first.' });
    if (lead.state === 'won') return reply.code(409).send({ error: 'That lead is already won.' });

    const wantRo = b.roId ? Number(b.roId) : null;
    let file: (RowDataPacket & { id: number; ro_number: string }) | null = null;
    if (wantRo) {
      if (lead.ro_id) {
        return reply.code(409).send({ error: 'That lead is already on a file. Unlink it first.' });
      }
      file = await openFileForLink(cid, wantRo, reply);
      if (!file) return;
    }

    const note = (b.note ?? '').trim().slice(0, 255);

    await texec(cid, `
      UPDATE leads
      SET state = 'won', settled_at = NOW(),
          won_by_hand = 1, won_at = NOW(), won_by_user_id = ?, won_by_name = ?,
          win_note = NULLIF(?, ''),
          ${wantRo ? "ro_id = ?, ro_link_kind = 'linked', ro_linked_at = NOW(), ro_linked_by = ?," : ''}
          first_reply_at = COALESCE(first_reply_at, NOW()),
          chase_notified_at = NULL
      WHERE id = ?`,
      wantRo
        ? [ctx.user.id, ctx.user.name, note, wantRo, ctx.user.id, id]
        : [ctx.user.id, ctx.user.name, note, id]);

    const body = (file
      ? `Marked won by hand and linked to RO ${file.ro_number}, which was already open.`
      : 'Marked won by hand. No file linked yet.') + (note ? ' ' + note : '');

    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'auto', ?, ?, ?)`, [id, body, ctx.user.id, ctx.user.name]);

    await audit(cid, actorFrom(req), {
      entity: 'lead', entityId: id, action: 'lead_won_manual', area: 'Lead',
      roId: file ? Number(file.id) : undefined,
      label: `Lead ${lead.lead_number} — marked won by hand` +
        (file ? `, linked to RO ${file.ro_number}` : ', no file'),
      changes: [{ field: 'State', from: lead.state, to: 'won' }]
    });

    return { ok: true, roId: file ? Number(file.id) : null };
  });

  /** Point a lead at a file that already exists, without touching its state. */
  app.post('/api/leads/:id/link-ro', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'leads', reply)) return;
    if (!ctx.caps.winLeads) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const roId = Number((req.body as { roId?: number })?.roId);
    if (!roId) return reply.code(400).send({ error: 'Pick the file to link.' });

    const lead = await tqOne<RowDataPacket & { lead_number: string; ro_id: number | null }>(
      cid, 'SELECT lead_number, ro_id FROM leads WHERE id = ?', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    if (lead.ro_id) {
      return reply.code(409).send({ error: 'That lead is already on a file. Unlink it first.' });
    }

    const file = await openFileForLink(cid, roId, reply);
    if (!file) return;

    await texec(cid, `
      UPDATE leads
      SET ro_id = ?, ro_link_kind = 'linked', ro_linked_at = NOW(), ro_linked_by = ?
      WHERE id = ?`, [roId, ctx.user.id, id]);

    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'auto', ?, ?, ?)`,
      [id, `Linked to RO ${file.ro_number}, which was already open.`, ctx.user.id, ctx.user.name]);

    await audit(cid, actorFrom(req), {
      entity: 'lead', entityId: id, action: 'lead_link_ro', area: 'Lead', roId,
      label: `Lead ${lead.lead_number} — linked to RO ${file.ro_number}`,
      changes: [{ field: 'Repair order', from: null, to: file.ro_number }]
    });

    return { ok: true, roId };
  });

  /**
   * Undo a link. Only a link: a converted lead wrote its file and unpicking
   * that would leave a repair order with no history of where it came from.
   * The state is left alone — being wrong about which file is not being wrong
   * about having won the work.
   */
  app.delete('/api/leads/:id/link-ro', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.winLeads) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const lead = await tqOne<RowDataPacket & {
      lead_number: string; ro_id: number | null; ro_link_kind: string | null;
    }>(cid, 'SELECT lead_number, ro_id, ro_link_kind FROM leads WHERE id = ?', [id]);
    if (!lead) return reply.code(404).send({ error: 'No such lead' });
    if (!lead.ro_id) return reply.code(400).send({ error: 'That lead is not on a file.' });
    if (lead.ro_link_kind !== 'linked') {
      return reply.code(400).send({
        error: 'That lead was converted, so the file came from it and the link stays. Void the file instead.'
      });
    }

    const was = await tqOne<RowDataPacket & { ro_number: string }>(
      cid, 'SELECT ro_number FROM repair_orders WHERE id = ?', [lead.ro_id]);

    await texec(cid,
      `UPDATE leads SET ro_id = NULL, ro_link_kind = NULL, ro_linked_at = NULL, ro_linked_by = NULL
       WHERE id = ?`, [id]);
    await texec(cid,
      `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name)
       VALUES (?, 'auto', ?, ?, ?)`,
      [id, `Unlinked from RO ${was?.ro_number ?? lead.ro_id}.`, ctx.user.id, ctx.user.name]);

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
      /* The address carries across as it is. A conversion is not the moment to
         refuse an address — the car is being taken in — so an unsubscribed one
         travels onto the file and is recorded as a hit instead, and simply never
         receives anything. */
      /* The address travels with the conversion. Note the column mapping:
         `leads.addr_state` → `clients.state`, because on a lead `state` is the
         status enum and on a client it is the US state. */
      const [cl] = await c.query<ResultSetHeader>(
        `INSERT INTO clients (kind, name, phone, email, address, city, state, zip)
         VALUES ('retail', ?, ?, ?, ?, ?, ?, ?)`,
        [name, lead.phone ?? null, lead.email ?? null,
         lead.address ?? null, lead.city ?? null, lead.addr_state ?? null, lead.zip ?? null]);
      if (lead.email && await isSuppressed('email', String(lead.email), cid)) {
        await noteSuppressionHit(cid, 'email', String(lead.email), 'carried from a converted lead');
      }

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

      /* What the lead was quoted at, written onto the file as a note and
         nowhere else. It deliberately does NOT fill the approval amount:
         quoted and approved are different numbers, and the only way to compare
         them later is to keep them apart now. */
      if (lead.estimate_cents !== null && lead.estimate_cents !== undefined) {
        const q = '$' + (Number(lead.estimate_cents) / 100)
          .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        await c.query(
          `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
          [r.insertId,
           `Quoted ${q} on lead ${lead.lead_number}. Not an approval figure — the approval is whatever the file is written for.`,
           ctx.user.id, ctx.user.name]);
      }

      await c.query(
        `UPDATE leads SET state = 'won', ro_id = ?, settled_at = NOW(),
           ro_link_kind = 'converted', ro_linked_at = NOW(), ro_linked_by = ?,
           first_reply_at = COALESCE(first_reply_at, NOW())
         WHERE id = ?`, [r.insertId, ctx.user.id, id]);

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


/**
 * The file a lead is being pointed at, or a refusal already sent.
 *
 * Open only. A closed or voided file is not somewhere a live lead lands, and
 * one already answering to another lead is refused here rather than by the
 * unique index, so the person picking gets a sentence instead of a database
 * error.
 */
async function openFileForLink(
  cid: number, roId: number, reply: { code: (n: number) => { send: (b: unknown) => unknown } }
): Promise<(RowDataPacket & { id: number; ro_number: string }) | null> {
  const file = await tqOne<RowDataPacket & {
    id: number; ro_number: string; close_date: string | null;
    closed_at: Date | null; voided_at: Date | null;
  }>(cid, `SELECT id, ro_number, close_date, closed_at, voided_at
           FROM repair_orders WHERE id = ?`, [roId]);
  if (!file) { reply.code(404).send({ error: 'No such repair order.' }); return null; }
  if (file.voided_at) {
    reply.code(400).send({ error: `RO ${file.ro_number} is voided.` });
    return null;
  }
  if (file.close_date || file.closed_at) {
    reply.code(400).send({
      error: `RO ${file.ro_number} is closed. A lead can only be linked to an open file.`
    });
    return null;
  }
  const taken = await tqOne<RowDataPacket & { lead_number: string }>(
    cid, 'SELECT lead_number FROM leads WHERE ro_id = ?', [roId]);
  if (taken) {
    reply.code(409).send({
      error: `RO ${file.ro_number} is already linked to lead ${taken.lead_number}.`
    });
    return null;
  }
  return file;
}

/*
 * Same rule the scheduler follows: an appointment is a clock face, so the
 * booking goes to MySQL as a `YYYY-MM-DD HH:MM:SS` string and is never turned
 * into a Date on the way in — that conversion is what shifted saved times.
 */
function wallClock(v: string): string | null {
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 09:00:00';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}:00` : null;
}
