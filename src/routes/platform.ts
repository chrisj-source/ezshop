import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mexec, mq, mqOne } from '../db/master';
import { destroyCompany, provisionCompany } from '../db/provision';
import { invalidateFeatures, requirePlatformOwner, requireRoot } from '../middleware/context';
import { hashPassword, randomPassword } from '../auth/password';
import { revokeAllForUser } from '../auth/session';
import { config } from '../config';
import { demoCompany, resetDemo, setDemoTesterPassword } from '../lib/demo';
import { mailHealth } from '../lib/mail';
import { revokeAllForCompany, switchSessionCompany } from '../auth/session';
import { forgetTenant } from '../db/tenant';
import { ShopType } from '../db/status-template';

export async function registerPlatform(app: FastifyInstance): Promise<void> {

  /** Who is looking, and what the box will let them do today. */
  app.get('/api/platform/me', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const demo = await demoCompany();
    return {
      role: ctx.platformRole,
      isRoot: ctx.platformRole === 'root',
      /* Shown on the platform screen so it is obvious whether the break-glass
         door is standing open. */
      rootEnabled: config.rootEnabled,
      /* Email cannot report its own outage by email, so it reports here. */
      mail: mailHealth(),
      demo: demo ? {
        companyId: demo.id, name: demo.name, slug: demo.slug,
        resetAt: demo.demo_reset_at ?? null
      } : null
    };
  });

  /* ------------------------------------------------- platform people (root) */

  /**
   * Platform admins. Root's alone, deliberately: an admin who could make
   * another admin is an admin who could keep themselves in after being removed.
   */
  app.get('/api/platform/people', async (req, reply) => {
    const ctx = requireRoot(req, reply);
    if (!ctx) return;
    const rows = await mq<RowDataPacket[]>(
      `SELECT id, name, email, platform_role, status, last_login_at, created_at
         FROM users WHERE platform_role <> 'none' ORDER BY platform_role DESC, name`);
    return {
      people: rows.map(r => ({
        id: r.id, name: r.name, email: r.email, role: r.platform_role,
        status: r.status, lastLogin: r.last_login_at, createdAt: r.created_at,
        /* Root is not removable and not demotable — including by itself. */
        locked: r.platform_role === 'root'
      }))
    };
  });

  app.post('/api/platform/people', async (req, reply) => {
    const ctx = requireRoot(req, reply);
    if (!ctx) return;
    const b = req.body as { name?: string; email?: string; password?: string };
    const name = String(b.name ?? '').trim();
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!name || !email) return reply.code(400).send({ error: 'A name and an email are required.' });

    const existing = await mqOne<RowDataPacket>('SELECT id, platform_role FROM users WHERE email = ?', [email]);
    const password = b.password?.trim() || randomPassword();

    let userId: number;
    if (existing) {
      /* Somebody who already works in a shop can be given the platform too;
         their shop access is untouched. */
      userId = Number(existing.id);
      await mexec(
        `UPDATE users SET platform_role = 'admin', is_platform_owner = 1 WHERE id = ?`, [userId]);
    } else {
      const res = await mexec(
        `INSERT INTO users (email, password_hash, name, is_platform_owner, platform_role, must_change_pw)
         VALUES (?, ?, ?, 1, 'admin', 1)`,
        [email, await hashPassword(password), name]);
      userId = res.insertId;
    }

    await audit(ctx.user.id, null, 'platform.admin.added', { userId, email, existing: !!existing });
    return {
      ok: true, userId,
      tempPassword: existing ? null : password,
      note: existing
        ? `${email} already had an account; they are a platform admin now.`
        : 'Created. The password is shown once, and they must change it at first sign-in.'
    };
  });

  /** Take the platform off somebody. Their shop access, if any, stays. */
  app.delete('/api/platform/people/:id', async (req, reply) => {
    const ctx = requireRoot(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);

    const who = await mqOne<RowDataPacket>('SELECT id, name, email, platform_role FROM users WHERE id = ?', [id]);
    if (!who) return reply.code(404).send({ error: 'Nobody by that id.' });
    if (who.platform_role === 'root') {
      return reply.code(400).send({ error: 'Root cannot be removed. That is what makes it root.' });
    }

    await mexec(`UPDATE users SET platform_role = 'none', is_platform_owner = 0 WHERE id = ?`, [id]);
    /* Removing the platform from somebody who is signed in should take effect
       now, not whenever their session happens to expire. */
    await revokeAllForUser(id);
    await audit(ctx.user.id, null, 'platform.admin.removed', { userId: id, email: who.email });
    return { ok: true, note: `${who.name} is no longer a platform admin, and is signed out.` };
  });

  /** A new password for a platform admin, shown once. */
  app.post('/api/platform/people/:id/password', async (req, reply) => {
    const ctx = requireRoot(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const who = await mqOne<RowDataPacket>('SELECT id, name, platform_role FROM users WHERE id = ?', [id]);
    if (!who) return reply.code(404).send({ error: 'Nobody by that id.' });

    const password = String((req.body as { password?: string })?.password ?? '').trim() || randomPassword();
    await mexec('UPDATE users SET password_hash = ?, must_change_pw = 1 WHERE id = ?',
      [await hashPassword(password), id]);
    await revokeAllForUser(id);
    await audit(ctx.user.id, null, 'platform.admin.password', { userId: id });
    return { ok: true, password, note: 'Shown once. Every session they had has ended.' };
  });

  /* ------------------------------------------------------------- the demo */

  /**
   * Put the demo shop back to its seed. Anything a visitor did to it goes.
   * Refuses any company not marked `is_demo`, so this can never be pointed at
   * a real shop by passing an id.
   */
  app.post('/api/platform/demo/reset', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    try {
      const out = await resetDemo(ctx.user.id);
      await audit(ctx.user.id, out.companyId, 'demo.reset', { by: 'button' });
      return out;
    } catch (e) {
      req.log.error(e);
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * The Tester password, changed before each demo. Generated here and shown
   * once rather than typed, so it is never something that was reused.
   */
  app.post('/api/platform/demo/tester-password', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const wanted = String((req.body as { password?: string })?.password ?? '').trim();
    try {
      const out = await setDemoTesterPassword(wanted || null);
      await audit(ctx.user.id, out.companyId, 'demo.tester.password', {});
      return out;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/platform/companies', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;

    const rows = await mq<Array<RowDataPacket>>(
      `SELECT c.id, c.slug, c.name, c.city, c.state, c.shop_type, c.plan_code, c.status,
              c.seats, c.owner_email, c.created_at, c.provisioned_at,
              cd.db_name, cd.schema_version,
              (SELECT COUNT(*) FROM memberships m WHERE m.company_id = c.id AND m.status = 'active') AS user_count
       FROM companies c
       LEFT JOIN company_databases cd ON cd.company_id = c.id
       WHERE c.status <> 'closed'
       ORDER BY c.name`
    );

    const plans = await mq<RowDataPacket[]>('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order');
    return { companies: rows, plans };
  });

  app.get('/api/platform/companies/:id', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);

    const company = await mqOne<RowDataPacket>(
      `SELECT c.*, cd.db_name, cd.db_host, cd.schema_version, cd.migrated_at
       FROM companies c LEFT JOIN company_databases cd ON cd.company_id = c.id
       WHERE c.id = ?`, [id]
    );
    if (!company) return reply.code(404).send({ error: 'No such company' });

    const features = await mq<RowDataPacket[]>(
      `SELECT f.feature_key, f.label, f.description, f.is_core, f.is_available,
              f.requires_key, f.default_on, f.sort_order,
              COALESCE(cf.enabled, f.default_on) AS enabled
       FROM features f
       LEFT JOIN company_features cf ON cf.feature_key = f.feature_key AND cf.company_id = ?
       ORDER BY f.sort_order`, [id]
    );

    const users = await mq<RowDataPacket[]>(
      `SELECT u.id, u.name, u.email, u.last_login_at, m.role, m.position_key, m.status
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? ORDER BY m.role, u.name`, [id]
    );

    return { company, features, users };
  });

  app.post('/api/platform/companies', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;

    const b = req.body as {
      name: string; slug: string; city?: string; state?: string; timezone?: string;
      shopType: ShopType; planCode?: string; seats?: number;
      ownerName: string; ownerEmail: string; ownerPassword?: string;
    };

    if (!b.name || !b.slug || !b.ownerEmail || !b.ownerName) {
      return reply.code(400).send({ error: 'Name, slug, owner name and owner email are required.' });
    }

    try {
      const out = await provisionCompany({ ...b, actorUserId: ctx.user.id });
      return out;
    } catch (e) {
      req.log.error(e);
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Delete a shop and its database. Root's alone — an admin may suspend one,
   * which is reversible, and that is the difference between the two jobs.
   * The slug has to be typed to confirm, because a click is not enough.
   */
  app.delete('/api/platform/companies/:id', async (req, reply) => {
    const ctx = requireRoot(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const typed = String((req.body as { slug?: string })?.slug ?? '').trim().toLowerCase();

    const co = await mqOne<RowDataPacket>('SELECT id, slug, name FROM companies WHERE id = ?', [id]);
    if (!co) return reply.code(404).send({ error: 'No such shop' });
    if (typed !== String(co.slug)) {
      return reply.code(400).send({ error: `Type the slug (${co.slug}) to confirm.` });
    }

    await revokeAllForCompany(id);
    forgetTenant(id);
    await destroyCompany(id);
    await mexec('DELETE FROM companies WHERE id = ?', [id]);
    await audit(ctx.user.id, null, 'company.deleted', { slug: co.slug, name: co.name });
    return { ok: true, note: `${co.name} and its database are gone.` };
  });

  app.patch('/api/platform/companies/:id', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as Record<string, unknown>;

    const allowed: Record<string, string> = {
      name: 'name', city: 'city', state: 'state', timezone: 'timezone',
      planCode: 'plan_code', seats: 'seats', ownerEmail: 'owner_email', shopType: 'shop_type'
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(allowed)) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(b[k]); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await mexec(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`, vals);
    await audit(ctx.user.id, id, 'company.updated', b);
    return { ok: true };
  });

  /** Switch a company off or back on. Data is untouched; every session dies. */
  app.post('/api/platform/companies/:id/status', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const { status, note } = req.body as { status: 'active' | 'trial' | 'suspended'; note?: string };

    if (!['active', 'trial', 'suspended'].includes(status)) {
      return reply.code(400).send({ error: 'Unknown status' });
    }

    await mexec(
      `UPDATE companies SET status = ?, suspended_at = ?, suspended_note = ? WHERE id = ?`,
      [status, status === 'suspended' ? new Date() : null, status === 'suspended' ? (note ?? null) : null, id]
    );

    if (status === 'suspended') {
      await revokeAllForCompany(id);
      forgetTenant(id);
    }

    await audit(ctx.user.id, id, `company.${status}`, { note });
    return { ok: true, status };
  });

  app.post('/api/platform/companies/:id/features/:key', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const key = (req.params as { key: string }).key;
    const { enabled } = req.body as { enabled: boolean };

    const f = await mqOne<RowDataPacket & { is_core: number; is_available: number }>(
      'SELECT is_core, is_available FROM features WHERE feature_key = ?', [key]
    );
    if (!f) return reply.code(404).send({ error: 'No such feature' });
    if (f.is_core) return reply.code(400).send({ error: 'That feature is core to the product.' });
    if (!f.is_available) return reply.code(400).send({ error: 'That feature is not available yet.' });

    await mexec(
      `INSERT INTO company_features (company_id, feature_key, enabled, updated_by)
       VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_by = VALUES(updated_by)`,
      [id, key, enabled ? 1 : 0, ctx.user.id]
    );

    invalidateFeatures(id);
    await audit(ctx.user.id, id, 'feature.toggled', { key, enabled });
    return { ok: true };
  });

  /** Drop into a shop. The session is flagged so the UI can say so. */
  app.post('/api/platform/companies/:id/enter', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);

    const c = await mqOne<RowDataPacket & { status: string }>('SELECT status FROM companies WHERE id = ?', [id]);
    if (!c) return reply.code(404).send({ error: 'No such company' });

    const mem = await mqOne<RowDataPacket>(
      'SELECT 1 AS x FROM memberships WHERE user_id = ? AND company_id = ?', [ctx.user.id, id]
    );

    await switchSessionCompany(ctx.sessionId, id, !mem);
    await audit(ctx.user.id, id, mem ? 'company.entered' : 'company.impersonated', null);
    return { ok: true, companyId: id, impersonating: !mem };
  });

  app.get('/api/platform/audit', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const rows = await mq<RowDataPacket[]>(
      `SELECT a.*, u.name AS actor_name, c.name AS company_name
       FROM platform_audit a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN companies c ON c.id = a.company_id
       ORDER BY a.id DESC LIMIT 200`
    );
    return { events: rows };
  });
}

async function audit(actor: number, companyId: number | null, action: string, detail: unknown): Promise<void> {
  await mexec(
    `INSERT INTO platform_audit (actor_user_id, company_id, action, detail) VALUES (?, ?, ?, ?)`,
    [actor, companyId, action, detail ? JSON.stringify(detail) : null]
  );
}
