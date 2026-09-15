import crypto from 'node:crypto';
import { RowDataPacket } from 'mysql2/promise';
import { mq, mqOne } from '../db/master';
import { texec, tqOne } from '../db/tenant';
import { config } from '../config';

/**
 * Unsubscribe, STOP, and every place they have to be obeyed.
 *
 * Decided 15 Sep 2026:
 *
 *  - **One list, two channels.** An unsubscribed address and a number that
 *    replied STOP are the same fact. `channel` tells them apart.
 *  - **Per shop**, because each shop is its own controller. Hard bounces and
 *    complaints go platform-wide instead — they are the address saying it does
 *    not exist, which is nobody's decision to override.
 *  - **Keyed on the destination, not a customer row.** Editing a client,
 *    deleting one, or re-importing an estimate must not un-block an address.
 *  - **It applies to everything.** Including password resets. "If they
 *    unsubscribe, they unsubscribe" was the call, so there is no transactional
 *    exemption in here. The consequence is real and deliberate: a person who
 *    unsubscribes cannot receive a reset link, and an owner has to set their
 *    password for them or they have to re-subscribe first. Anything that wants
 *    to change that changes it here, in one place, on purpose.
 *  - **Checked in the mail layer**, not by each caller. A caller that forgets
 *    is a caller that sends to somebody who said no.
 */

export type Channel = 'email' | 'sms';

/** The stored form. Two spellings of one address must not be two rows. */
export function normalise(channel: Channel, destination: string): string {
  const d = String(destination ?? '').trim();
  if (channel === 'email') return d.toLowerCase();
  return d.replace(/[^\d]/g, '');
}

export interface SuppressionState {
  suppressed: boolean;
  /** 'shop' — this shop's list. 'platform' — bounced or complained. */
  where?: 'shop' | 'platform';
  reason?: string;
  since?: Date;
}

/**
 * Is this destination blocked?
 *
 * The platform list is asked first and without a shop, because it applies
 * whether or not we know which shop is sending.
 */
export async function suppressionState(
  channel: Channel, destination: string, companyId?: number | null
): Promise<SuppressionState> {
  const dest = normalise(channel, destination);
  if (!dest) return { suppressed: false };

  const plat = await mqOne<RowDataPacket>(
    `SELECT reason, created_at FROM platform_suppressions
      WHERE channel = ? AND destination = ? AND released_at IS NULL`,
    [channel, dest]
  ).catch(() => null);

  if (plat) {
    return {
      suppressed: true, where: 'platform',
      reason: String(plat.reason), since: new Date(plat.created_at)
    };
  }

  if (!companyId) return { suppressed: false };

  const shop = await tqOne<RowDataPacket>(companyId,
    `SELECT reason, created_at FROM suppressions
      WHERE channel = ? AND destination = ? AND released_at IS NULL`,
    [channel, dest]
  ).catch(() => null);

  if (shop) {
    return {
      suppressed: true, where: 'shop',
      reason: String(shop.reason), since: new Date(shop.created_at)
    };
  }
  return { suppressed: false };
}

export async function isSuppressed(
  channel: Channel, destination: string, companyId?: number | null
): Promise<boolean> {
  return (await suppressionState(channel, destination, companyId)).suppressed;
}

/** Write the refusal down. A shop asking "why was he not told" deserves an answer. */
export async function noteSuppressionHit(
  companyId: number, channel: Channel, destination: string, context: string
): Promise<void> {
  await texec(companyId,
    `INSERT INTO suppression_hits (channel, destination, context) VALUES (?, ?, ?)`,
    [channel, normalise(channel, destination), context.slice(0, 120)]
  ).catch(() => undefined);
}

export async function suppress(
  companyId: number, channel: Channel, destination: string,
  opts: { reason?: 'unsubscribe' | 'stop' | 'manual'; source?: 'link' | 'reply' | 'desk';
          note?: string | null; ip?: string | null } = {}
): Promise<void> {
  const dest = normalise(channel, destination);
  if (!dest) return;
  /* ON DUPLICATE rather than INSERT IGNORE: an address that was released and
     unsubscribes again must go back on the list, not silently stay off it. */
  await texec(companyId, `
    INSERT INTO suppressions (channel, destination, reason, source, note, created_ip)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      reason = VALUES(reason), source = VALUES(source), note = VALUES(note),
      created_at = NOW(), created_ip = VALUES(created_ip),
      released_at = NULL, released_ip = NULL`,
    [channel, dest, opts.reason ?? 'unsubscribe', opts.source ?? 'link',
     opts.note ?? null, opts.ip ?? null]);
}

