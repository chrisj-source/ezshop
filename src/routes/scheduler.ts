import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { pushAppointment } from './gcal';

const KINDS = ['drop', 'pickup', 'return', 'estimate', 'appraiser'] as const;
type Kind = typeof KINDS[number];

const KIND_LABEL: Record<Kind, string> = {
  drop: 'Drop off', pickup: 'Pick up', return: 'Return',
  estimate: 'Estimate', appraiser: 'Appraiser'
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
      const iso = isoDay(d);
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
    };

    if (!(KINDS as readonly string[]).includes(b.kind)) {
      return reply.code(400).send({ error: 'Unknown appointment type.' });
    }
    if (!b.startsAt) return reply.code(400).send({ error: 'A date and time are required.' });
    if (!b.customerName?.trim()) return reply.code(400).send({ error: 'A name is required.' });

    const when = new Date(b.startsAt.length === 10 ? b.startsAt + 'T09:00' : b.startsAt);
    if (isNaN(when.getTime())) return reply.code(400).send({ error: 'That date is not valid.' });

    const day = isoDay(when);

    const capRow = await tqOne<RowDataPacket & { setting_value: string }>(cid,
      'SELECT setting_value FROM shop_settings WHERE setting_key = ?', ['cap_' + b.kind]);
    const cap = Number(capRow?.setting_value ?? 0);

    if (cap > 0) {
      const [cnt] = await tq<RowDataPacket[]>(cid, `
        SELECT COUNT(*) AS n FROM appointments
        WHERE cancelled_at IS NULL AND kind = ? AND DATE(starts_at) = ?`, [b.kind, day]);
      const used = Number(cnt.n ?? 0);

      if (used >= cap) {
        const isOwner = ctx.role === 'owner';
        if (!isOwner || !b.override) {
          return reply.code(409).send({
            error: `${day} is full for ${KIND_LABEL[b.kind].toLowerCase()}s — ${used} of ${cap} booked.`,
            full: true, used, cap,
            canOverride: isOwner
          });
        }
      }
    }

    // Booking onto a person who is off, or on top of their own booking, warns
    // and can be overridden — it never refuses. What was overridden is written
    // onto the appointment so the day can be explained later.
    const assignedUserId = b.assignedUserId ?? null;
    let overrideNote: string | null = null;

    if (assignedUserId) {
      const clashes = await conflictsFor(cid, assignedUserId, when, b.durationMin ?? 30, null);
      if (clashes.length) {
        if (!b.override) {
          return reply.code(409).send({
            error: clashes.map(c => c.text).join(' '),
            conflict: true, clashes, canOverride: true
          });
        }
        overrideNote = clashes.map(c => c.text).join(' ').slice(0, 255);
      }
    }

    const result = await withTenantTx(cid, async (c) => {
      const [r] = await c.query<ResultSetHeader>(`
        INSERT INTO appointments
          (kind, starts_at, duration_min, ro_id, lead_id, customer_name, vehicle_text, phone, note,
           created_by, assigned_user_id, override_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.kind, when, b.durationMin ?? 30, b.roId ?? null, b.leadId ?? null,
         b.customerName.trim(), b.vehicleText ?? null, b.phone ?? null, b.note ?? null,
         ctx.user.id, assignedUserId, overrideNote]);

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
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'startsAt' ? new Date(String(b[k])) : b[k]);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await texec(ctx.company!.id, `UPDATE appointments SET ${sets.join(', ')} WHERE id = ?`, vals);
    pushAppointment(ctx.company!.id, id, 'save').catch(() => {});
    return { ok: true };
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
 * Everything that collides with putting `userId` to work at `when`: their own
 * bookings and any time they are off. Returned as sentences, because the modal
 * that shows them is a warning the owner reads, not a machine check.
 */
async function conflictsFor(
  cid: number, userId: number, when: Date, durationMin: number, ignoreApptId: number | null
): Promise<Array<{ kind: string; text: string }>> {
  const day = isoDay(when);
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
        `${new Date(a.starts_at as Date).toTimeString().slice(0, 5)}.`
    });
  }

  return out;
}

function today(): string {
  const d = new Date();
  return isoDay(d);
}

function isoDay(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
