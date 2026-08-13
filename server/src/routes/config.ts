import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { texec, tq } from '../db/tenant';
import { mq } from '../db/master';
import { requireCompany } from '../middleware/context';
import { primaryRole, Role, ROLE_LABEL, sortRoles } from '../permissions';

export async function registerShopConfig(app: FastifyInstance): Promise<void> {

  /** Statuses, lanes, positions, staff and settings — read on every screen. */
  app.get('/api/config', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;

    const [statuses, groups, lanes, positions, staff, settings] = await Promise.all([
      tq<RowDataPacket[]>(cid, `SELECT slot_id, group_id, lane_key, label, customer_label, kind, owner_role,
                                       age_yellow_hours, age_red_hours, follow_up_hours, module_tags,
                                       default_next, counts_toward_cycle, is_terminal, notify_customer, visible, sort_order
                                FROM statuses ORDER BY sort_order`),
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

  app.patch('/api/config/settings', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const body = req.body as Record<string, string>;
    for (const [k, v] of Object.entries(body)) {
      await texec(ctx.company!.id,
        `INSERT INTO shop_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [k, String(v)]
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
