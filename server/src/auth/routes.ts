import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { COOKIE_NAME, config } from '../config';
import { mexec, mq, mqOne } from '../db/master';
import { hashPassword, passwordProblem, verifyPassword } from './password';
import { createSession, revokeAllForUser, revokeSession, switchSessionCompany } from './session';
import { companyFeatures, requireUser } from '../middleware/context';
import { ROLE_LABEL, Role, capsFor } from '../permissions';

interface LoginUser extends RowDataPacket {
  id: number; email: string | null; password_hash: string | null; login_code: string | null;
  login_code_expires: Date | null; name: string; is_platform_owner: number;
  status: string; must_change_pw: number; failed_logins: number; locked_until: Date | null;
}

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export async function registerAuth(app: FastifyInstance): Promise<void> {

  /** Sign in with email + password, or with a short code during testing. */
  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string; code?: string };
    const ip = req.ip;
    const ua = req.headers['user-agent'] ?? '';

    let user: LoginUser | null = null;

    if (body.code) {
      user = await mqOne<LoginUser>(
        `SELECT * FROM users
         WHERE login_code = ? AND status = 'active'
           AND (login_code_expires IS NULL OR login_code_expires > NOW())`,
        [body.code.trim().toUpperCase()]
      );
      if (!user) return reply.code(401).send({ error: 'That code is not valid.' });
    } else {
      const email = (body.email ?? '').trim().toLowerCase();
      const password = body.password ?? '';
      if (!email || !password) return reply.code(400).send({ error: 'Email and password are required.' });

      user = await mqOne<LoginUser>('SELECT * FROM users WHERE email = ?', [email]);

      // constant-ish time: hash anyway when the user is missing
      const stored = user?.password_hash ?? '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';
      const ok = await verifyPassword(stored, password);

      if (!user || !ok || user.status !== 'active') {
        if (user) {
          await mexec(
            `UPDATE users SET failed_logins = failed_logins + 1,
               locked_until = IF(failed_logins + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), locked_until)
             WHERE id = ?`,
            [MAX_FAILED, LOCK_MINUTES, user.id]
          );
        }
        return reply.code(401).send({ error: 'Those details do not match an account.' });
      }

      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
      }
    }

    const memberships = await mq<Array<RowDataPacket & { company_id: number; role: Role; name: string; status: string; company_status: string }>>(
      `SELECT m.company_id, m.role, m.status, c.name, c.status AS company_status
       FROM memberships m JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = ? AND m.status = 'active'
       ORDER BY c.name`,
      [user.id]
    );

    const usable = memberships.filter(m => m.company_status !== 'suspended' && m.company_status !== 'closed');
    const companyId = usable.length === 1 ? usable[0].company_id : null;

    const sid = await createSession(user.id, companyId, { ip, userAgent: String(ua) });

    reply.setCookie(COOKIE_NAME, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      signed: true,
      maxAge: config.sessionDays * 24 * 3600
    });

    return {
      user: { id: user.id, name: user.name, email: user.email, mustChangePassword: user.must_change_pw === 1 },
      isPlatformOwner: user.is_platform_owner === 1,
      companies: usable.map(m => ({ id: m.company_id, name: m.name, role: m.role, roleLabel: ROLE_LABEL[m.role] })),
      companyId,
      suspended: memberships.filter(m => m.company_status === 'suspended').map(m => m.name)
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.ctx) await revokeSession(req.ctx.sessionId);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  /** Everything the client needs on boot: who, where, what's switched on. */
  app.get('/api/me', async (req, reply) => {
    const ctx = requireUser(req, reply);
    if (!ctx) return;

    const memberships = await mq<Array<RowDataPacket & { company_id: number; role: Role; name: string; company_status: string }>>(
      `SELECT m.company_id, m.role, c.name, c.status AS company_status
       FROM memberships m JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = ? AND m.status = 'active' ORDER BY c.name`,
      [ctx.user.id]
    );

    return {
      user: {
        id: ctx.user.id, name: ctx.user.name, email: ctx.user.email,
        mustChangePassword: ctx.user.must_change_pw === 1
      },
      isPlatformOwner: ctx.isPlatformOwner,
      impersonating: ctx.impersonating,
      company: ctx.company ? {
        id: ctx.company.id, name: ctx.company.name, slug: ctx.company.slug,
        shopType: ctx.company.shop_type, timezone: ctx.company.timezone
      } : null,
      role: ctx.role,
      roleLabel: ctx.role ? ROLE_LABEL[ctx.role] : null,
      positionKey: ctx.positionKey,
      caps: ctx.caps,
      features: [...ctx.features],
      companies: memberships
        .filter(m => m.company_status !== 'closed')
        .map(m => ({
          id: m.company_id, name: m.name, role: m.role,
          roleLabel: ROLE_LABEL[m.role], suspended: m.company_status === 'suspended'
        }))
    };
  });

  /** Move the current session into another company the user belongs to. */
  app.post('/api/auth/switch-company', async (req, reply) => {
    const ctx = requireUser(req, reply);
    if (!ctx) return;
    const { companyId } = req.body as { companyId: number };

    const mem = await mqOne<RowDataPacket>(
      `SELECT m.company_id FROM memberships m JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = ? AND m.company_id = ? AND m.status = 'active' AND c.status IN ('trial','active')`,
      [ctx.user.id, companyId]
    );

    if (!mem && !ctx.isPlatformOwner) return reply.code(403).send({ error: 'No access to that company' });

    await switchSessionCompany(ctx.sessionId, companyId, !mem && ctx.isPlatformOwner);
    return { ok: true, companyId, features: await companyFeatures(companyId) };
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    const ctx = requireUser(req, reply);
    if (!ctx) return;
    const { current, next } = req.body as { current?: string; next?: string };
    if (!next) return reply.code(400).send({ error: 'New password is required.' });

    const problem = passwordProblem(next);
    if (problem) return reply.code(400).send({ error: problem });

    const row = await mqOne<LoginUser>('SELECT * FROM users WHERE id = ?', [ctx.user.id]);
    if (!row) return reply.code(404).send({ error: 'User not found' });

    // A user forced to set a password on first sign-in has nothing to confirm against.
    if (row.password_hash && !row.must_change_pw) {
      if (!current) return reply.code(400).send({ error: 'Current password is required.' });
      if (!await verifyPassword(row.password_hash, current)) {
        return reply.code(401).send({ error: 'Current password is not correct.' });
      }
    }

    await mexec(
      `UPDATE users SET password_hash = ?, must_change_pw = 0, login_code = NULL, login_code_expires = NULL
       WHERE id = ?`,
      [await hashPassword(next), ctx.user.id]
    );
    await revokeAllForUser(ctx.user.id);

    const sid = await createSession(ctx.user.id, ctx.company?.id ?? null, {
      ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '')
    });
    reply.setCookie(COOKIE_NAME, sid, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProd,
      signed: true, maxAge: config.sessionDays * 24 * 3600
    });

    return { ok: true };
  });
}
