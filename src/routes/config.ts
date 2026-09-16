import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { texec, tq } from '../db/tenant';
import { mq } from '../db/master';
import { requireCompany } from '../middleware/context';
import { primaryRole, Role, ROLE_LABEL, sortRoles } from '../permissions';
import { holidaysFor } from '../lib/holidays';

export async function registerShopConfig(app: FastifyInstance): Promise<void> {

  /** Statuses, lanes, positions, staff and settings — read on every screen. */
  app.get('/api/config', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;

    const [statuses, groups, lanes, positions, staff, settings] = await Promise.all([
      /* sort_order restarts at 1 in every group, so it only orders slots within
         their group. Ordering by it alone interleaved the groups on the Status
         Setup screen — same class of bug as the board's Complete filter. */
      tq<RowDataPacket[]>(cid, `SELECT s.slot_id, s.group_id, s.lane_key, s.label, s.customer_label, s.kind,
                                       s.owner_role, s.age_yellow_hours, s.age_red_hours, s.follow_up_hours,
                                       s.module_tags, s.default_next, s.counts_toward_cycle, s.is_terminal,
                                       s.notify_customer, s.visible, s.sort_order
                                FROM statuses s
                                JOIN status_groups g ON g.group_id = s.group_id
                                ORDER BY g.sort_order, s.sort_order`),
      tq<RowDataPacket[]>(cid, `SELECT group_id, label, sort_order, note FROM status_groups ORDER BY sort_order`),
      tq<RowDataPacket[]>(cid, `SELECT lane_key, label, enabled, parts_gate, owner_role, module_tag, sort_order
                                FROM lanes ORDER BY sort_order`),
      tq<RowDataPacket[]>(cid, `SELECT position_key, label, category, owner_role, enabled, sort_order
                                FROM positions WHERE enabled = 1 ORDER BY sort_order`),
      tq<RowDataPacket[]>(cid, `SELECT user_id, display_name, position_key, employee_code, active
                                FROM staff WHERE active = 1 ORDER BY display_name`),
      tq<RowDataPacket[]>(cid, `SELECT setting_key, setting_value FROM shop_settings`)
    ]);

    /* Trades are a set. Every screen that offers a person for a lane reads this. */
    const trades = await tq<Array<RowDataPacket & { user_id: number; position_key: string }>>(
      cid, `SELECT user_id, position_key FROM staff_positions ORDER BY sort_order, position_key`
    ).catch(() => []);
    for (const s of staff) {
      const mine = trades.filter(t => t.user_id === s.user_id).map(t => t.position_key);
      (s as RowDataPacket & { position_keys: string[] }).position_keys =
        mine.length ? mine : (s.position_key ? [s.position_key as string] : []);
    }

    const settingsMap: Record<string, string | null> = {};
    for (const s of settings) settingsMap[s.setting_key as string] = s.setting_value as string | null;

    return {
      company: {
        id: ctx.company!.id, name: ctx.company!.name,
        shopType: ctx.company!.shop_type, timezone: ctx.company!.timezone
      },
      statuses, groups, lanes, positions, staff,
      settings: settingsMap,
      features: [...ctx.features],
      caps: ctx.caps,
      role: ctx.role,
      roles: ctx.roles,
      positionKey: ctx.positionKey,
      positionKeys: ctx.positionKeys
    };
  });

  /** Rename a status or retune its clocks. slot_id is never editable. */
  app.patch('/api/config/statuses/:slot', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const slot = (req.params as { slot: string }).slot;
    const b = req.body as Record<string, unknown>;

    const allowed: Record<string, string> = {
      label: 'label', customerLabel: 'customer_label', ownerRole: 'owner_role',
      ageYellowHours: 'age_yellow_hours', ageRedHours: 'age_red_hours',
      followUpHours: 'follow_up_hours', defaultNext: 'default_next',
      countsTowardCycle: 'counts_toward_cycle', notifyCustomer: 'notify_customer',
      visible: 'visible', sortOrder: 'sort_order'
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(allowed)) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(b[k]); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    if (b.ownerRole !== undefined) sets.push('owner_is_override = 1');
    vals.push(slot);

    await texec(ctx.company!.id, `UPDATE statuses SET ${sets.join(', ')} WHERE slot_id = ?`, vals);
    await texec(ctx.company!.id,
      `INSERT INTO audit_log (user_id, user_name, entity, action, detail) VALUES (?, ?, 'status', 'updated', ?)`,
      [ctx.user.id, ctx.user.name, JSON.stringify({ slot, ...b })]
    );
    return { ok: true };
  });

  app.patch('/api/config/lanes/:key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const key = (req.params as { key: string }).key;
    const { enabled, partsGate, label } = req.body as { enabled?: boolean; partsGate?: string; label?: string };

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (enabled !== undefined) { sets.push('enabled = ?'); vals.push(enabled ? 1 : 0); }
    if (partsGate !== undefined) { sets.push('parts_gate = ?'); vals.push(partsGate); }
    if (label !== undefined) { sets.push('label = ?'); vals.push(label); }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(key);
    await texec(ctx.company!.id, `UPDATE lanes SET ${sets.join(', ')} WHERE lane_key = ?`, vals);
    return { ok: true };
  });

  /**
   * Settings are a key/value table, which is the right shape — but it means a
   * typo writes a row nobody notices and a bad number silently falls back to a
   * default somewhere else in the code. "Twelve" is not 12, and the screen that
   * reads it would quietly use its own default forever.
   *
   * So the keys whose shape is knowable are checked here, and anything not in
   * the table passes through unvalidated as before. Deliberately a pass-through
   * rather than an allowlist: several screens write their own keys and refusing
   * an unknown one would break them for the sake of tidiness.
   */
  const SETTING_RULES: Record<string, { kind: 'int' | 'flag' | 'enum';
    min?: number; max?: number; values?: string[]; label: string }> = {
    sales_require_address:   { kind: 'flag', label: 'Require the address on a sales write-up' },
    sales_require_drop:      { kind: 'flag', label: 'Require a drop-off day' },
    sales_onboard_red_hours: { kind: 'int', min: 1, max: 168,
      label: 'Hours before an un-chased sales lead goes red' },
    sales_onboard_clock:     { kind: 'enum', values: ['actual', 'shop'], label: 'Onboarding clock' },
    lead_chase_hours:        { kind: 'int', min: 1, max: 2160,
      label: 'Hours of silence before flagging a lead' },
    lead_followup_days:      { kind: 'int', min: 1, max: 90, label: 'Days of silence before flagging' },
    lead_appointment_window_days: { kind: 'int', min: 1, max: 365,
      label: 'How far ahead a booking counts' },
    tech_sees_own_only:      { kind: 'flag', label: 'Technicians see only their own files' }
  };

  function checkSetting(key: string, raw: string): string | null {
    const rule = SETTING_RULES[key];
    if (!rule) return null;
    const v = String(raw).trim();

    if (rule.kind === 'flag') {
      return v === '0' || v === '1' ? null : `${rule.label} must be on or off.`;
    }
    if (rule.kind === 'enum') {
      return (rule.values ?? []).includes(v) ? null
        : `${rule.label} must be one of: ${(rule.values ?? []).join(', ')}.`;
    }
    if (!/^-?\d+$/.test(v)) return `${rule.label} must be a whole number.`;
    const n = Number(v);
    if (rule.min !== undefined && n < rule.min) return `${rule.label} cannot be below ${rule.min}.`;
    if (rule.max !== undefined && n > rule.max) return `${rule.label} cannot be above ${rule.max}.`;
    return null;
  }

  /**
   * The shop's open hours, one row per weekday.
   *
   * Its own endpoint rather than more key/value settings: seven days with an
   * open time, a close time and a closed flag is a table, and squeezing it into
   * comma-separated strings is how `closed_days` ended up unable to express
   * "we shut at noon on Saturday".
   */
  app.get('/api/config/hours', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const rows = await tq<RowDataPacket[]>(ctx.company!.id,
      'SELECT dow, open_time, close_time, closed FROM shop_hours ORDER BY dow').catch(() => []);
    return { hours: rows, timezone: ctx.company!.timezone };
  });

  app.put('/api/config/hours', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const body = req.body as { hours?: Array<{ dow: number; open: string; close: string; closed: boolean }> };
    const days = Array.isArray(body.hours) ? body.hours : [];
    if (days.length !== 7) return reply.code(400).send({ error: 'Seven days are needed.' });

    const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const time = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

    /* Checked before anything is written, so a bad time on Thursday cannot
       leave Monday to Wednesday saved. */
    for (const d of days) {
      const n = NAMES[d.dow] ?? 'That day';
      if (!time.test(String(d.open)) || !time.test(String(d.close))) {
        return reply.code(400).send({ error: `${n}: times must be HH:MM.`, field: 'dow' + d.dow });
      }
      /* Closed days keep their times — a shop that shuts Saturdays for winter
         gets its hours back in spring rather than retyping them — so this only
         applies to a day that is actually open. */
      if (!d.closed && String(d.close) <= String(d.open)) {
        return reply.code(400).send({
          error: `${n}: closing time has to be after opening time. An overnight shift is not ` +
                 'something the scheduler can express yet.',
          field: 'dow' + d.dow
        });
      }
    }

    for (const d of days) {
      await texec(ctx.company!.id,
        `INSERT INTO shop_hours (dow, open_time, close_time, closed) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE open_time = VALUES(open_time),
           close_time = VALUES(close_time), closed = VALUES(closed)`,
        [d.dow, String(d.open).length === 5 ? d.open + ':00' : d.open,
         String(d.close).length === 5 ? d.close + ':00' : d.close, d.closed ? 1 : 0]);
    }

    /* `closed_days` is still read by the drop-capacity screen, so it is kept in
       step rather than left to drift into a second, wronger answer. */
    const closedNames = days.filter(d => d.closed)
      .map(d => (NAMES[d.dow] ?? '').toLowerCase()).filter(Boolean).join(',');
    await texec(ctx.company!.id,
      `INSERT INTO shop_settings (setting_key, setting_value) VALUES ('closed_days', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [closedNames]);

    return { ok: true };
  });

  /**
   * Holidays and one-off closures.
   *
   * The holiday dates are COMPUTED per year (lib/holidays) rather than stored,
   * because Thanksgiving is the fourth Thursday in November, not a date. What
   * is stored is which ones this shop observes, keyed by a name that survives
   * into next year, plus whatever dates somebody typed themselves.
   */
  app.get('/api/config/closures', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const year = Number((req.query as { year?: string }).year) || new Date().getFullYear();

    const prefs = await tq<RowDataPacket[]>(cid,
      'SELECT holiday_key, observed, kind, open_time, close_time FROM shop_holiday_prefs')
      .catch(() => []);
    const byKey = new Map(prefs.map(p => [String(p.holiday_key), p]));

    const holidays = holidaysFor(year).map(h => {
      const p = byKey.get(h.key);
      return {
        ...h,
        observed: p ? Number(p.observed) === 1 : false,
        kind: p ? String(p.kind) : (h.typical === 'half' ? 'hours' : 'closed'),
        open: p?.open_time ? String(p.open_time).slice(0, 5) : '08:00',
        close: p?.close_time ? String(p.close_time).slice(0, 5) : '12:00'
      };
    });

    /* Manual dates only — the holiday-sourced rows are represented above, and
       showing them twice would invite somebody to delete one half. */
    const manual = await tq<RowDataPacket[]>(cid,
      `SELECT DATE_FORMAT(on_date, '%Y-%m-%d') AS on_date, kind, open_time, close_time, label
         FROM shop_closures
        WHERE source = 'manual' AND YEAR(on_date) = ?
        ORDER BY on_date`, [year]).catch(() => []);

    return { year, holidays, manual };
  });

  app.put('/api/config/closures', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const cid = ctx.company!.id;
    const b = req.body as {
      year?: number;
      holidays?: Array<{ key: string; observed: boolean; kind: string; open?: string; close?: string }>;
      manual?: Array<{ date: string; kind: string; open?: string; close?: string; label?: string }>;
    };
    const year = Number(b.year) || new Date().getFullYear();
    const time = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;

    for (const m of b.manual ?? []) {
      if (!dateRe.test(String(m.date))) {
        return reply.code(400).send({ error: `"${m.date}" is not a date.` });
      }
      if (m.kind === 'hours') {
        if (!time.test(String(m.open)) || !time.test(String(m.close))) {
          return reply.code(400).send({ error: `${m.date}: a half day needs both times.` });
        }
        if (String(m.close) <= String(m.open)) {
          return reply.code(400).send({ error: `${m.date}: closing has to be after opening.` });
        }
      }
    }

    const all = holidaysFor(year);
    const t = (v?: string) => (v && v.length === 5 ? v + ':00' : v ?? null);

    for (const h of b.holidays ?? []) {
      const def = all.find(x => x.key === h.key);
      if (!def) continue;

      await texec(cid,
        `INSERT INTO shop_holiday_prefs (holiday_key, observed, kind, open_time, close_time)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE observed = VALUES(observed), kind = VALUES(kind),
           open_time = VALUES(open_time), close_time = VALUES(close_time)`,
        [h.key, h.observed ? 1 : 0, h.kind === 'hours' ? 'hours' : 'closed',
         t(h.open), t(h.close)]);

      if (h.observed) {
        await texec(cid,
          `INSERT INTO shop_closures (on_date, kind, open_time, close_time, label, source, holiday_key)
           VALUES (?, ?, ?, ?, ?, 'holiday', ?)
           ON DUPLICATE KEY UPDATE kind = VALUES(kind), open_time = VALUES(open_time),
             close_time = VALUES(close_time), label = VALUES(label),
             source = 'holiday', holiday_key = VALUES(holiday_key)`,
          [def.date, h.kind === 'hours' ? 'hours' : 'closed',
           h.kind === 'hours' ? t(h.open) : null, h.kind === 'hours' ? t(h.close) : null,
           def.label, h.key]);
      } else {
        /* Un-ticking removes only the holiday row. A manual closure somebody
           typed on the same date is theirs and survives. */
        await texec(cid,
          `DELETE FROM shop_closures WHERE on_date = ? AND source = 'holiday'`, [def.date]);
      }
    }

    if (Array.isArray(b.manual)) {
      await texec(cid,
        `DELETE FROM shop_closures WHERE source = 'manual' AND YEAR(on_date) = ?`, [year]);
      for (const m of b.manual) {
        await texec(cid,
          `INSERT INTO shop_closures (on_date, kind, open_time, close_time, label, source)
           VALUES (?, ?, ?, ?, ?, 'manual')
           ON DUPLICATE KEY UPDATE kind = VALUES(kind), open_time = VALUES(open_time),
             close_time = VALUES(close_time), label = VALUES(label), source = 'manual'`,
          [m.date, m.kind === 'hours' ? 'hours' : 'closed',
           m.kind === 'hours' ? t(m.open) : null, m.kind === 'hours' ? t(m.close) : null,
           (m.label || 'Closed').slice(0, 80)]);
      }
    }

    return { ok: true };
  });

  app.patch('/api/config/settings', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const body = req.body as Record<string, string>;

    /* Every value checked BEFORE anything is written, so a bad figure in one
       field does not leave the other five saved and the screen half-right. */
    for (const [k, v] of Object.entries(body)) {
      const problem = checkSetting(k, v);
      if (problem) return reply.code(400).send({ error: problem, field: k });
    }

    for (const [k, v] of Object.entries(body)) {
      await texec(ctx.company!.id,
        `INSERT INTO shop_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [k, String(v).trim()]
      );
    }
    return { ok: true };
  });

  /** The shop's people: master identity joined to the tenant-side profile. */
  app.get('/api/config/people', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const members = await mq<RowDataPacket[]>(
      `SELECT u.id, u.name, u.email, u.status AS user_status, u.last_login_at,
              m.role, m.position_key, m.status AS membership_status
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? ORDER BY u.name`,
      [ctx.company!.id]
    );

    const heldRoles = await mq<Array<RowDataPacket & { user_id: number; role_key: Role }>>(
      `SELECT user_id, role_key FROM membership_roles WHERE company_id = ?`,
      [ctx.company!.id]
    ).catch(() => []);

    const profiles = await tq<RowDataPacket[]>(ctx.company!.id,
      `SELECT user_id, display_name, position_key, employee_code, efficiency, commission_rate, active FROM staff`);

    const trades = await tq<Array<RowDataPacket & { user_id: number; position_key: string }>>(
      ctx.company!.id,
      `SELECT user_id, position_key FROM staff_positions ORDER BY sort_order, position_key`
    ).catch(() => []);

    const byId = new Map(profiles.map(p => [p.user_id as number, p]));
    return {
      people: members.map(m => {
        const id = m.id as number;
        const held = heldRoles.filter(r => r.user_id === id).map(r => r.role_key);
        const mine = trades.filter(t => t.user_id === id).map(t => t.position_key);
        const roles = sortRoles(held.length ? held : [m.role as Role]);
        const positionKeys = mine.length
          ? mine
          : (m.position_key ? [m.position_key as string] : []);
        return {
          ...m,
          role: primaryRole(roles) ?? m.role,
          roles,
          roleLabels: roles.map(r => ROLE_LABEL[r]),
          positionKeys,
          profile: byId.get(id) ?? null,
          commission_rate: ctx.caps.money ? byId.get(id)?.commission_rate ?? null : undefined
        };
      })
    };
  });
}
