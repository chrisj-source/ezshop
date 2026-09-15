import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { COOKIE_NAME, config } from '../config';
import { mexec, mq, mqOne } from '../db/master';
import { hashPassword, passwordProblem, verifyPassword } from './password';
import { createSession, revokeAllForUser, revokeSession, switchSessionCompany } from './session';
import { companyFeatures, requireUser } from '../middleware/context';
import { EMAIL_EVENTS, eventPrefs, letter, seedEventPrefs, sendMail } from '../lib/mail';
import { suppressedForUser } from '../lib/suppression';
import crypto from 'node:crypto';
import { texec } from '../db/tenant';
import { ROLE_LABEL, Role } from '../permissions';

interface LoginUser extends RowDataPacket {
  id: number; email: string | null; password_hash: string | null; login_code: string | null;
  login_code_expires: Date | null; name: string; is_platform_owner: number;
  platform_role: 'none' | 'admin' | 'root';
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

    /*
     * Root is the break-glass account and is switched off at the box, not in
     * the database: with ROOT_ENABLED unset it cannot sign in however correct
     * the password is. That is the whole point — knowing root's password is not
     * enough to reach it from the internet.
     *
     * When it is on, the sign-in is loud: a row in the platform audit naming
     * the address it came from, every time, and a banner on screen for as long
     * as the session lasts.
     */
    if (user.platform_role === 'root') {
      if (!config.rootEnabled) {
        await mexec(
          `INSERT INTO platform_audit (actor_user_id, company_id, action, detail)
           VALUES (?, NULL, 'root.refused', ?)`,
          [user.id, JSON.stringify({ ip, userAgent: String(ua) })]
        ).catch(() => undefined);
        return reply.code(403).send({
          error: 'The root account is switched off. Set ROOT_ENABLED=1 on the server and restart.'
        });
      }
      await mexec(
        `INSERT INTO platform_audit (actor_user_id, company_id, action, detail)
         VALUES (?, NULL, 'root.signin', ?)`,
        [user.id, JSON.stringify({ ip, userAgent: String(ua) })]
      ).catch(() => undefined);
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
      isPlatformOwner: user.is_platform_owner === 1 || user.platform_role !== 'none',
      platformRole: user.platform_role ?? 'none',
      companies: usable.map(m => ({ id: m.company_id, name: m.name, role: m.role, roleLabel: ROLE_LABEL[m.role] ?? m.role })),
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
        mustChangePassword: ctx.user.must_change_pw === 1,
        /* Whether notifications also leave the building for this person. */
        emailOptIn: (ctx.user as unknown as { email_opt_in?: number }).email_opt_in === 1
      },
      isPlatformOwner: ctx.isPlatformOwner,
      impersonating: ctx.impersonating,
      company: ctx.company ? {
        id: ctx.company.id, name: ctx.company.name, slug: ctx.company.slug,
        shopType: ctx.company.shop_type, timezone: ctx.company.timezone
      } : null,
      role: ctx.role,
      /* Labels are the shop's own \u2014 a shop that calls the owner "Boss" says Boss
         everywhere, and a custom role has no shipped label to fall back on. */
      roleLabel: ctx.roleLabel ?? (ctx.role ? ROLE_LABEL[ctx.role] ?? ctx.role : null),
      roles: ctx.roles,
      roleLabels: ctx.roles.map(r =>
        ctx.roleRows.find(x => x.role_key === r)?.label ?? ROLE_LABEL[r] ?? r),
      positionKey: ctx.positionKey,
      positionKeys: ctx.positionKeys,
      caps: ctx.caps,
      features: [...ctx.features],
      companies: memberships
        .filter(m => m.company_status !== 'closed')
        .map(m => ({
          id: m.company_id, name: m.name, role: m.role,
          roleLabel: ROLE_LABEL[m.role] ?? m.role, suspended: m.company_status === 'suspended'
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

  /**
   * Change your own email. Requires the current password, because email is the
   * sign-in name — losing control of it is losing the account.
   */
  app.post('/api/auth/change-email', async (req, reply) => {
    const ctx = requireUser(req, reply);
    if (!ctx) return;
    const { email, password } = req.body as { email?: string; password?: string };

    const next = (email ?? '').trim().toLowerCase();
    if (!next) return reply.code(400).send({ error: 'An email address is required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(next)) {
      return reply.code(400).send({ error: 'That does not look like an email address.' });
    }

    const row = await mqOne<LoginUser>('SELECT * FROM users WHERE id = ?', [ctx.user.id]);
    if (!row) return reply.code(404).send({ error: 'User not found' });

    if (row.password_hash) {
      if (!password) return reply.code(400).send({ error: 'Your current password is required.' });
      if (!await verifyPassword(row.password_hash, password)) {
        return reply.code(401).send({ error: 'That password is not correct.' });
      }
    }

    const clash = await mqOne<RowDataPacket>(
      'SELECT id FROM users WHERE email = ? AND id <> ?', [next, ctx.user.id]);
    if (clash) return reply.code(409).send({ error: 'Another account already uses that address.' });

    await mexec('UPDATE users SET email = ? WHERE id = ?', [next, ctx.user.id]);
    return { ok: true, email: next };
  });

  /** Your own name, as it appears on notes and history. */
  app.post('/api/auth/change-name', async (req, reply) => {
    const ctx = requireUser(req, reply);
    if (!ctx) return;
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) return reply.code(400).send({ error: 'A name is required.' });

    await mexec('UPDATE users SET name = ? WHERE id = ?', [name.trim(), ctx.user.id]);
    if (ctx.company) {
      await texec(ctx.company.id, 'UPDATE staff SET display_name = ? WHERE user_id = ?',
        [name.trim(), ctx.user.id]);
    }
    return { ok: true };
  });

  /**
   * Ask for a reset link.
   *
   * Always answers the same way. "No account with that address" tells whoever
   * is asking which addresses are real, and that is not a favour worth doing —
   * the honest-looking answer is the unsafe one here.
   */
  /**
   * What this person has email switched on for, event by event, with an honest
   * note about how noisy each one is. A preference whose cost you cannot
   * predict is not a real choice.
   */
  app.get('/api/auth/email-events', async (req, reply) => {
    const ctx = requireUser(req, reply);
    if (!ctx) return;
    const prefs = await eventPrefs(ctx.user.id);
    return {
      on: (ctx.user as unknown as { email_opt_in?: number }).email_opt_in === 1,
      hasEmail: !!ctx.user.email,
      throttleMinutes: config.mail.throttleMinutes,
      events: EMAIL_EVENTS.map(e => {
        const p = prefs.get(e.key);
        return {
          key: e.key, label: e.label, fires: e.fires, weight: e.weight,
          scoped: !!e.scoped,
          enabled: !!p?.enabled,
          scope: p?.scope ?? 'mine'
        };
      })
    };
  });

  app.put('/api/auth/email-events', async (req, reply) => {
    const ctx = requireUser(req, reply);
    if (!ctx) return;
    const rows = (req.body as { events?: unknown[] }).events;
    if (!Array.isArray(rows)) return reply.code(400).send({ error: 'Nothing to save.' });

    const known = new Set(EMAIL_EVENTS.map(e => e.key));
    let on = 0;

    for (const r of rows as Array<Record<string, unknown>>) {
      const key = String(r.key ?? '');
      if (!known.has(key)) continue;
      const enabled = r.enabled === true;
      const scope = r.scope === 'all' ? 'all' : 'mine';
      if (enabled) on++;

      await mexec(
        `INSERT INTO user_email_events (user_id, event_key, enabled, scope)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), scope = VALUES(scope)`,
        [ctx.user.id, key, enabled ? 1 : 0, scope]);
    }

    /* Turning every event off is the same intention as turning email off, so
       the master switch follows rather than leaving a switch that says on and
       sends nothing. */
    if (on === 0) {
      await mexec('UPDATE users SET email_opt_in = 0 WHERE id = ?', [ctx.user.id]);
    }

    return {
      ok: true, on,
      note: on === 0
        ? 'Nothing selected, so email is off. Everything still arrives in the app.'
        : `Saved. ${on} ${on === 1 ? 'event' : 'events'} will also come by email.`
    };
  });

  /**
   * Mirror my notifications to email, or stop. Off until asked for — everyone
   * already has the in-app copy, and an inbox nobody wanted is how a shop
   * decides to ignore all of it.
   */
  app.patch('/api/auth/email-preference', async (req, reply) => {
    const ctx = requireUser(req, reply);
    if (!ctx) return;
    const on = (req.body as { on?: boolean })?.on === true;

    if (on && !ctx.user.email) {
      return reply.code(400).send({
        error: 'Add an email address to your account first.'
      });
    }

    await mexec('UPDATE users SET email_opt_in = ? WHERE id = ?', [on ? 1 : 0, ctx.user.id]);
    /* Switching it on turns on the four that are about you or about something
       going wrong — not all eight. The rest is theirs to choose. */
    if (on) await seedEventPrefs(ctx.user.id);

    return {
      ok: true, on,
      note: on
        ? 'On, for assignments, supplement decisions, red files and customer replies. ' +
          'Pick the rest below.'
        : 'Email off. Everything still arrives in the app.'
    };
  });

  app.post('/api/auth/forgot', async (req, reply) => {
    const email = String((req.body as { email?: string })?.email ?? '').trim().toLowerCase();
    const same = { ok: true, note: 'If that address has an account, a link is on its way.' };
    if (!email) return reply.code(400).send({ error: 'An email address is required.' });

    const user = await mqOne<RowDataPacket>(
      `SELECT id, name, email FROM users WHERE email = ? AND status = 'active'`, [email]);
    if (!user) return same;

    await sendResetLink(Number(user.id), String(user.name), email).catch(e => req.log.error(e));
    return same;
  });

  /**
   * Spend the token. One use — it is deleted on the way past, not marked — and
   * every session that user had ends, because a reset is usually somebody
   * locked out and occasionally somebody being pushed out.
   */
  app.post('/api/auth/reset', async (req, reply) => {
    const b = req.body as { token?: string; password?: string };
    const token = String(b.token ?? '').trim();
    const password = String(b.password ?? '');
    if (!token) return reply.code(400).send({ error: 'That link is not valid.' });

    const problem = passwordProblem(password);
    if (problem) return reply.code(400).send({ error: problem });

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await mqOne<RowDataPacket>(
      `SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?`, [hash]);

    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return reply.code(400).send({
        error: 'That link has expired or has already been used. Ask for another.'
      });
    }

    await mexec(
      `UPDATE users SET password_hash = ?, must_change_pw = 0, failed_logins = 0,
         locked_until = NULL WHERE id = ?`,
      [await hashPassword(password), row.user_id]);
    await mexec('DELETE FROM password_resets WHERE token_hash = ?', [hash]);
    await revokeAllForUser(Number(row.user_id));

    return { ok: true, note: 'Password set. Sign in with it.' };
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

/**
 * Mint a one-use reset link and send it. The token is random, the database
 * keeps only its hash, and it is good for an hour — long enough to walk to a
 * computer, short enough that a link left in an inbox is not a spare key.
 */
export async function sendResetLink(
  userId: number, name: string, email: string
): Promise<{ ok: boolean; error?: string; suppressed?: boolean }> {
  /**
   * An unsubscribed address gets no reset link.
   *
   * Decided 15 Sep 2026: "if they unsubscribe, they unsubscribe" — there is no
   * transactional exemption. The check happens before the token is minted, so
   * a person who cannot be emailed does not also end up with an unusable token
   * sitting in the table and their previous one deleted.
   *
   * The reset is asked for by address at the sign-in screen with no shop in
   * hand, so every shop the account belongs to is checked — see
   * suppressedForUser.
   */
  const blocked = await suppressedForUser(userId, email);
  if (blocked.suppressed) {
    return {
      ok: false, suppressed: true,
      error: blocked.where === 'platform'
        ? `${email} is undeliverable — it bounced, so a reset link cannot reach ` +
          `it. An owner or platform admin has to set the password instead.`
        : `${email} unsubscribed, so no mail is sent to it — a reset link ` +
          `included. Either an owner sets the password, or the person ` +
          `re-subscribes from the link at the bottom of any earlier message.`
    };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');

  await mexec('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [userId]);
  await mexec(
    `INSERT INTO password_resets (token_hash, user_id, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [hash, userId, config.mail.resetHours]);

  const url = `${config.appUrl}/reset.html?t=${token}`;
  const body = letter('Set a new password', [
    `Hello ${name.split(' ')[0] ?? name},`,
    'Somebody asked to reset the password on your Easy Shop account.',
    `The link below works once and expires in ${config.mail.resetHours === 1
      ? 'an hour' : config.mail.resetHours + ' hours'}.`,
    'If it was not you, nothing has changed and you can ignore this.'
  ], { label: 'Set a new password', url });

  const sent = await sendMail({
    to: email, subject: 'Set a new Easy Shop password', text: body.text, html: body.html
  });
  return sent.ok ? { ok: true } : { ok: false, error: sent.error };
}