/**
 * Re-subscribe. Only ever called from the public page, on a link the customer
 * themselves is holding — there is no desk route to this and that is the point.
 * It does not touch the platform list: a bounced address is not re-enabled by
 * somebody wanting it to work.
 */
export async function release(
  companyId: number, channel: Channel, destination: string, ip?: string | null
): Promise<void> {
  await texec(companyId,
    `UPDATE suppressions SET released_at = NOW(), released_ip = ?
      WHERE channel = ? AND destination = ? AND released_at IS NULL`,
    [ip ?? null, channel, normalise(channel, destination)]);
}

/* ------------------------------------------------------------------- links */

/**
 * The unsubscribe link, signed rather than stored.
 *
 * The person clicking it has no account and must not need one, so the link
 * carries who it is for and a signature over that. Nothing to look up, nothing
 * to expire, nothing to enumerate — and no token table to keep in step with a
 * customer record that might be edited underneath it.
 */
function sign(companyId: number, channel: Channel, dest: string): string {
  return crypto.createHmac('sha256', config.cookieSecret)
    .update(`${companyId}|${channel}|${dest}`)
    .digest('base64url');
}

export function unsubscribeUrl(
  companyId: number, channel: Channel, destination: string
): string {
  const dest = normalise(channel, destination);
  const d = Buffer.from(dest, 'utf8').toString('base64url');
  return `${config.appUrl}/unsubscribe.html?c=${companyId}&k=${channel}` +
         `&d=${d}&t=${sign(companyId, channel, dest)}`;
}

export interface UnsubLink { companyId: number; channel: Channel; destination: string }

/** Read a link back, or null if the signature does not hold. */
export function readUnsubscribeLink(q: Record<string, unknown>): UnsubLink | null {
  const companyId = Number(q.c);
  const channel = String(q.k ?? '') as Channel;
  const enc = String(q.d ?? '');
  const sig = String(q.t ?? '');
  if (!companyId || (channel !== 'email' && channel !== 'sms') || !enc || !sig) return null;

  let destination: string;
  try { destination = Buffer.from(enc, 'base64url').toString('utf8'); }
  catch { return null; }
  if (!destination) return null;

  const expected = sign(companyId, channel, destination);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { companyId, channel, destination };
}

/* -------------------------------------------------- a staff member's address */

/**
 * Has this user's own address unsubscribed from any shop they belong to?
 *
 * Needed because a staff member who clicks the unsubscribe link in a
 * notification email writes a per-shop suppression against their own address —
 * and the decision on 15 Sep 2026 was that an unsubscribe applies to
 * everything, transactional mail included. A password reset asks by address at
 * the sign-in screen, before any shop is known, so the only faithful check is
 * every shop the account is a member of.
 *
 * The consequence is deliberate and worth stating where somebody will read it:
 * such a person cannot receive a reset link. An owner sets their password for
 * them, or they re-subscribe from the link in any earlier message.
 */
export async function suppressedForUser(
  userId: number, email: string
): Promise<SuppressionState> {
  const plat = await suppressionState('email', email, null);
  if (plat.suppressed) return plat;

  const rows = await mq<RowDataPacket[]>(
    'SELECT company_id FROM memberships WHERE user_id = ?', [userId]
  ).catch(() => [] as RowDataPacket[]);

  for (const r of rows) {
    const state = await suppressionState('email', email, Number(r.company_id));
    if (state.suppressed) return state;
  }
  return { suppressed: false };
}

/* -------------------------------------------------------- entering an email */

/**
 * The half that is easy to leave out: the CRM refusing the entry.
 *
 * Returns a sentence to show the person typing, or null if the address is fine.
 * The message names what happened and when, because "invalid email" on a
 * perfectly valid address is the kind of error that costs somebody twenty
 * minutes and a phone call.
 */
export async function refuseEmail(
  companyId: number, email: string | null | undefined, context = 'a customer record'
): Promise<string | null> {
  if (!email) return null;
  const state = await suppressionState('email', email, companyId);
  if (!state.suppressed) return null;

  await noteSuppressionHit(companyId, 'email', email, context);

  const when = state.since
    ? state.since.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'previously';

  if (state.where === 'platform') {
    return `${email} cannot receive email — it bounced as undeliverable on ${when}. ` +
           `Check the spelling with the customer, or leave it blank and use their phone.`;
  }
  return `${email} unsubscribed on ${when} and cannot be emailed. ` +
         `It can go back on only if the customer re-subscribes themselves — ` +
         `send them the link from the file, or leave the address blank.`;
}
