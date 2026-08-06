import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { texec, tq, tqOne, withTenantTx } from '../db/tenant';
import { mexec, mq, mqOne } from '../db/master';
import { requireCompany } from '../middleware/context';
import { hashPassword } from '../auth/password';
import { Role, ROLE_LABEL } from '../permissions';
import crypto from 'node:crypto';

const ROLES: Role[] = ['owner', 'accounting', 'estimator', 'production_manager',
  'parts_manager', 'front_office', 'salesperson', 'technician'];

export async function registerAdmin(app: FastifyInstance): Promise<void> {

  /* ------------------------------------------------------------- people */

  app.post('/api/admin/people', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const b = req.body as {
      name: string; email?: string; role: Role; positionKey?: string;
      employeeCode?: string; useCode?: boolean; password?: string;
    };
    if (!b.name || !b.role) return reply.code(400).send({ error: 'Name and role are required.' });
    if (!ROLES.includes(b.role)) return reply.code(400).send({ error: 'Unknown role.' });
    if (!b.email && !b.useCode) return reply.code(400).send({ error: 'Give an email, or choose a sign-in code.' });

    const email = b.email ? b.email.trim().toLowerCase() : null;
    if (email) {
      const clash = await mqOne<RowDataPacket>('SELECT id FROM users WHERE email = ?', [email]);
      if (clash) {
        const already = await mqOne<RowDataPacket>(
          'SELECT 1 AS x FROM memberships WHERE user_id = ? AND company_id = ?',
          [(clash as RowDataPacket & { id: number }).id, ctx.company!.id]);
        if (already) return reply.code(409).send({ error: 'That person is already on this shop.' });
      }
    }

    let code: string | null = null;
    let tempPassword: string | null = null;

    if (b.useCode) {
      code = await uniqueCode();
    } else if (b.password && b.password.trim()) {
      tempPassword = b.password.trim();
      if (tempPassword.length < 6) {
        return reply.code(400).send({ error: 'A temporary password needs at least 6 characters.' });
      }
    } else {
      tempPassword = randomPassword(12);
    }

    const existing = email ? await mqOne<RowDataPacket & { id: number }>(
      'SELECT id FROM users WHERE email = ?', [email]) : null;

    let userId: number;
    if (existing) {
      userId = existing.id;
      if (code) await mexec('UPDATE users SET login_code = ? WHERE id = ?', [code, userId]);
    } else {
      const res = await mexec(
        `INSERT INTO users (email, password_hash, login_code, name, must_change_pw)
         VALUES (?, ?, ?, ?, ?)`,
        [email, tempPassword ? await hashPassword(tempPassword) : null, code, b.name, tempPassword ? 1 : 0]
      );
      userId = res.insertId;
    }

    await mexec(
      `INSERT INTO memberships (user_id, company_id, role, position_key) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), position_key = VALUES(position_key), status = 'active'`,
      [userId, ctx.company!.id, b.role, b.positionKey ?? null]
    );

    await texec(ctx.company!.id,
      `INSERT INTO staff (user_id, display_name, position_key, employee_code, active)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name),
         position_key = VALUES(position_key), employee_code = VALUES(employee_code), active = 1`,
      [userId, b.name, b.positionKey ?? null, b.employeeCode ?? null]
    );

    return { ok: true, userId, code, tempPassword };
  });

  app.patch('/api/admin/people/:userId', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const userId = Number((req.params as { userId: string }).userId);
    const b = req.body as {
      role?: Role; positionKey?: string | null; active?: boolean;
      name?: string; employeeCode?: string; commissionRate?: number;
    };

    if (b.role && !ROLES.includes(b.role)) return reply.code(400).send({ error: 'Unknown role.' });

    if (b.role !== undefined || b.positionKey !== undefined || b.active !== undefined) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (b.role !== undefined) { sets.push('role = ?'); vals.push(b.role); }
      if (b.positionKey !== undefined) { sets.push('position_key = ?'); vals.push(b.positionKey); }
      if (b.active !== undefined) { sets.push('status = ?'); vals.push(b.active ? 'active' : 'inactive'); }
      vals.push(userId, ctx.company!.id);
      await mexec(`UPDATE memberships SET ${sets.join(', ')} WHERE user_id = ? AND company_id = ?`, vals);
    }

    const tsets: string[] = [];
    const tvals: unknown[] = [];
    if (b.name !== undefined) { tsets.push('display_name = ?'); tvals.push(b.name); }
    if (b.positionKey !== undefined) { tsets.push('position_key = ?'); tvals.push(b.positionKey); }
    if (b.employeeCode !== undefined) { tsets.push('employee_code = ?'); tvals.push(b.employeeCode); }
    if (b.commissionRate !== undefined) { tsets.push('commission_rate = ?'); tvals.push(b.commissionRate); }
    if (b.active !== undefined) { tsets.push('active = ?'); tvals.push(b.active ? 1 : 0); }
    if (tsets.length) {
      tvals.push(userId);
      await texec(ctx.company!.id, `UPDATE staff SET ${tsets.join(', ')} WHERE user_id = ?`, tvals);
    }

    return { ok: true };
  });

  /** Issue a fresh sign-in code for someone. Testing convenience. */
  app.post('/api/admin/people/:userId/code', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const userId = Number((req.params as { userId: string }).userId);

    const mem = await mqOne<RowDataPacket>(
      'SELECT 1 AS x FROM memberships WHERE user_id = ? AND company_id = ?', [userId, ctx.company!.id]);
    if (!mem) return reply.code(404).send({ error: 'Not on this shop' });

    const code = await uniqueCode();
    await mexec(
      `UPDATE users SET login_code = ?, login_code_expires = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ?`,
      [code, userId]
    );
    return { ok: true, code };
  });

  /**
   * Reset a password. The owner may set one they choose — the shop hands it
   * over verbally — or let the app generate one. Either way the person must
   * change it at first sign-in, and every session they have is killed.
   */
  app.post('/api/admin/people/:userId/reset-password', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const userId = Number((req.params as { userId: string }).userId);
    const body = (req.body ?? {}) as { password?: string };

    const mem = await mqOne<RowDataPacket>(
      'SELECT 1 AS x FROM memberships WHERE user_id = ? AND company_id = ?', [userId, ctx.company!.id]);
    if (!mem) return reply.code(404).send({ error: 'Not on this shop' });

    let tempPassword: string;
    if (body.password && body.password.trim()) {
      tempPassword = body.password.trim();
      if (tempPassword.length < 6) {
        return reply.code(400).send({ error: 'A temporary password needs at least 6 characters.' });
      }
      if (tempPassword.length > 200) {
        return reply.code(400).send({ error: 'That password is too long.' });
      }
    } else {
      tempPassword = randomPassword(12);
    }

    await mexec(
      'UPDATE users SET password_hash = ?, must_change_pw = 1 WHERE id = ?',
      [await hashPassword(tempPassword), userId]
    );
    await mexec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);

    return { ok: true, tempPassword, chosen: !!(body.password && body.password.trim()) };
  });

  /**
   * Take someone off this shop. Their name stays on the work they did — the
   * history and the notes are the shop's record, not theirs — so this removes
   * the membership and deactivates the staff profile rather than deleting rows.
   * A user on no other shop is disabled outright.
   */
  app.delete('/api/admin/people/:userId', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const userId = Number((req.params as { userId: string }).userId);
    const cid = ctx.company!.id;

    if (userId === ctx.user.id) {
      return reply.code(400).send({ error: 'You cannot remove yourself.' });
    }

    const mem = await mqOne<RowDataPacket & { role: string }>(
      'SELECT role FROM memberships WHERE user_id = ? AND company_id = ?', [userId, cid]);
    if (!mem) return reply.code(404).send({ error: 'Not on this shop' });

    if (mem.role === 'owner') {
      const owners = await mqOne<RowDataPacket & { n: number }>(
        `SELECT COUNT(*) AS n FROM memberships
         WHERE company_id = ? AND role = 'owner' AND status = 'active'`, [cid]);
      if (Number(owners?.n ?? 0) <= 1) {
        return reply.code(400).send({ error: 'That is the only owner. Make someone else owner first.' });
      }
    }

    const openFiles = await tqOne<RowDataPacket & { n: number }>(cid,
      `SELECT COUNT(DISTINCT a.ro_id) AS n
       FROM ro_assignments a JOIN repair_orders r ON r.id = a.ro_id
       WHERE a.user_id = ? AND r.closed_at IS NULL`, [userId]);

    await mexec('DELETE FROM memberships WHERE user_id = ? AND company_id = ?', [userId, cid]);
    await mexec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND company_id = ?',
      [userId, cid]);

    await texec(cid, 'UPDATE staff SET active = 0 WHERE user_id = ?', [userId]);

    // Nowhere left to sign in to means the account is switched off entirely.
    const elsewhere = await mqOne<RowDataPacket & { n: number }>(
      'SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?', [userId]);
    const disabled = Number(elsewhere?.n ?? 0) === 0;
    if (disabled) {
      await mexec(
        `UPDATE users SET status = 'disabled', login_code = NULL, login_code_expires = NULL WHERE id = ?`,
        [userId]);
      await mexec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
        [userId]);
    }

    await texec(cid,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (?, ?, 'staff', ?, 'removed', ?)`,
      [ctx.user.id, ctx.user.name, userId,
       JSON.stringify({ openFiles: Number(openFiles?.n ?? 0), disabled })]
    );

    return {
      ok: true,
      disabled,
      openFiles: Number(openFiles?.n ?? 0)
    };
  });

  /** Put someone back on the shop after they were removed. */
  app.post('/api/admin/people/:userId/restore', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const userId = Number((req.params as { userId: string }).userId);
    const { role, positionKey } = req.body as { role: Role; positionKey?: string };
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'Unknown role.' });

    await mexec(
      `INSERT INTO memberships (user_id, company_id, role, position_key) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), position_key = VALUES(position_key), status = 'active'`,
      [userId, ctx.company!.id, role, positionKey ?? null]
    );
    await mexec(`UPDATE users SET status = 'active' WHERE id = ?`, [userId]);
    await texec(ctx.company!.id, 'UPDATE staff SET active = 1 WHERE user_id = ?', [userId]);

    return { ok: true };
  });

  /** People who were removed, so the owner can put one back. */
  app.get('/api/admin/people/removed', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const rows = await tq<RowDataPacket[]>(ctx.company!.id,
      `SELECT s.user_id, s.display_name, s.position_key, s.employee_code
       FROM staff s WHERE s.active = 0 ORDER BY s.display_name`);

    if (!rows.length) return { removed: [] };

    const ids = rows.map(r => r.user_id);
    const live = await mq<RowDataPacket[]>(
      'SELECT user_id FROM memberships WHERE company_id = ? AND user_id IN (?)',
      [ctx.company!.id, ids]);
    const liveSet = new Set(live.map(l => l.user_id));

    const users = await mq<RowDataPacket[]>(
      'SELECT id, name, email, status FROM users WHERE id IN (?)', [ids]);
    const byId = new Map(users.map(u => [u.id, u]));

    return {
      removed: rows.filter(r => !liveSet.has(r.user_id)).map(r => ({
        ...r,
        user: byId.get(r.user_id) ?? null
      }))
    };
  });

  app.get('/api/admin/roles', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    return { roles: ROLES.map(r => ({ key: r, label: ROLE_LABEL[r] })) };
  });

  /* ------------------------------------------------ notification groups */

  app.get('/api/admin/notification-groups', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;

    const [groups, members, subs] = await Promise.all([
      tq<RowDataPacket[]>(cid, 'SELECT id, name, description FROM notification_groups ORDER BY id'),
      tq<RowDataPacket[]>(cid, 'SELECT group_id, member_type, position_key, user_id FROM notification_group_members'),
      tq<RowDataPacket[]>(cid, `SELECT group_id, event_key, enabled, scope, channel_app, channel_email, channel_sms
                                FROM notification_subscriptions`)
    ]);

    const staff = await tq<RowDataPacket[]>(cid,
      'SELECT user_id, display_name, position_key FROM staff WHERE active = 1');

    return {
      groups: groups.map(g => ({
        ...g,
        positions: members.filter(m => m.group_id === g.id && m.member_type === 'position')
          .map(m => m.position_key),
        users: members.filter(m => m.group_id === g.id && m.member_type === 'user')
          .map(m => m.user_id),
        events: subs.filter(s => s.group_id === g.id)
      })),
      staff,
      events: [
        { key: 'status.change', label: 'Status changed' },
        { key: 'parts.arrived', label: 'Parts arrived' },
        { key: 'parts.late', label: 'Parts late or backordered' },
        { key: 'supp.decision', label: 'Supplement approved or denied' },
        { key: 'age.red', label: 'Sat too long in a status' },
        { key: 'assign.file', label: 'Assigned to me' },
        { key: 'sms.reply', label: 'Customer replied' }
      ]
    };
  });

  app.post('/api/admin/notification-groups', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const b = req.body as { name: string; description?: string };
    if (!b.name) return reply.code(400).send({ error: 'Name is required.' });
    const r = await texec(ctx.company!.id,
      'INSERT INTO notification_groups (name, description) VALUES (?, ?)',
      [b.name, b.description ?? null]);
    return { ok: true, id: r.insertId };
  });

  app.put('/api/admin/notification-groups/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as {
      name?: string; description?: string;
      positions?: string[]; users?: number[];
      events?: Array<{ key: string; enabled: boolean; scope?: string }>;
    };

    await withTenantTx(cid, async (c) => {
      if (b.name !== undefined || b.description !== undefined) {
        await c.query('UPDATE notification_groups SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?',
          [b.name ?? null, b.description ?? null, id]);
      }

      if (b.positions || b.users) {
        await c.query('DELETE FROM notification_group_members WHERE group_id = ?', [id]);
        for (const p of b.positions ?? []) {
          await c.query(
            `INSERT INTO notification_group_members (group_id, member_type, position_key, user_id)
             VALUES (?, 'position', ?, 0)`, [id, p]);
        }
        for (const u of b.users ?? []) {
          await c.query(
            `INSERT INTO notification_group_members (group_id, member_type, position_key, user_id)
             VALUES (?, 'user', NULL, ?)`, [id, u]);
        }
      }

      if (b.events) {
        for (const e of b.events) {
          await c.query(
            `INSERT INTO notification_subscriptions (group_id, event_key, enabled, scope, channel_app)
             VALUES (?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), scope = VALUES(scope)`,
            [id, e.key, e.enabled ? 1 : 0, e.scope ?? 'owned']);
        }
      }
    });

    return { ok: true };
  });

  app.delete('/api/admin/notification-groups/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    await texec(ctx.company!.id, 'DELETE FROM notification_groups WHERE id = ?',
      [Number((req.params as { id: string }).id)]);
    return { ok: true };
  });
}

async function uniqueCode(): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 20; i++) {
    const code = Array.from(crypto.randomBytes(6)).map(b => alphabet[b % alphabet.length]).join('');
    const clash = await mqOne<RowDataPacket>('SELECT id FROM users WHERE login_code = ?', [code]);
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique code.');
}

function randomPassword(len = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len)).map(b => alphabet[b % alphabet.length]).join('');
}
