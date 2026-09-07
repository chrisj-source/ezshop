import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { texec, tqOne } from '../db/tenant';
import { requireCompany } from '../middleware/context';

/**
 * Google Calendar — push only.
 *
 * The shop authorises once, as the owner, and the app holds the token. Nothing
 * is ever read back from Google: appointments booked here appear there, and a
 * block dropped on the Google calendar has no effect on this scheduler. Time
 * off is entered in Easy Shop.
 *
 * Nobody types a password anywhere. If the two env vars are missing the screen
 * says so instead of offering a button that cannot work.
 */

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';

interface Conn extends RowDataPacket {
  id: number;
  calendar_id: string | null;
  calendar_name: string | null;
  account_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: Date | null;
  state: 'connected' | 'error' | 'disconnected';
  last_error: string | null;
  last_push_at: Date | null;
  connected_name: string | null;
}

export function googleConfigured(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

function redirectUri(): string {
  return config.google.redirectUri || `${config.appUrl}/api/calendar/callback`;
}

function sign(companyId: number): string {
  const nonce = crypto.randomBytes(8).toString('hex');
  const body = `${companyId}.${nonce}`;
  const mac = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('hex').slice(0, 32);
  return `${body}.${mac}`;
}

function verify(state: string): number | null {
  const [cid, nonce, mac] = String(state ?? '').split('.');
  if (!cid || !nonce || !mac) return null;
  const want = crypto.createHmac('sha256', config.cookieSecret)
    .update(`${cid}.${nonce}`).digest('hex').slice(0, 32);
  if (want !== mac) return null;
  return Number(cid) || null;
}

async function connectionFor(cid: number): Promise<Conn | null> {
  return tqOne<Conn>(cid,
    `SELECT * FROM calendar_connections WHERE provider = 'google' AND state <> 'disconnected' LIMIT 1`);
}

/** A live access token, refreshed if the stored one has run out. */
async function accessToken(cid: number, conn: Conn): Promise<string | null> {
  const stillGood = conn.access_token && conn.expires_at &&
    new Date(conn.expires_at).getTime() - Date.now() > 60_000;
  if (stillGood) return conn.access_token;
  if (!conn.refresh_token) return null;

  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token'
    })
  });

  const j = await res.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !j.access_token) {
    await texec(cid,
      `UPDATE calendar_connections SET state = 'error', last_error = ? WHERE id = ?`,
      [(j.error_description ?? 'Google refused the refresh').slice(0, 255), conn.id]);
    return null;
  }

  await texec(cid,
    `UPDATE calendar_connections
     SET access_token = ?, expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
         state = 'connected', last_error = NULL
     WHERE id = ?`,
    [j.access_token, Number(j.expires_in ?? 3600), conn.id]);

  return j.access_token;
}

const KIND_LABEL: Record<string, string> = {
  drop: 'Drop off', pickup: 'Pick up', return: 'Return',
  estimate: 'Estimate', appraiser: 'Appraiser'
};

/**
 * Write one appointment out to Google. Best effort by design — a calendar that
 * is down must never stop a booking being taken at the counter.
 */
export async function pushAppointment(cid: number, apptId: number, action: 'save' | 'cancel'): Promise<void> {
  if (!googleConfigured()) return;

  const conn = await connectionFor(cid);
  if (!conn || !conn.calendar_id) return;

  const appt = await tqOne<RowDataPacket>(cid, `
    SELECT a.*, r.ro_number FROM appointments a
    LEFT JOIN repair_orders r ON r.id = a.ro_id
    WHERE a.id = ?`, [apptId]);
  if (!appt) return;

  const token = await accessToken(cid, conn);
  if (!token) return;

  const eventId = appt.gcal_event_id as string | null;
  const base = `${CAL}/calendars/${encodeURIComponent(conn.calendar_id)}/events`;

  try {
    if (action === 'cancel' || appt.cancelled_at) {
      if (!eventId) return;
      await fetch(`${base}/${encodeURIComponent(eventId)}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${token}` }
      });
      await texec(cid, 'UPDATE appointments SET gcal_event_id = NULL WHERE id = ?', [apptId]);
      return;
    }

    const start = new Date(appt.starts_at as Date);
    const end = new Date(start.getTime() + Number(appt.duration_min ?? 30) * 60_000);
    const body = {
      summary: `${KIND_LABEL[appt.kind as string] ?? 'Appointment'} — ${appt.customer_name}`,
      description: [
        appt.vehicle_text, appt.ro_number ? `RO ${appt.ro_number}` : null,
        appt.phone, appt.note
      ].filter(Boolean).join('\n') || undefined,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() }
    };

    const res = await fetch(eventId ? `${base}/${encodeURIComponent(eventId)}` : base, {
      method: eventId ? 'PATCH' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

    const j = await res.json() as { id?: string; error?: { message?: string } };
    if (!res.ok) {
      await texec(cid, `UPDATE calendar_connections SET last_error = ? WHERE id = ?`,
        [(j.error?.message ?? 'Google refused the event').slice(0, 255), conn.id]);
      return;
    }

    await texec(cid, 'UPDATE appointments SET gcal_event_id = ? WHERE id = ?', [j.id ?? null, apptId]);
    await texec(cid,
      `UPDATE calendar_connections SET last_push_at = NOW(), last_error = NULL WHERE id = ?`, [conn.id]);
  } catch (e) {
    await texec(cid, `UPDATE calendar_connections SET last_error = ? WHERE id = ?`,
      [String((e as Error).message).slice(0, 255), conn.id]).catch(() => {});
  }
}

