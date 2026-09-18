import { RowDataPacket, ResultSetHeader, PoolConnection } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';

/**
 * TCPA consent — the record that somebody agreed to be contacted.
 *
 * Raised 17 Sep 2026, the day after the booking form shipped: the form was
 * collecting a phone number and promising contact, and nothing recorded that
 * the customer had agreed to any of it.
 *
 * The distinction everything here turns on:
 *
 *   **Marketing** consent is the ticked box. Express, written, revocable, and
 *   under TCPA it cannot be a condition of the sale — so the booking goes
 *   through whether or not it is ticked. The shop's own disclosure says
 *   "consent is not a condition of purchase", and a required box would make
 *   that sentence a lie on the shop's own website.
 *
 *   **Transactional** consent is implied by the act of booking and is
 *   deliberately narrow: messages about the car they just booked, and nothing
 *   after it is delivered. It is written down rather than assumed, so "why did
 *   we text this person" always has an answer.
 *
 * `mayContact` is the single gate, the same shape as `sendMail` being the only
 * place the suppression list is checked. A caller that asks its own question is
 * a caller that will get a different answer from everybody else.
 */

export type Channel = 'sms' | 'email';
export type ConsentKind = 'marketing' | 'transactional';

/** The stored form. Two spellings of one destination must not be two records. */
export function normalise(channel: Channel, destination: string): string {
  const d = String(destination ?? '').trim();
  return channel === 'email' ? d.toLowerCase() : d.replace(/\D/g, '');
}

/* ------------------------------------------------------------- the wording */

export interface ConsentText {
  label: string;
  body: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  approvedAt: Date | null;
  approvedName: string | null;
}

export async function consentText(companyId: number): Promise<ConsentText | null> {
  const r = await tqOne<RowDataPacket>(companyId,
    'SELECT * FROM funnel_consent WHERE id = 1').catch(() => null);
  if (!r) return null;
  return {
    label: String(r.label ?? 'Text me about my repair.'),
    body: r.body ? String(r.body) : null,
    privacyUrl: r.privacy_url ? String(r.privacy_url) : null,
    termsUrl: r.terms_url ? String(r.terms_url) : null,
    approvedAt: r.approved_at ? new Date(r.approved_at as string) : null,
    approvedName: r.approved_name ? String(r.approved_name) : null
  };
}

/**
 * Is the shop's own wording usable?
 *
 * The form will not switch on until this passes, which is the one place we are
 * strict: a shop that turns booking on without having been near the consent tab
 * would otherwise collect phone numbers against no disclosure at all.
 */
export async function consentReady(companyId: number): Promise<boolean> {
  const t = await consentText(companyId);
  return !!(t && t.approvedAt && t.body && !missingFromConsent(t.body).length);
}

/** The draft's blank, which a shop must replace with its own name. */
const UNFILLED = /_{3,}/;

/**
 * What a disclosure is missing, in the words the screen shows.
 *
 * Loose by design. "Text STOP to quit" has met the opt-out requirement and
 * refusing it because it does not match a template would only teach shops to
 * paste words they have not read. What is checked is that each of the four
 * ideas is present in some form.
 */
export function missingFromConsent(body: string): string[] {
  const t = String(body ?? '').toLowerCase();
  const out: string[] = [];

  if (UNFILLED.test(body)) {
    out.push('The blank is still in it — put the shop\u2019s name where the underscores are.');
  }
  if (!/\bstop\b/.test(t)) {
    out.push('No way to opt out. It has to say to reply STOP, in those words — ' +
      'that is the word the carriers and the phones act on.');
  }
  if (!/\bhelp\b/.test(t)) {
    out.push('No way to get help. Say to reply HELP.');
  }
  if (!/(message and data rates|data rates|msg&data|rates may apply)/.test(t)) {
    out.push('It does not say message and data rates may apply.');
  }
  if (!/(not a condition|no purchase necessary|not required to (buy|purchase))/.test(t)) {
    out.push('It does not say consent is not a condition of purchase. ' +
      'That line is why the box is allowed to be optional.');
  }
  if (!/(text|sms|message)/.test(t)) {
    out.push('It does not say what they are agreeing to receive. Name text messages.');
  }

  return out;
}

/* -------------------------------------------------------------- recording */

export interface RecordConsent {
  kind: ConsentKind;
  channel: Channel;
  destination: string;
  granted: boolean;
  source?: string;
  wordingShown?: string | null;
  boxesTicked?: string | null;
  pageUrl?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  submission?: unknown;
  funnelRequestId?: number | null;
  roId?: number | null;
  appointmentId?: number | null;
}

/**
 * Write the record. Inside the caller's transaction where there is one, so a
 * booking and the consent that came with it cannot be half-saved.
 *
 * A DECLINE is recorded too, and that is not bookkeeping for its own sake: "we
 * asked and they said no" is a different fact from "nobody ever asked", and
 * only one of them means somebody should pick up the phone instead.
 */
