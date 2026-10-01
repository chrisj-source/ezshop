import crypto from 'node:crypto';
import { RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { mexec, mq, mqOne } from '../db/master';
import { texec, tq, tqOne } from '../db/tenant';
import { notify } from '../notify';
import { companyFeatures } from '../middleware/context';
import { seal, unseal } from './secretbox';
import { mayContact, normalise } from './consent';
import { suppressionState, noteSuppressionHit, suppress, release } from './suppression';

/**
 * Text messages, over each shop's own Twilio account.
 *
 * `sendSms` is the only way out, and it runs the same gates as mail: the
 * feature is on, the account is verified, consent allows it (`mayContact`), and
 * the number is not suppressed. Both of the last two must pass — they are
 * different facts. A refused send is a row with its reason, never retried.
 *
 * Every message carries a STOP line appended here, not typed, so it cannot be
 * edited off. STOP in reply revokes through `suppress()`.
 */

const API = 'https://api.twilio.com/2010-04-01';
export const STOP_LINE = 'Reply STOP to opt out.';
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'unstop']);

interface Account {
  company_id: number; account_sid: string; auth_token_sealed: string; auth_token_last4: string;
  sender_kind: 'number' | 'service' | null; sender: string | null; account_name: string | null;
  verified_at: Date | null; last_error: string | null; updated_at: Date;
}

async function account(companyId: number): Promise<Account | null> {
  return (await mqOne<RowDataPacket & Account>('SELECT * FROM company_sms WHERE company_id = ?', [companyId])) ?? null;
}

/** What a screen may see. The token never leaves; its last four do. */
export async function smsSummary(companyId: number) {
  const a = await account(companyId);
  return {
    configured: !!a,
    accountSid: a?.account_sid ?? null,
    tokenLast4: a?.auth_token_last4 ?? null,
    senderKind: a?.sender_kind ?? null,
    sender: a?.sender ?? null,
    accountName: a?.account_name ?? null,
    verifiedAt: a?.verified_at ?? null,
    lastError: a?.last_error ?? null,
    keyMissing: !config.credentialsKey,
    inboundUrl: `${config.appUrl.replace(/\/$/, '')}/api/sms/twilio/inbound/${companyId}`,
    statusUrl: `${config.appUrl.replace(/\/$/, '')}/api/sms/twilio/status/${companyId}`
  };
}

export async function smsReady(companyId: number): Promise<boolean> {
  const a = await account(companyId);
  return !!(a && a.verified_at && a.sender);
}

/** Save or replace credentials. Any change clears verification. */
export async function saveAccount(companyId: number, b: {
  accountSid?: string; authToken?: string; senderKind?: 'number' | 'service'; sender?: string;
}, actor: number): Promise<void> {
  const cur = await account(companyId);
  const sid = (b.accountSid ?? cur?.account_sid ?? '').trim();
  if (!/^AC[0-9a-f]{32}$/i.test(sid)) throw new Error('The Account SID starts AC and is 34 characters.');
  const token = b.authToken?.trim();
  if (!cur && !token) throw new Error('The Auth Token is required.');
  if (token && !/^[0-9a-f]{32}$/i.test(token)) throw new Error('The Auth Token is 32 characters, letters a–f and digits.');

  let kind = b.senderKind ?? cur?.sender_kind ?? null;
  let sender = b.sender !== undefined ? b.sender.trim() : (cur?.sender ?? null);
  if (sender === '') { sender = null; kind = null; }
  if (sender && kind === 'service' && !/^MG[0-9a-f]{32}$/i.test(sender)) {
    throw new Error('A Messaging Service SID starts MG and is 34 characters.');
  }
  if (sender && kind === 'number') {
    sender = e164(sender);
    if (!sender) throw new Error('That sending number does not look like a phone number.');
  }

  const sealed = token ? seal(token) : cur!.auth_token_sealed;
  const last4 = token ? token.slice(-4) : cur!.auth_token_last4;
  await mexec(`
    INSERT INTO company_sms (company_id, account_sid, auth_token_sealed, auth_token_last4, sender_kind, sender, updated_by, verified_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    ON DUPLICATE KEY UPDATE account_sid = VALUES(account_sid), auth_token_sealed = VALUES(auth_token_sealed),
      auth_token_last4 = VALUES(auth_token_last4), sender_kind = VALUES(sender_kind), sender = VALUES(sender),
      updated_by = VALUES(updated_by), verified_at = NULL, last_error = NULL`,
    [companyId, sid, sealed, last4, kind, sender, actor]);
}

