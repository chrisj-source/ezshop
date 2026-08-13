import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { COOKIE_NAME } from '../config';
import { mq, mqOne } from '../db/master';
import { tq, tqOne } from '../db/tenant';
import { loadSession } from '../auth/session';
import { Caps, capsFor, capsForRoles, primaryRole, Role, sortRoles } from '../permissions';

export interface UserRow extends RowDataPacket {
  id: number; email: string | null; name: string;
  is_platform_owner: number; status: string; must_change_pw: number;
}

export interface CompanyRow extends RowDataPacket {
  id: number; slug: string; name: string; shop_type: string;
  status: string; plan_code: string; timezone: string;
}

export interface Ctx {
  sessionId: string;
  user: UserRow;
  isPlatformOwner: boolean;
  impersonating: boolean;
  company: CompanyRow | null;
  /** Primary role — the highest-ranked one held. Display and notifications. */
  role: Role | null;
  /** Every role held. Permissions are the union of these. */
  roles: Role[];
  /** The trade this person is listed under. */
  positionKey: string | null;
  /** Every trade they work. */
  positionKeys: string[];
  caps: Caps;
  features: Set<string>;
}

declare module 'fastify' {
  interface FastifyRequest { ctx?: Ctx; }
}

const NO_CAPS: Caps = capsFor('technician', { techSeesOwnOnly: true });

/**
 * Resolves the cookie into a user, their company and that company's feature
 * set. Attaches to request.ctx. Does not reject — guards do that.
 */
export async function attachContext(req: FastifyRequest): Promise<void> {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return;

  const sess = await loadSession(unsigned.value);
  if (!sess) return;

  const user = await mqOne<UserRow>(
    `SELECT id, email, name, is_platform_owner, status, must_change_pw FROM users WHERE id = ?`,
    [sess.user_id]
  );
  if (!user || user.status !== 'active') return;

  let company: CompanyRow | null = null;
  let role: Role | null = null;
  let roles: Role[] = [];
  let positionKey: string | null = null;
  let positionKeys: string[] = [];
  let caps = NO_CAPS;
  const features = new Set<string>();

  if (sess.company_id) {
    company = await mqOne<CompanyRow>(
      `SELECT id, slug, name, shop_type, status, plan_code, timezone FROM companies WHERE id = ?`,
      [sess.company_id]
    );

    if (company && company.status !== 'suspended' && company.status !== 'closed') {
      const mem = await mqOne<RowDataPacket & { role: Role; position_key: string | null; status: string }>(
        `SELECT role, position_key, status FROM memberships WHERE user_id = ? AND company_id = ?`,
        [user.id, company.id]
      );

      if (mem && mem.status === 'active') {
        /* membership_roles is the truth; memberships.role is the fallback for a
           database that has not run the migration yet. */
        const held = await mq<Array<RowDataPacket & { role_key: Role }>>(
          `SELECT role_key FROM membership_roles WHERE user_id = ? AND company_id = ?`,
          [user.id, company.id]
        ).catch(() => []);
        roles = sortRoles(held.length ? held.map(r => r.role_key) : [mem.role]);
        role = primaryRole(roles);
        positionKey = mem.position_key;
      } else if (user.is_platform_owner && sess.impersonating) {
        roles = ['owner'];
        role = 'owner';
      }

      if (role) {
        const setting = await tqOne<RowDataPacket & { setting_value: string }>(
          company.id, `SELECT setting_value FROM shop_settings WHERE setting_key = 'tech_sees_own_only'`
        ).catch(() => null);
        caps = capsForRoles(roles, { techSeesOwnOnly: setting?.setting_value !== '0' });

        /* Trades are a set: staff_positions is the truth, staff.position_key the
           seed and the trade they are listed under. */
        const trades = await tq<Array<RowDataPacket & { position_key: string }>>(
          company.id,
          `SELECT position_key FROM staff_positions WHERE user_id = ? ORDER BY sort_order, position_key`,
          [user.id]
        ).catch(() => []);
        positionKeys = trades.length
          ? trades.map(t => t.position_key)
          : (positionKey ? [positionKey] : []);
        if (!positionKey && positionKeys.length) positionKey = positionKeys[0];

        for (const f of await companyFeatures(company.id)) features.add(f);
      }
    } else if (company && company.status === 'suspended' && !user.is_platform_owner) {
      company = null;
    }
  }

  req.ctx = {
    sessionId: sess.id,
    user,
    isPlatformOwner: user.is_platform_owner === 1,
    impersonating: sess.impersonating === 1,
    company,
    role,
    roles,
    positionKey,
    positionKeys,
    caps,
    features
  };
}

