import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { pushAppointment } from './gcal';
import { atShopWallClock, closedReason, nextOpen, shopCalendar } from '../lib/shophours';
import { wallClock } from '../lib/shoptime';

const KINDS = ['drop', 'pickup', 'return', 'estimate', 'appraiser', 'sublet'] as const;
export type Kind = typeof KINDS[number];

const KIND_LABEL: Record<Kind, string> = {
  drop: 'Drop off', pickup: 'Pick up', return: 'Return',
  estimate: 'Estimate', appraiser: 'Appraiser',
  /* Out to a vendor, not a customer movement — it shares the table because it
     is still a car leaving on a date somebody has to remember. */
  sublet: 'Out to sublet'
};

export async function registerScheduler(app: FastifyInstance): Promise<void> {

  app.get('/api/schedule-meta', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const settings = await tq<RowDataPacket[]>(ctx.company!.id,
      "SELECT setting_key, setting_value FROM shop_settings WHERE setting_key LIKE 'cap_%' OR setting_key IN ('closed_days','week_start')");
    const map: Record<string, string> = {};
    for (const s of settings) map[s.setting_key as string] = String(s.setting_value ?? '');

    return {
      kinds: KINDS.map(k => ({ key: k, label: KIND_LABEL[k], cap: Number(map['cap_' + k] ?? 0) })),
      closedDays: (map.closed_days ?? '').split(',').map(s => s.trim()).filter(Boolean),
      weekStart: map.week_start || 'monday',
      canOverbook: ctx.role === 'owner',
      canEditTimeOff: ctx.role === 'owner'
    };
  });

  /** A week of appointments plus each day's remaining capacity. */
  app.get('/api/schedule', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'sched', reply)) return;

    const q = req.query as { from?: string; days?: string };
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : today();
    const days = Math.min(Math.max(Number(q.days ?? 7), 1), 31);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT a.*, r.ro_number, l.lead_number,
             CONCAT_WS(' ', v.year, v.make, v.model) AS ro_vehicle,
             s.label AS status_label
      FROM appointments a
      LEFT JOIN repair_orders r ON r.id = a.ro_id
      LEFT JOIN leads l ON l.id = a.lead_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      LEFT JOIN statuses s ON s.slot_id = r.status_slot
      WHERE a.cancelled_at IS NULL
        AND a.starts_at >= ? AND a.starts_at < DATE_ADD(?, INTERVAL ? DAY)
      ORDER BY a.starts_at`,
      [from, from, days]
    );

    const caps = await tq<RowDataPacket[]>(ctx.company!.id,
      "SELECT setting_key, setting_value FROM shop_settings WHERE setting_key LIKE 'cap_%'");
    const cap: Record<string, number> = {};
    for (const c of caps) cap[String(c.setting_key).replace('cap_', '')] = Number(c.setting_value ?? 0);

    const used: Record<string, Record<string, number>> = {};
    for (const a of rows) {
      const day = isoDay(a.starts_at as Date);
      used[day] = used[day] ?? {};
      used[day][a.kind as string] = (used[day][a.kind as string] ?? 0) + 1;
    }

    const timeOff = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, user_id, display_name, starts_on, ends_on, start_time, end_time, reason,
             created_name, created_at
      FROM employee_time_off
      WHERE cancelled_at IS NULL
        AND starts_on < DATE_ADD(?, INTERVAL ? DAY) AND ends_on >= ?
      ORDER BY starts_on, display_name`,
      [from, days, from]
    );

    return { from, days, appointments: rows, capacity: cap, used, timeOff };
  });

  /** Days with room, so a rep on the road knows what to promise. */
  app.get('/api/schedule/openings', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const q = req.query as { kind?: string; days?: string };
    const kind = (KINDS as readonly string[]).includes(q.kind ?? '') ? q.kind as Kind : 'drop';
    const days = Math.min(Math.max(Number(q.days ?? 14), 1), 60);

    const capRow = await tqOne<RowDataPacket & { setting_value: string }>(ctx.company!.id,
      'SELECT setting_value FROM shop_settings WHERE setting_key = ?', ['cap_' + kind]);
    const cap = Number(capRow?.setting_value ?? 0);

    const closedRow = await tqOne<RowDataPacket & { setting_value: string }>(ctx.company!.id,
      "SELECT setting_value FROM shop_settings WHERE setting_key = 'closed_days'");
    const closed = String(closedRow?.setting_value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT DATE(starts_at) AS day, COUNT(*) AS n
      FROM appointments
      WHERE cancelled_at IS NULL AND kind = ?
        AND starts_at >= CURDATE() AND starts_at < DATE_ADD(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(starts_at)`, [kind, days]);

    const byDay: Record<string, number> = {};
    for (const r of rows) byDay[isoDay(r.day as Date)] = Number(r.n);

    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const out: Array<{ day: string; weekday: string; used: number; cap: number; open: number; closed: boolean }> = [];

    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() + i);
      const iso = localDay(d);
      const weekday = names[d.getDay()];
      const isClosed = closed.includes(weekday);
      const usedN = byDay[iso] ?? 0;
      out.push({
        day: iso, weekday, used: usedN, cap,
        open: isClosed ? 0 : Math.max(0, cap - usedN),
        closed: isClosed
      });
    }

    return { kind, capacity: cap, days: out };
  });

  /**
   * Book something. Two rules from the shop floor: the daily cap is enforced
   * for everyone but the owner, and an estimate appointment or an unrecognised
   * drop raises a lead so nothing walks in unrecorded.
   */
  app.post('/api/schedule', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'sched', reply)) return;

    const cid = ctx.company!.id;
    const b = req.body as {
      kind: Kind; startsAt: string; durationMin?: number;
      roId?: number | null; leadId?: number | null;
      customerName: string; vehicleText?: string; phone?: string; note?: string;
      assignedUserId?: number | null;
      override?: boolean;
      /* Transport company on a pickup or return; the vendor on a sublet. */
      carrier?: string;
      /* Sublet only: when the vendor says it is coming back. */
      dueBack?: string;
    };

    if (!(KINDS as readonly string[]).includes(b.kind)) {
      return reply.code(400).send({ error: 'Unknown appointment type.' });
    }
    if (!b.startsAt) return reply.code(400).send({ error: 'A date and time are required.' });
    if (!b.customerName?.trim()) return reply.code(400).send({ error: 'A name is required.' });

    const when = wallClock(b.startsAt);
    if (!when) return reply.code(400).send({ error: 'That date is not valid.' });

    const day = when.slice(0, 10);
    const assignedUserId = b.assignedUserId ?? null;

    /* Shop hours, the day's limit for this kind, and the person's own day — all
       three, in one place, shared with the move path. See `scheduleGuards`. */
    const guard = await scheduleGuards({
      cid, tz: ctx.company!.timezone, kind: b.kind, when,
      durationMin: b.durationMin ?? 30, assignedUserId,
      ignoreApptId: null, isOwner: ctx.role === 'owner', override: !!b.override
    });
    if ('refuse' in guard) return reply.code(409).send(guard.refuse);
    const overrideNote = guard.note;
    const result = await withTenantTx(cid, async (c) => {
      const [r] = await c.query<ResultSetHeader>(`
        INSERT INTO appointments
          (kind, starts_at, duration_min, ro_id, lead_id, customer_name, vehicle_text, phone, note,
           created_by, assigned_user_id, override_note, carrier, due_back)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.kind, when, b.durationMin ?? 30, b.roId ?? null, b.leadId ?? null,
         b.customerName.trim(), b.vehicleText ?? null, b.phone ?? null, b.note ?? null,
         ctx.user.id, assignedUserId, overrideNote,
         /* Who is carrying the car: a transport company on a pickup, the vendor
            on a sublet. Free text — a sublet vendor is usually a shop down the
            road that will never be a row in this database. */
         (b.carrier ?? '').trim() || null,
         /* Sublet only. Null is the honest "nobody has said yet". */
         b.kind === 'sublet' ? (b.dueBack || null) : null]);

      const apptId = r.insertId;
      let leadId: number | null = b.leadId ?? null;

      // An estimate booking is a lead by definition. So is a drop for a car we
      // have never seen — that is the gap the shop kept losing work through.
      const shouldRaise = !leadId && !b.roId && (b.kind === 'estimate' || b.kind === 'drop');

      if (shouldRaise) {
        const [seq] = await c.query<RowDataPacket[]>(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(lead_number, 2) AS UNSIGNED)), 0) + 1 AS n FROM leads`);
        const num = 'L' + String(Number(seq[0].n ?? 1)).padStart(5, '0');

        const name = b.customerName.trim().split(/\s+/);
        const [l] = await c.query<ResultSetHeader>(`
          INSERT INTO leads
            (lead_number, source, state, first_name, last_name, phone, vehicle_text,
             damage_note, owner_user_id, appointment_id)
          VALUES (?, 'scheduler', 'appraisal_booked', ?, ?, ?, ?, ?, ?, ?)`,
          [num, name.length > 1 ? name[0] : null, name[name.length - 1],
           b.phone ?? null, b.vehicleText ?? null, b.note ?? null, ctx.user.id, apptId]);

        leadId = l.insertId;

        await c.query(
          `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
          [leadId,
           `Raised from a ${KIND_LABEL[b.kind].toLowerCase()} booked for ${day}.`,
           ctx.user.id, ctx.user.name]);

        await c.query('UPDATE appointments SET lead_id = ? WHERE id = ?', [leadId, apptId]);
      }

      if (b.roId) {
        await c.query(
          `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
          [b.roId, `${KIND_LABEL[b.kind]} booked for ${day}.`, ctx.user.id, ctx.user.name]);
      }

      return { id: apptId, leadId };
    });

    // Google is push only and best effort: a calendar that is down must not
    // stop a booking being taken at the counter.
    pushAppointment(cid, result.id, 'save').catch(() => {});

    return { ok: true, overrode: overrideNote, ...result };
  });

  app.patch('/api/schedule/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as Record<string, unknown>;

    const map: Record<string, string> = {
      startsAt: 'starts_at', durationMin: 'duration_min', customerName: 'customer_name',
      vehicleText: 'vehicle_text', phone: 'phone', note: 'note', kind: 'kind'
    };

    /**
     * A move has to answer the same questions a booking does.
     *
     * This wrote the new time and stopped — no hours, no daily limit, no check
     * of the person's own day — so every rule the shop sets could be walked
     * around by booking something legal and dragging the card. The guards are
     * re-run whenever anything they depend on moves: the time, the kind (which
     * decides which daily limit applies) or the duration.
     */
    const existing = await tqOne<RowDataPacket & {
      kind: Kind; starts_at: Date | string; duration_min: number;
      assigned_user_id: number | null; override_note: string | null;
    }>(ctx.company!.id,
      `SELECT kind, starts_at, duration_min, assigned_user_id, override_note
         FROM appointments WHERE id = ? AND cancelled_at IS NULL`, [id]);
    if (!existing) return reply.code(404).send({ error: 'That appointment no longer exists.' });

    let moveTo: string | null = null;
    let guardNote: string | null = null;

    if (b.startsAt !== undefined) {
      moveTo = wallClock(String(b.startsAt));
      if (!moveTo) return reply.code(400).send({ error: 'That date is not valid.' });
    }

    const kindNow = (b.kind === undefined ? existing.kind : b.kind) as Kind;
    if (!(KINDS as readonly string[]).includes(kindNow)) {
      return reply.code(400).send({ error: 'Unknown appointment type.' });
    }

    if (b.startsAt !== undefined || b.kind !== undefined || b.durationMin !== undefined) {
      /* The stored value is a clock face; the pool hands it back as a Date in
         UTC, so it is read back as a string rather than converted. */
      const whenNow = moveTo ?? storedWallClock(existing.starts_at);
      const guard = await scheduleGuards({
        cid: ctx.company!.id, tz: ctx.company!.timezone, kind: kindNow, when: whenNow,
        durationMin: Number(b.durationMin ?? existing.duration_min ?? 30),
        assignedUserId: existing.assigned_user_id,
        /* Its own row must not count against the day's limit or clash with
           itself when it is the thing being moved. */
        ignoreApptId: id,
        isOwner: ctx.role === 'owner', override: !!b.override,
        moving: true
      });
      if ('refuse' in guard) return reply.code(409).send(guard.refuse);
      guardNote = guard.note;
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'startsAt' ? moveTo : b[k]);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    /* Appended rather than replaced: a card moved onto somebody's day off and
       then moved again outside hours has two things worth explaining. */
    if (guardNote) {
      sets.push('override_note = ?');
      vals.push(((existing.override_note ? existing.override_note + ' ' : '') + guardNote).slice(0, 255));
    }

    vals.push(id);
    await texec(ctx.company!.id, `UPDATE appointments SET ${sets.join(', ')} WHERE id = ?`, vals);
    pushAppointment(ctx.company!.id, id, 'save').catch(() => {});
    return { ok: true, overrode: guardNote };
  });

  app.delete('/api/schedule/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const id = Number((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'No appointment id.' });

    const res = await texec(ctx.company!.id,
      'UPDATE appointments SET cancelled_at = NOW() WHERE id = ? AND cancelled_at IS NULL', [id]);

    // A cancel that quietly changed nothing is the bug we just fixed; say so
    // rather than returning ok and leaving the card on the board.
    if (!res.affectedRows) {
      const gone = await tqOne<RowDataPacket>(ctx.company!.id,
        'SELECT id, cancelled_at FROM appointments WHERE id = ?', [id]);
      if (!gone) return reply.code(404).send({ error: 'That appointment no longer exists.' });
      return { ok: true, alreadyCancelled: true };
    }

    pushAppointment(ctx.company!.id, id, 'cancel').catch(() => {});
    return { ok: true };
  });

  /* ------------------------------------------------------ employee time off */

  /** Blocks in a window, for the scheduler's availability layer. */
  app.get('/api/time-off', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const q = req.query as { from?: string; days?: string };
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : today();
    const days = Math.min(Math.max(Number(q.days ?? 60), 1), 366);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, user_id, display_name, starts_on, ends_on, start_time, end_time, reason,
             created_name, created_at
      FROM employee_time_off
      WHERE cancelled_at IS NULL
        AND starts_on < DATE_ADD(?, INTERVAL ? DAY) AND ends_on >= ?
      ORDER BY starts_on, display_name`, [from, days, from]);

    return { from, days, timeOff: rows, canEdit: ctx.role === 'owner' };
  });

  /**
   * Block time out for someone. Owner only. A range of days, optionally
   * narrowed to hours within each day. Work already booked into the window
   * does not stop the block — it is listed back and can be overridden.
   */
  app.post('/api/time-off', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (ctx.role !== 'owner') return reply.code(403).send({ error: 'Owner only' });

    const cid = ctx.company!.id;
    const b = req.body as {
      userId: number; displayName?: string;
      startsOn: string; endsOn?: string;
      startTime?: string | null; endTime?: string | null;
      reason?: string; override?: boolean;
    };

    if (!b.userId) return reply.code(400).send({ error: 'Pick who is off.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.startsOn ?? '')) {
      return reply.code(400).send({ error: 'A first day is required.' });
    }

    const endsOn = /^\d{4}-\d{2}-\d{2}$/.test(b.endsOn ?? '') ? b.endsOn! : b.startsOn;
    if (endsOn < b.startsOn) return reply.code(400).send({ error: 'The last day is before the first.' });

    const startTime = b.startTime || null;
    const endTime = b.endTime || null;
    if (startTime && endTime && endTime <= startTime) {
      return reply.code(400).send({ error: 'The end time is before the start time.' });
    }

    const staff = await tqOne<RowDataPacket & { display_name: string }>(cid,
      'SELECT display_name FROM staff WHERE user_id = ?', [b.userId]);
    const name = (b.displayName || staff?.display_name || 'Employee').slice(0, 120);

    // What is already booked inside the window, so the owner sees it before
    // committing rather than discovering it on the day.
    const booked = await tq<RowDataPacket[]>(cid, `
      SELECT a.id, a.kind, a.starts_at, a.customer_name
      FROM appointments a
      WHERE a.cancelled_at IS NULL AND a.assigned_user_id = ?
        AND DATE(a.starts_at) BETWEEN ? AND ?
        ${startTime && endTime ? 'AND TIME(a.starts_at) < ? AND TIME(a.starts_at) >= ?' : ''}
      ORDER BY a.starts_at`,
      startTime && endTime ? [b.userId, b.startsOn, endsOn, endTime, startTime]
                           : [b.userId, b.startsOn, endsOn]);

    if (booked.length && !b.override) {
      return reply.code(409).send({
        error: `${name} has ${booked.length} appointment${booked.length === 1 ? '' : 's'} ` +
          'inside that window.',
        conflict: true, canOverride: true,
        clashes: booked.map(a => ({
          id: a.id,
          text: `${KIND_LABEL[a.kind as Kind]} for ${a.customer_name} on ${isoDay(a.starts_at as Date)}`
        }))
      });
    }

    const res = await texec(cid, `
      INSERT INTO employee_time_off
        (user_id, display_name, starts_on, ends_on, start_time, end_time, reason,
         created_by, created_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.userId, name, b.startsOn, endsOn, startTime, endTime,
       (b.reason ?? '').slice(0, 120) || null, ctx.user.id, ctx.user.name]);

    if (booked.length) {
      await texec(cid, `
        INSERT INTO audit_log (user_id, user_name, entity, action, detail)
        VALUES (?, ?, 'time_off', 'booked over', ?)`,
        [ctx.user.id, ctx.user.name,
         JSON.stringify({ timeOffId: res.insertId, user: name, appointments: booked.map(a => a.id) })]);
    }

    return { ok: true, id: res.insertId, overrode: booked.length };
  });

  app.delete('/api/time-off/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (ctx.role !== 'owner') return reply.code(403).send({ error: 'Owner only' });

    const id = Number((req.params as { id: string }).id);
    const res = await texec(ctx.company!.id,
      'UPDATE employee_time_off SET cancelled_at = NOW() WHERE id = ? AND cancelled_at IS NULL', [id]);
    if (!res.affectedRows) return reply.code(404).send({ error: 'That block is already gone.' });
    return { ok: true };
  });
}

/**
 * Every shop-level rule a time has to pass, in one place: the shop's hours, the
 * daily limit for that kind, and the person's own day.
 *
 * It is one function because booking and moving are the same act, and they had
 * drifted into two different answers — the move path checked none of it, so a
 * shop's hours, its day limits and its time-off blocks were all enforced on the
 * way in and ignored the moment somebody dragged the card. Every rule here is
 * set at shop level (`shop_hours`, `shop_closures`, `shop_settings.cap_*`,
 * `employee_time_off`) and read from there rather than assumed.
 *
 * Warn-and-override rather than refuse outright, throughout: shops genuinely do
 * take a car in early as a favour, and a scheduler that makes that impossible
 * gets worked around with a note instead. What was overridden is returned as a
 * sentence to record on the appointment, so the day can be explained later.
 *
 * Returns either the refusal to send back or the note to keep — never both.
 */
export async function scheduleGuards(opts: {
  cid: number; tz: string; kind: Kind; when: string; durationMin: number;
  assignedUserId: number | null; ignoreApptId: number | null;
  isOwner: boolean; override: boolean; moving?: boolean;
}): Promise<{ refuse: Record<string, unknown> } | { note: string | null }> {
  const {
    cid, tz, kind, when, durationMin, assignedUserId,
    ignoreApptId, isOwner, override, moving
  } = opts;
  const day = when.slice(0, 10);
  const verb = moving ? 'Moved' : 'Booked';
  const said: string[] = [];

  /* The TIME, not just the day. An appointment at 9am has to mean 9am, and 9am
     on a day the shop is shut is not a time. The conversion into an instant is
     the shop timezone's job — `new Date(when)` reads it in the SERVER's zone,
     which put a 10am Plano booking at 5am and refused it as before opening. */
  const cal = await shopCalendar(cid, tz);
  const at = atShopWallClock(when, tz);
  const why = at ? closedReason(cal, at) : null;

  if (why) {
    if (!override) {
      const opens = at ? nextOpen(cal, at) : null;
      return {
        refuse: {
          error: `That time is outside shop hours — ${why}.`,
          outsideHours: true,
          canOverride: true,
          nextOpen: opens ? opens.toISOString() : null
        }
      };
    }
    said.push(`${verb} outside shop hours (${why}).`);
  }

  /* The day's limit for this kind. Owner-only override, as it has always been —
     a full day is the shop's own decision about how much work it can take. */
  const capRow = await tqOne<RowDataPacket & { setting_value: string }>(cid,
    'SELECT setting_value FROM shop_settings WHERE setting_key = ?', ['cap_' + kind]);
  const cap = Number(capRow?.setting_value ?? 0);

  if (cap > 0) {
    const [cnt] = await tq<RowDataPacket[]>(cid, `
      SELECT COUNT(*) AS n FROM appointments
      WHERE cancelled_at IS NULL AND kind = ? AND DATE(starts_at) = ?
        AND (? IS NULL OR id <> ?)`, [kind, day, ignoreApptId, ignoreApptId]);
    const used = Number(cnt.n ?? 0);

    if (used >= cap) {
      if (!isOwner || !override) {
        return {
          refuse: {
            error: `${day} is full for ${KIND_LABEL[kind].toLowerCase()}s — ${used} of ${cap} booked.`,
            full: true, used, cap,
            canOverride: isOwner
          }
        };
      }
      said.push(`${verb} past the daily limit of ${cap} (${used} already booked).`);
    }
  }

  /* The person's own day: their other bookings, and any time they are off. */
  if (assignedUserId) {
    const clashes = await conflictsFor(cid, assignedUserId, when, durationMin, ignoreApptId);
    if (clashes.length) {
      if (!override) {
        return {
          refuse: {
            error: clashes.map(c => c.text).join(' '),
            conflict: true, clashes, canOverride: true
          }
        };
      }
      said.push(clashes.map(c => c.text).join(' '));
    }
  }

  return { note: said.length ? said.join(' ').slice(0, 255) : null };
}

/**
 * The clock face of a `starts_at` the pool read back.
 *
 * Both pools run in UTC, so a DATETIME comes back as a Date whose UTC fields
 * ARE the stored wall clock. Reading it as a string keeps it that way; letting
 * it through `toLocaleString` or a bare `new Date()` comparison is what moved
 * saved times.
 */
function storedWallClock(v: Date | string): string {
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  return String(v).slice(0, 19).replace('T', ' ');
}

/**
 * Everything that collides with putting `userId` to work at `when`: their own
 * bookings and any time they are off. Returned as sentences, because the modal
 * that shows them is a warning the owner reads, not a machine check.
 */
async function conflictsFor(
  cid: number, userId: number, when: string, durationMin: number, ignoreApptId: number | null
): Promise<Array<{ kind: string; text: string }>> {
  const day = when.slice(0, 10);
  const out: Array<{ kind: string; text: string }> = [];

  const off = await tq<RowDataPacket[]>(cid, `
    SELECT display_name, starts_on, ends_on, start_time, end_time, reason
    FROM employee_time_off
    WHERE cancelled_at IS NULL AND ? BETWEEN starts_on AND ends_on
      AND (start_time IS NULL OR end_time IS NULL OR (TIME(?) >= start_time AND TIME(?) < end_time))`,
    [day, when, when]);

  for (const o of off) {
    out.push({
      kind: 'time_off',
      text: `${o.display_name} is off ${isoDay(o.starts_on as Date)}` +
        (isoDay(o.ends_on as Date) !== isoDay(o.starts_on as Date) ? ` to ${isoDay(o.ends_on as Date)}` : '') +
        (o.start_time ? ` (${String(o.start_time).slice(0, 5)}–${String(o.end_time).slice(0, 5)})` : '') +
        (o.reason ? ` — ${o.reason}` : '') + '.'
    });
  }

  const overlap = await tq<RowDataPacket[]>(cid, `
    SELECT id, kind, starts_at, duration_min, customer_name
    FROM appointments
    WHERE cancelled_at IS NULL AND assigned_user_id = ?
      AND (? IS NULL OR id <> ?)
      AND starts_at < DATE_ADD(?, INTERVAL ? MINUTE)
      AND DATE_ADD(starts_at, INTERVAL duration_min MINUTE) > ?`,
    [userId, ignoreApptId, ignoreApptId, when, durationMin, when]);

  for (const a of overlap) {
    out.push({
      kind: 'appointment',
      text: `Already booked: ${KIND_LABEL[a.kind as Kind]} for ${a.customer_name} at ` +
        `${wallTime(a.starts_at as Date)}.`
    });
  }

  return out;
}

function today(): string {
  return localDay(new Date());
}

/** A day built from a Date's own local fields — for dates this process made. */
function localDay(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/*
 * The clock-face rule this file follows lives in `lib/shoptime.ts` as
 * `wallClock()`, shared with the lead booking path.
 */

/** The stored clock face of a DATETIME the pool read back as UTC. */
function wallTime(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(11, 16) : String(d).slice(11, 16);
}

/** The stored day of a DATETIME the pool read back as UTC. */
function isoDay(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}
