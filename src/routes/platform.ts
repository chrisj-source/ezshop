import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mexec, mq, mqOne } from '../db/master';
import { provisionCompany } from '../db/provision';
import { invalidateFeatures, requirePlatformOwner } from '../middleware/context';
import { revokeAllForCompany, switchSessionCompany } from '../auth/session';
import { forgetTenant } from '../db/tenant';
import { ShopType } from '../db/status-template';

export async function registerPlatform(app: FastifyInstance): Promise<void> {

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