export async function recordConsent(
  companyId: number, c: RecordConsent, conn?: PoolConnection
): Promise<number | null> {
  const dest = normalise(c.channel, c.destination);
  if (!dest) return null;

  const sql = `
    INSERT INTO consents
      (kind, channel, destination, granted, source, wording_shown, boxes_ticked,
       page_url, submit_ip, user_agent, submission, funnel_request_id, ro_id, appointment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const vals = [
    c.kind, c.channel, dest, c.granted ? 1 : 0, c.source ?? 'web_form',
    /* Copied, never referenced. The shop will reword this over the years and a
       reference would follow the edit, which would make the record describe
       something the customer never saw. */
    c.wordingShown ?? null,
    c.boxesTicked ?? null,
    (c.pageUrl ?? '').slice(0, 400) || null,
    c.ip ?? null,
    (c.userAgent ?? '').slice(0, 255) || null,
    c.submission ? JSON.stringify(c.submission).slice(0, 8000) : null,
    c.funnelRequestId ?? null, c.roId ?? null, c.appointmentId ?? null
  ];

  if (conn) {
    const [r] = await conn.query<ResultSetHeader>(sql, vals);
    return r.insertId;
  }
  const r = await texec(companyId, sql, vals).catch(() => null);
  return r ? r.insertId : null;
}

/* ----------------------------------------------------------------- the gate */

export interface ContactState {
  /** May we send? */
  allowed: boolean;
  /** Which record allowed it, for the audit trail and for the screen. */
  basis: 'marketing' | 'transactional' | null;
  /** Why not, in words a desk screen can show. */
  reason: string | null;
  /** They were asked and said no \u2014 different from never having been asked. */
  declined: boolean;
  asked: boolean;
}

/**
 * May this shop contact this destination, for this purpose?
 *
 * Every send that is not the customer's own immediate reply has to come
 * through here. It answers separately for marketing and for a message about a
 * particular car, because those are the two things consent means.
 *
 * NOTE: this is the consent question only. Whether the address has
 * unsubscribed is the suppression list's question and is checked in `sendMail`.
 * Both have to pass; they are different facts and a person can be in one state
 * and not the other.
 */
export async function mayContact(
  companyId: number, channel: Channel, destination: string,
  purpose: 'marketing' | 'transactional', roId?: number | null
): Promise<ContactState> {
  const dest = normalise(channel, destination);
  if (!dest) {
    return { allowed: false, basis: null, reason: 'No number or address.', declined: false, asked: false };
  }

  const rows = await tq<RowDataPacket[]>(companyId, `
    SELECT kind, granted, ro_id, revoked_at, revoked_reason, created_at
      FROM consents
     WHERE channel = ? AND destination = ?
     ORDER BY created_at DESC`, [channel, dest]).catch(() => [] as RowDataPacket[]);

  const asked = rows.length > 0;
  const live = rows.filter(r => !r.revoked_at);

  const marketing = live.find(r => r.kind === 'marketing' && Number(r.granted) === 1);
  if (marketing) return { allowed: true, basis: 'marketing', reason: null, declined: false, asked };

  /* Declined, or revoked. Both are a no; only the wording differs, and the
     wording is what stops somebody at the desk trying again. */
  const declinedRow = rows.find(r => r.kind === 'marketing' && Number(r.granted) === 0);
  const revoked = rows.find(r => r.kind === 'marketing' && r.revoked_at);

  if (purpose === 'marketing') {
    return {
      allowed: false, basis: null, declined: !!declinedRow, asked,
      reason: revoked
        ? 'They opted out of messages on ' + isoDay(revoked.revoked_at as Date) + '.'
        : declinedRow
          ? 'They were asked on the booking form and did not agree to messages. Ring them instead.'
          : 'Nobody has ever asked this number for consent, so it cannot be messaged. Ring them.'
    };
  }

  /**
   * Transactional. Narrow on purpose: messages about the car they booked, and
   * nothing after it is delivered. A transactional consent that outlived the
   * repair would quietly become a standing permission nobody granted.
   */
  const trans = live.find(r =>
    r.kind === 'transactional' && Number(r.granted) === 1 &&
    (!r.ro_id || !roId || Number(r.ro_id) === Number(roId)));

  if (!trans) {
    return {
      allowed: false, basis: null, declined: !!declinedRow, asked,
      reason: 'No consent on record for this number.'
    };
  }

  /* Delivered closes it. Checked here rather than swept, so a file delivered a
     minute ago is already out of scope without waiting for a job to run. */
  if (roId) {
    const ro = await tqOne<RowDataPacket>(companyId,
      'SELECT delivered_at, closed_at FROM repair_orders WHERE id = ?', [roId]).catch(() => null);
    if (ro && (ro.delivered_at || ro.closed_at)) {
      return {
        allowed: false, basis: null, declined: !!declinedRow, asked,
        reason: 'The car has gone. Consent from the booking covered the repair, not after it — ' +
          'ask them again if they want messages.'
      };
    }
  }

  return { allowed: true, basis: 'transactional', reason: null, declined: !!declinedRow, asked };
}

/**
 * Revoke. Called when somebody replies STOP or unsubscribes, so the two are
 * one record in both directions rather than a suppression list and a consent
 * table that disagree.
 *
 * Nothing is deleted: `revoked_at` is set and the row stays. What somebody
 * consented to in March is still a true thing about March.
 */
export async function revokeConsent(
  companyId: number, channel: Channel, destination: string, reason: string
): Promise<void> {
  await texec(companyId, `
    UPDATE consents SET revoked_at = NOW(), revoked_reason = ?
     WHERE channel = ? AND destination = ? AND revoked_at IS NULL`,
    [reason.slice(0, 64), channel, normalise(channel, destination)]).catch(() => undefined);
}

/**
 * What the desk sees on a row or a file: a mark, and nothing more.
 *
 * Deliberately not a block. SMS is not built yet, and when it is this is what
 * it inherits; in the meantime the honest thing is to tell whoever is looking
 * at the file that this number cannot be texted, and let them ring.
 */
export async function consentMark(
  companyId: number, phone: string | null | undefined, roId?: number | null
): Promise<{ mark: boolean; text: string | null }> {
  if (!phone) return { mark: false, text: null };
  const state = await mayContact(companyId, 'sms', phone, 'transactional', roId ?? null);
  if (state.allowed) return { mark: false, text: null };
  return {
    mark: true,
    text: state.declined
      ? 'No texting — they declined on the booking form.'
      : state.reason
  };
}

function isoDay(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}