export async function removeAccount(companyId: number): Promise<void> {
  await mexec('DELETE FROM company_sms WHERE company_id = ?', [companyId]);
}

async function twilio(a: Account, method: 'GET' | 'POST', url: string, form?: Record<string, string>) {
  const auth = Buffer.from(`${a.account_sid}:${unseal(a.auth_token_sealed)}`).toString('base64');
  const res = await fetch(url, {
    method,
    headers: { authorization: `Basic ${auth}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(json.message ?? `Twilio answered ${res.status}`);
    throw Object.assign(new Error(msg), { status: res.status, code: json.code });
  }
  return json;
}

/**
 * Check the credentials against Twilio and list what this account can send
 * from, so the sender is picked rather than typed.
 */
export async function verifyAccount(companyId: number) {
  const a = await account(companyId);
  if (!a) throw new Error('No Twilio account saved for this shop.');
  try {
    const acct = await twilio(a, 'GET', `${API}/Accounts/${a.account_sid}.json`);
    if (acct.status !== 'active') throw new Error(`Twilio says this account is ${acct.status}.`);
    const nums = await twilio(a, 'GET', `${API}/Accounts/${a.account_sid}/IncomingPhoneNumbers.json?PageSize=50`);
    const svcs = await twilio(a, 'GET', 'https://messaging.twilio.com/v1/Services?PageSize=50').catch(() => ({ services: [] }));
    const numbers = ((nums.incoming_phone_numbers ?? []) as Array<Record<string, unknown>>)
      .filter(n => (n.capabilities as Record<string, boolean> | undefined)?.sms !== false)
      .map(n => ({ value: String(n.phone_number), label: String(n.friendly_name ?? n.phone_number) }));
    const services = ((svcs.services ?? []) as Array<Record<string, unknown>>)
      .map(s => ({ value: String(s.sid), label: String(s.friendly_name ?? s.sid) }));

    /* Verified only once a sender is chosen and still belongs to the account. */
    const senderOk = !!a.sender && (a.sender_kind === 'number'
      ? numbers.some(n => n.value === a.sender)
      : services.some(s => s.value === a.sender));
    await mexec('UPDATE company_sms SET account_name = ?, verified_at = ?, last_error = ? WHERE company_id = ?',
      [String(acct.friendly_name ?? '').slice(0, 120), senderOk ? new Date() : null,
       a.sender && !senderOk ? 'The chosen sender is not on this Twilio account.' : null, companyId]);
    return { ok: true, accountName: acct.friendly_name, numbers, services, senderOk };
  } catch (e) {
    const msg = (e as { status?: number }).status === 401
      ? 'Twilio refused the Account SID and Auth Token.' : (e as Error).message;
    await mexec('UPDATE company_sms SET verified_at = NULL, last_error = ? WHERE company_id = ?',
      [msg.slice(0, 255), companyId]);
    throw new Error(msg);
  }
}

/** US numbers only for now: ten digits, or eleven starting 1. */
export function e164(phone: string): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

export interface SendResult { ok: boolean; id: number | null; state: string; reason: string | null }

/**
 * The only way a text leaves. `purpose` is the consent question asked;
 * 'test' skips consent (platform admin sending to its own phone) but never
 * suppression.
 */
export async function sendSms(companyId: number, to: string, body: string, opts: {
  purpose: 'transactional' | 'marketing' | 'test'; roId?: number | null; sentBy?: number | null;
  sentByName?: string | null; triggerKey?: string | null;
}): Promise<SendResult> {
  const dest = normalise('sms', to);
  const text = `${body.trim()}\n${STOP_LINE}`;

  const refuse = async (reason: string): Promise<SendResult> => {
    const r = await texec(companyId, `INSERT INTO sms_messages (direction, ro_id, destination, body, purpose, trigger_key, state, reason, sent_by, sent_by_name)
      VALUES ('out', ?, ?, ?, ?, ?, 'refused', ?, ?, ?)`,
      [opts.roId ?? null, dest || String(to).slice(0, 20), text, opts.purpose, opts.triggerKey ?? null,
       reason.slice(0, 255), opts.sentBy ?? null, opts.sentByName ?? null]);
    return { ok: false, id: r.insertId ?? null, state: 'refused', reason };
  };

  const toE164 = e164(to);
  if (!toE164) return refuse('Not a US mobile number.');
  if (!(await companyFeatures(companyId)).includes('sms')) return refuse('Text messaging is off for this shop.');
  const a = await account(companyId);
  if (!a || !a.verified_at || !a.sender) return refuse('This shop\'s Twilio account is not verified.');

  const sup = await suppressionState('sms', dest, companyId);
  if (sup.suppressed) {
    await noteSuppressionHit(companyId, 'sms', dest, `sms ${opts.purpose}`);
    return refuse('This number replied STOP.');
  }
  if (opts.purpose !== 'test') {
    const c = await mayContact(companyId, 'sms', dest, opts.purpose, opts.roId ?? null);
    if (!c.allowed) return refuse(c.reason ?? 'No consent on record for this number.');
  }

  const row = await texec(companyId, `INSERT INTO sms_messages (direction, ro_id, destination, body, purpose, trigger_key, state, sent_by, sent_by_name)
    VALUES ('out', ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    [opts.roId ?? null, dest, text, opts.purpose, opts.triggerKey ?? null, opts.sentBy ?? null, opts.sentByName ?? null]);
  const id = row.insertId;

  try {
    const form: Record<string, string> = {
      To: toE164, Body: text,
      StatusCallback: (await smsSummary(companyId)).statusUrl
    };
    if (a.sender_kind === 'service') form.MessagingServiceSid = a.sender; else form.From = a.sender;
    const m = await twilio(a, 'POST', `${API}/Accounts/${a.account_sid}/Messages.json`, form);
    await texec(companyId, `UPDATE sms_messages SET state = 'sent', twilio_sid = ? WHERE id = ?`, [String(m.sid), id]);
    return { ok: true, id, state: 'sent', reason: null };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 255);
    await texec(companyId, `UPDATE sms_messages SET state = 'failed', reason = ? WHERE id = ?`, [msg, id]);
    /* 21610: Twilio already holds this number as opted out. Write it down here too. */
    if ((e as { code?: number }).code === 21610) {
      await suppress(companyId, 'sms', dest, { reason: 'stop', source: 'reply', note: 'Twilio 21610' });
    }
    return { ok: false, id, state: 'failed', reason: msg };
  }
}

/* --------------------------------------------------------------- webhooks */

/** Twilio's signature: HMAC-SHA1 over URL + sorted params, keyed by the token. */
export async function signatureOk(companyId: number, url: string, params: Record<string, string>, sig: string): Promise<boolean> {
  const a = await account(companyId);
  if (!a || !sig) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const want = crypto.createHmac('sha1', unseal(a.auth_token_sealed)).update(data, 'utf8').digest('base64');
  const x = Buffer.from(want), y = Buffer.from(sig);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * A text from a customer. STOP revokes through `suppress()`; START is the
 * customer's own act on their own phone and releases. Twilio's Advanced
 * Opt-Out sends the carrier-required replies for STOP, START and HELP, so
 * nothing is answered from here.
 */
export async function receiveSms(companyId: number, from: string, body: string, sid: string): Promise<void> {
  const dest = normalise('sms', from);
  const word = body.trim().toLowerCase().replace(/[^a-z]/g, '');
  const roId = await fileForNumber(companyId, dest);
  const ins = await texec(companyId, `INSERT IGNORE INTO sms_messages (direction, ro_id, destination, body, purpose, state, twilio_sid)
    VALUES ('in', ?, ?, ?, 'reply', 'received', ?)`, [roId, dest, body.slice(0, 1600), sid || null]);
  /* Twilio retries a webhook it thinks failed; the sid makes a retry a no-op. */
  if (!ins.affectedRows) return;

  if (STOP_WORDS.has(word)) {
    await suppress(companyId, 'sms', dest, { reason: 'stop', source: 'reply' });
  } else if (START_WORDS.has(word)) {
    await release(companyId, 'sms', dest, null);
  }
  await notifyReply(companyId, roId, dest, body).catch(() => undefined);
}

/**
 * Which file a reply belongs to: the open file whose customer has this number,
 * most recently moved; failing that, the file our last text to this number was
 * about. Null when neither — the reply is still kept and Front office is told.
 */
async function fileForNumber(companyId: number, dest: string): Promise<number | null> {
  if (!dest) return null;
  const open = await tqOne<RowDataPacket & { id: number }>(companyId, `
    SELECT r.id FROM repair_orders r JOIN clients c ON c.id = r.client_id
     WHERE r.closed_at IS NULL AND r.voided_at IS NULL
       AND RIGHT(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', ''), 10) = ?
     ORDER BY r.status_since DESC LIMIT 1`, [dest]).catch(() => null);
  if (open) return open.id;
  const last = await tqOne<RowDataPacket & { ro_id: number }>(companyId, `
    SELECT ro_id FROM sms_messages WHERE destination = ? AND direction = 'out' AND ro_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`, [dest]).catch(() => null);
  return last?.ro_id ?? null;
}

/** People holding any of these roles at this shop. */
async function holders(companyId: number, roles: string[]): Promise<number[]> {
  if (!roles.length) return [];
  const viaRoles = await mq<Array<RowDataPacket & { user_id: number }>>(`
    SELECT DISTINCT mr.user_id FROM membership_roles mr
      JOIN memberships m ON m.user_id = mr.user_id AND m.company_id = mr.company_id AND m.status = 'active'
     WHERE mr.company_id = ? AND mr.role_key IN (?)`, [companyId, roles]).catch(() => []);
  const viaPrimary = await mq<Array<RowDataPacket & { user_id: number }>>(`
    SELECT user_id FROM memberships WHERE company_id = ? AND status = 'active' AND role IN (?)`,
    [companyId, roles]).catch(() => []);
  return [...new Set([...viaRoles, ...viaPrimary].map(r => Number(r.user_id)))];
}

/** The estimator on the file, or whoever opened it. */
export async function fileOwner(companyId: number, roId: number): Promise<number | null> {
  const est = await tqOne<RowDataPacket & { user_id: number }>(companyId, `
    SELECT user_id FROM ro_assignments WHERE ro_id = ? AND position_key IN ('est', 'estimator')
       AND user_id IS NOT NULL LIMIT 1`, [roId]).catch(() => null);
  if (est) return Number(est.user_id);
  const r = await tqOne<RowDataPacket & { created_by: number | null }>(companyId,
    'SELECT created_by FROM repair_orders WHERE id = ?', [roId]).catch(() => null);
  return r?.created_by ? Number(r.created_by) : null;
}

export async function replyRouting(companyId: number): Promise<Array<{ target: string; enabled: boolean }>> {
  const rows = await tq<Array<RowDataPacket & { target: string; enabled: number }>>(companyId,
    'SELECT target, enabled FROM sms_reply_routing').catch(() => []);
  return rows.map(r => ({ target: r.target, enabled: Number(r.enabled) === 1 }));
}

async function notifyReply(companyId: number, roId: number | null, dest: string, body: string): Promise<void> {
  const shown = dest.length === 10 ? `(${dest.slice(0, 3)}) ${dest.slice(3, 6)}-${dest.slice(6)}` : dest;
  if (!roId) {
    const ids = await holders(companyId, ['front_office']);
    await notify({ companyId, event: 'sms.reply', title: `Text from ${shown} — no open file`,
      body: body.slice(0, 280), directUserIds: ids, onlyDirect: true,
      dedupeKey: `sms:${dest}:${Date.now()}` });
    return;
  }
  const on = (await replyRouting(companyId)).filter(r => r.enabled).map(r => r.target);
  const ids = new Set(await holders(companyId, on.filter(t => t !== 'file_owner')));
  if (on.includes('file_owner')) { const o = await fileOwner(companyId, roId); if (o) ids.add(o); }
  const ro = await tqOne<RowDataPacket & { ro_number: string; name: string | null }>(companyId, `
    SELECT r.ro_number, c.name FROM repair_orders r LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ?`, [roId]);
  await notify({ companyId, event: 'sms.reply', roId,
    title: `Text from ${ro?.name || shown} — RO ${ro?.ro_number ?? roId}`,
    body: body.slice(0, 280), directUserIds: [...ids], onlyDirect: true,
    dedupeKey: `sms:${roId}:${Date.now()}` });
}

export async function statusCallback(companyId: number, sid: string, status: string, error?: string): Promise<void> {
  const state = status === 'delivered' ? 'delivered'
    : (status === 'failed' || status === 'undelivered') ? 'failed' : null;
  if (!state || !sid) return;
  const cur = await tqOne<RowDataPacket>(companyId, 'SELECT id FROM sms_messages WHERE twilio_sid = ?', [sid]);
  if (!cur) return;
  await texec(companyId, 'UPDATE sms_messages SET state = ?, reason = COALESCE(?, reason) WHERE id = ?',
    [state, error ? `Twilio error ${error}` : null, cur.id]);
}