interface FeatureRow extends RowDataPacket {
  feature_key: string; is_core: number; is_available: number;
  requires_key: string | null; default_on: number; enabled: number | null;
}

const featureCache = new Map<number, { at: number; keys: string[] }>();
const FEATURE_TTL = 60_000;

export async function companyFeatures(companyId: number): Promise<string[]> {
  const hit = featureCache.get(companyId);
  if (hit && Date.now() - hit.at < FEATURE_TTL) return hit.keys;

  const rows = await mq<FeatureRow[]>(
    `SELECT f.feature_key, f.is_core, f.is_available, f.requires_key, f.default_on, cf.enabled
     FROM features f
     LEFT JOIN company_features cf ON cf.feature_key = f.feature_key AND cf.company_id = ?
     ORDER BY f.sort_order`,
    [companyId]
  );

  const own = new Map<string, boolean>();
  for (const r of rows) {
    if (!r.is_available) { own.set(r.feature_key, false); continue; }
    if (r.is_core) { own.set(r.feature_key, true); continue; }
    own.set(r.feature_key, r.enabled === null ? r.default_on === 1 : r.enabled === 1);
  }

  // dependency cascade: a feature is off if what it requires is off
  const resolve = (key: string, seen = new Set<string>()): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (!own.get(key)) return false;
    const row = rows.find(r => r.feature_key === key);
    if (row?.requires_key) return resolve(row.requires_key, seen);
    return true;
  };

  const keys = rows.map(r => r.feature_key).filter(k => resolve(k));
  featureCache.set(companyId, { at: Date.now(), keys });
  return keys;
}

export function invalidateFeatures(companyId: number): void {
  featureCache.delete(companyId);
}

/* ------------------------------------------------------------------ guards */

export function requireUser(req: FastifyRequest, reply: FastifyReply): Ctx | null {
  if (!req.ctx) { void reply.code(401).send({ error: 'Not signed in' }); return null; }
  return req.ctx;
}

export function requireCompany(req: FastifyRequest, reply: FastifyReply): Ctx | null {
  const ctx = requireUser(req, reply);
  if (!ctx) return null;
  if (!ctx.company) { void reply.code(403).send({ error: 'No company selected' }); return null; }
  if (!ctx.role) { void reply.code(403).send({ error: 'No access to this company' }); return null; }
  return ctx;
}

export function requirePlatformOwner(req: FastifyRequest, reply: FastifyReply): Ctx | null {
  const ctx = requireUser(req, reply);
  if (!ctx) return null;
  if (!ctx.isPlatformOwner) { void reply.code(403).send({ error: 'Platform access required' }); return null; }
  return ctx;
}

export function requireFeature(ctx: Ctx, key: string, reply: FastifyReply): boolean {
  if (ctx.features.has(key)) return true;
  void reply.code(404).send({ error: 'Not available' });
  return false;
}

export function requireCap(ctx: Ctx, cap: keyof Caps, reply: FastifyReply): boolean {
  if (ctx.caps[cap]) return true;
  void reply.code(403).send({ error: 'Not permitted' });
  return false;
}

export async function registerContext(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req) => { await attachContext(req); });
}