export async function registerCalendar(app: FastifyInstance): Promise<void> {

  /** What the settings screen shows. */
  app.get('/api/calendar', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const conn = await connectionFor(ctx.company!.id);
    return {
      configured: googleConfigured(),
      canConnect: ctx.role === 'owner',
      direction: 'push',
      connection: conn ? {
        accountEmail: conn.account_email,
        calendarId: conn.calendar_id,
        calendarName: conn.calendar_name,
        state: conn.state,
        lastError: conn.last_error,
        lastPushAt: conn.last_push_at,
        connectedBy: conn.connected_name
      } : null
    };
  });

  /** Step one: send the owner to Google. No credentials are typed here. */
  app.get('/api/calendar/connect', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (ctx.role !== 'owner') return reply.code(403).send({ error: 'Owner only' });
    if (!googleConfigured()) {
      return reply.code(400).send({
        error: 'Google is not set up on this server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.'
      });
    }

    const url = `${AUTH}?` + new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: SCOPE,
      state: sign(ctx.company!.id)
    });

    return reply.redirect(url);
  });

  /** Step two: Google comes back with a code. Swap it for tokens and store. */
  app.get('/api/calendar/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return reply.redirect('/admin.html?tab=settings&calendar=denied');

    const cid = verify(q.state ?? '');
    if (!cid || !q.code) return reply.redirect('/admin.html?tab=settings&calendar=bad-state');

    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        code: q.code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri()
      })
    });

    const tok = await res.json() as {
      access_token?: string; refresh_token?: string; expires_in?: number;
    };
    if (!res.ok || !tok.access_token) return reply.redirect('/admin.html?tab=settings&calendar=failed');

    // Which account, and what calendars it can write to.
    let email: string | null = null;
    // Default to the account's own calendar: 'primary' is writable under the
    // events scope alone, so the connection is useful even when the account
    // will not list its calendars.
    let calendarId: string | null = 'primary';
    let calendarName: string | null = "The account's own calendar";
    try {
      const list = await fetch(`${CAL}/users/me/calendarList?minAccessRole=writer`, {
        headers: { authorization: `Bearer ${tok.access_token}` }
      }).then(r => r.json() as Promise<{ items?: Array<{ id: string; summary: string; primary?: boolean }> }>);
      const primary = (list.items ?? []).find(i => i.primary) ?? (list.items ?? [])[0];
      if (primary) { calendarId = primary.id; calendarName = primary.summary; email = primary.primary ? primary.id : null; }
    } catch { /* the connection is still good; the calendar can be picked later */ }

    await texec(cid, `
      INSERT INTO calendar_connections
        (provider, calendar_id, calendar_name, account_email, access_token, refresh_token,
         expires_at, state, connected_by, connected_name)
      VALUES ('google', ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), 'connected', NULL, NULL)
      ON DUPLICATE KEY UPDATE
        calendar_id = VALUES(calendar_id), calendar_name = VALUES(calendar_name),
        account_email = VALUES(account_email), access_token = VALUES(access_token),
        refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
        expires_at = VALUES(expires_at), state = 'connected', last_error = NULL`,
      [calendarId, calendarName, email, tok.access_token, tok.refresh_token ?? null,
       Number(tok.expires_in ?? 3600)]);

    return reply.redirect('/admin.html?tab=settings&calendar=connected');
  });

  /** The calendars this account can write to, so the owner can pick one. */
  app.get('/api/calendar/calendars', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (ctx.role !== 'owner') return reply.code(403).send({ error: 'Owner only' });

    const conn = await connectionFor(ctx.company!.id);
    if (!conn) return reply.code(400).send({ error: 'Google Calendar is not connected.' });

    const token = await accessToken(ctx.company!.id, conn);
    if (!token) return reply.code(400).send({ error: 'That connection needs to be made again.' });

    const res = await fetch(`${CAL}/users/me/calendarList?minAccessRole=writer`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const list = await res.json() as {
      items?: Array<{ id: string; summary: string }>;
      error?: { message?: string };
    };

    // Listing calendars needs the readonly scope; writing events does not. When
    // the list is refused or empty, the account's own calendar is still
    // writable under the events scope — offer that rather than a dead end.
    const calendars = (list.items ?? []).map(i => ({ id: i.id, name: i.summary }));
    if (!calendars.length) calendars.push({ id: 'primary', name: "The account's own calendar" });

    return {
      calendars,
      note: res.ok ? null
        : (list.error?.message ?? 'Google would not list the calendars') +
          " — appointments can still be written to the account's own calendar."
    };
  });

  app.patch('/api/calendar', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (ctx.role !== 'owner') return reply.code(403).send({ error: 'Owner only' });

    const b = req.body as { calendarId?: string; calendarName?: string };
    if (!b.calendarId) return reply.code(400).send({ error: 'Pick a calendar.' });

    await texec(ctx.company!.id,
      `UPDATE calendar_connections SET calendar_id = ?, calendar_name = ? WHERE provider = 'google'`,
      [b.calendarId.slice(0, 190), (b.calendarName ?? '').slice(0, 190) || null]);
    return { ok: true };
  });

  app.delete('/api/calendar', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (ctx.role !== 'owner') return reply.code(403).send({ error: 'Owner only' });

    await texec(ctx.company!.id,
      `UPDATE calendar_connections
       SET state = 'disconnected', access_token = NULL, refresh_token = NULL WHERE provider = 'google'`);
    await texec(ctx.company!.id,
      'UPDATE appointments SET gcal_event_id = NULL WHERE gcal_event_id IS NOT NULL');
    return { ok: true };
  });
}
