import { mexec, mq, mqOne } from '../db/master';
import { RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { noteSuppressionHit, suppressionState, unsubscribeUrl } from './suppression';

/**
 * Mail out.
 *
 * Resend does the delivery. The domain's SPF and DKIM are already live there,
 * which is the only thing that decides whether a message lands in an inbox or a
 * spam folder — a droplet sending for itself would do neither well, and
 * DigitalOcean blocks port 25 by default anyway.
 *
 * **This talks to Resend over HTTPS rather than SMTP.** Same provider, same
 * domain, same signing keys; the difference is that the API needs no dependency
 * installed on a live box, no local queue to babysit and no TLS handshake to
 * debug at 6am. If you would rather have SMTP, it is a small swap — say so and
 * I will wire nodemailer against smtp.resend.com:465 instead.
 *
 * Nothing here throws upward. A message that cannot be sent is recorded as a
 * failed delivery against the notification it belongs to; the app carries on.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** The shop it is about, so the From line can say so. */
  shopName?: string | null;
  replyTo?: string | null;
  /**
   * Which shop is sending. Needed for the suppression check, because an
   * unsubscribe is per shop — without it only the platform list (bounces and
   * complaints) can be honoured.
   */
  companyId?: number | null;
  /** What this was, for the suppression_hits row if it is refused. */
  context?: string;
}

export interface MailResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** Not sent because the address said no. Not a failure — do not retry it. */
  suppressed?: boolean;
}

/**
 * "Bob's Body Barn via Easy Shop <donotreply@easyshopauto.com>" — the shop is in
 * the display name so a tech with two shops knows which one is talking, while
 * the address stays one verified domain.
 */
function fromLine(shopName?: string | null): string {
  const who = shopName ? `${shopName.replace(/["<>]/g, '')} via Easy Shop` : 'Easy Shop';
  return `${who} <${config.mail.from}>`;
}

/**
 * How many sends have failed in a row. Five in a row is an outage worth
 * telling somebody about; one bad address is not. The count lives in memory
 * because it is about *now* — a restart starting from zero is correct.
 */
let failStreak = 0;
let alerted = false;

export function mailHealth(): { failStreak: number; alerting: boolean; configured: boolean } {
  return { failStreak, alerting: alerted, configured: !!config.mail.apiKey };
}

async function noteOutage(lastError: string): Promise<void> {
  if (alerted) return;
  alerted = true;
  /* Deliberately not an email. Telling somebody that email is broken by email
     is a joke that writes itself — this lands in the platform log, which the
     platform screen reads on sign-in. */
  await mexec(
    `INSERT INTO platform_audit (actor_user_id, company_id, action, detail)
     VALUES (NULL, NULL, 'mail.failing', ?)`,
    [JSON.stringify({ failStreak, lastError, at: new Date().toISOString() })]
  ).catch(() => undefined);
}

export async function sendMail(m: Mail): Promise<MailResult> {
  if (!config.mail.apiKey) {
    return { ok: false, error: 'No RESEND_API_KEY on this box — mail is switched off.' };
  }

  /**
   * The suppression check lives HERE and nowhere else.
   *
   * Every send in the application goes through this function, so this is the
   * only place that can promise an unsubscribed address is never written to.
   * Putting it in each caller would mean the one caller somebody forgets is the
   * one that breaks the promise.
   *
   * It applies to transactional mail too — password resets included. That was
   * the call on 15 Sep 2026: if they unsubscribe, they unsubscribe. The
   * consequence is that such a person cannot reset their own password and an
   * owner has to set it for them, or they re-subscribe first. The error below
   * says so rather than reading as a delivery fault.
   *
   * A refusal is NOT a failure: it does not touch the fail streak, because the
   * provider is working perfectly and five of these in a row is not an outage.
   */
  const state = await suppressionState('email', m.to, m.companyId ?? null);
  if (state.suppressed) {
    if (m.companyId) {
      await noteSuppressionHit(m.companyId, 'email', m.to, m.context ?? m.subject);
    }
    return {
      ok: false, suppressed: true,
      error: state.where === 'platform'
        ? `${m.to} is undeliverable — it bounced, so nothing is sent to it.`
        : `${m.to} unsubscribed, so nothing is sent to it. They can switch it ` +
          `back on themselves from the link in any earlier message.`
    };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.mail.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from: fromLine(m.shopName),
        to: [m.to],
        reply_to: m.replyTo ?? config.mail.replyTo,
        subject: m.subject,
        text: m.text,
        /**
         * One-click unsubscribe, as the mailbox providers want it. Gmail and
         * Outlook draw their own Unsubscribe control from these two headers,
         * and a message that offers one is far less likely to be marked as
         * spam than one where the only way out is the footer link. The POST
         * target is the same endpoint the page uses.
         */
        ...(m.companyId ? { headers: {
          'List-Unsubscribe': `<${unsubscribeUrl(m.companyId, 'email', m.to)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        } } : {}),
        ...(m.html ? { html: m.html } : {})
      })
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      failStreak++;
      const error = String((body as { message?: string }).message ?? `HTTP ${res.status}`);
      if (failStreak >= config.mail.alertAfter) await noteOutage(error);
      return { ok: false, error };
    }

    failStreak = 0;
    alerted = false;
    return { ok: true, id: String((body as { id?: string }).id ?? '') };
  } catch (e) {
    failStreak++;
    const error = (e as Error).message;
    if (failStreak >= config.mail.alertAfter) await noteOutage(error);
    return { ok: false, error };
  }
}

/* ------------------------------------------------------------------ events */

/**
 * The eight kinds of notification, and how noisy each one is.
 *
 * `weight` is the honest answer to "how often will this reach me": *rare* is a
 * handful a month, *some* a few a week, *noisy* many a day. It is shown on the
 * screen next to each switch, because a preference you cannot predict the cost
 * of is not a real choice.
 *
 * `defaultOn` is the starting set when somebody switches email on: the four
 * that are about them or about something going wrong. Status changes, parts
 * arriving and parts running late are the shop's own chatter — they are in the
 * app, where chatter belongs.
 */
export const EMAIL_EVENTS: Array<{
  key: string; label: string; fires: string;
  weight: 'rare' | 'some' | 'noisy'; defaultOn: boolean; scoped?: boolean;
}> = [
  { key: 'lead.chase', label: 'A lead of mine has gone quiet',
    fires: 'nobody has contacted a lead inside the shop\'s window',
    weight: 'some', defaultOn: true },
  { key: 'mention', label: 'Somebody tags me in a note',
    fires: 'your name is written in a note on a file',
    weight: 'some', defaultOn: true },
  { key: 'assign.file', label: 'A car is assigned to me',
    fires: 'somebody puts your name on a file',
    weight: 'some', defaultOn: true },
  { key: 'supp.decision', label: 'A supplement is approved or denied',
    fires: 'the carrier answers',
    weight: 'rare', defaultOn: true },
  { key: 'age.red', label: 'A file goes red',
    fires: 'a car sits past the age you set',
    weight: 'rare', defaultOn: true },
  { key: 'sms.reply', label: 'A customer texts back',
    fires: 'a reply lands on a file',
    weight: 'some', defaultOn: true },
  { key: 'parts.late', label: 'A part is late',
    fires: 'an ETA passes with nothing received',
    weight: 'some', defaultOn: false },
  { key: 'parts.return', label: 'A part is flagged to go back',
    fires: 'somebody marks a line for return',
    weight: 'rare', defaultOn: false },
  { key: 'parts.arrived', label: 'Parts arrive',
    fires: 'a line is received at the parts desk',
    weight: 'noisy', defaultOn: false },
  { key: 'status.change', label: 'A car changes status',
    fires: 'any move on the board you are routed for',
    weight: 'noisy', defaultOn: false, scoped: true }
];

export interface EventPref { key: string; enabled: boolean; scope: 'all' | 'mine' }

/** What this person has chosen. Absent is off, so an empty list means silence. */
export async function eventPrefs(userId: number): Promise<Map<string, EventPref>> {
  const rows = await mq<RowDataPacket[]>(
    'SELECT event_key, enabled, scope FROM user_email_events WHERE user_id = ?', [userId]
  ).catch(() => [] as RowDataPacket[]);

  const out = new Map<string, EventPref>();
  for (const r of rows) {
    out.set(String(r.event_key), {
      key: String(r.event_key),
      enabled: r.enabled === 1,
      scope: r.scope === 'all' ? 'all' : 'mine'
    });
  }
  return out;
}

/** The starting set, written when somebody switches email on for the first time. */
export async function seedEventPrefs(userId: number): Promise<void> {
  for (const e of EMAIL_EVENTS.filter(x => x.defaultOn)) {
    await mexec(
      `INSERT IGNORE INTO user_email_events (user_id, event_key, enabled, scope)
       VALUES (?, ?, 1, 'mine')`, [userId, e.key]).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ people */

/**
 * May this person be emailed right now?
 *
 * Four answers have to be yes: they have an address, they asked for email (off
 * by default — everyone already gets the in-app copy), **this event is one they
 * chose**, and they have not had one in the last quarter of an hour. A busy
 * afternoon on the board can raise a dozen notifications for one person, and a
 * dozen emails about them is how somebody decides to ignore all of them.
 *
 * `assignedToFile` is asked only for a scoped event: status changes on every
 * car in the shop are a different proposition from status changes on the three
 * this person is working.
 */
export async function emailableUser(
  userId: number,
  event?: string,
  assignedToFile?: () => Promise<boolean>
): Promise<{ email: string; name: string } | null> {
  const row = await mqOne<RowDataPacket>(
    `SELECT email, name, email_opt_in, last_email_at FROM users WHERE id = ? AND status = 'active'`,
    [userId]
  );
  if (!row || !row.email || row.email_opt_in !== 1) return null;
  const email = String(row.email);
  const name = String(row.name);

  if (event) {
    const prefs = await eventPrefs(userId);
    const pref = prefs.get(event);
    if (!pref || !pref.enabled) return null;

    /* A scoped event set to "mine" has to actually be theirs. */
    const def = EMAIL_EVENTS.find(e => e.key === event);
    if (def?.scoped && pref.scope === 'mine' && assignedToFile) {
      if (!(await assignedToFile())) return null;
    }
  }

  if (row.last_email_at) {
    const since = Date.now() - new Date(row.last_email_at).getTime();
    if (since < config.mail.throttleMinutes * 60 * 1000) return null;
  }
  return { email, name };
}

export async function stampEmailed(userId: number): Promise<void> {
  await mexec('UPDATE users SET last_email_at = NOW() WHERE id = ?', [userId]).catch(() => undefined);
}

/* ----------------------------------------------------------------- letters */

/**
 * The shell every message shares. Plain, narrow, and readable in a preview.
 *
 * `unsubscribeUrl` puts a real unsubscribe line in the footer. Pass it for
 * anything automated; leave it off only where there is genuinely nothing to
 * unsubscribe from.
 */
export function letter(
  title: string, lines: string[],
  action?: { label: string; url: string },
  unsubscribeUrl?: string | null
): { text: string; html: string } {
  const foot = unsubscribeUrl
    ? 'Stop getting these: ' + unsubscribeUrl
    : 'You are getting this because email is switched on for your Easy Shop account. ' +
      'Turn it off under Account.';

  const text = [title, '', ...lines, ...(action ? ['', action.label + ': ' + action.url] : []),
    '', foot, '', '— Easy Shop'].join('\n');

  const footHtml = unsubscribeUrl
    ? `You are getting this because your vehicle is with the shop named above.
       <a href="${esc(unsubscribeUrl)}" style="color:#d9a441">Unsubscribe</a> and nothing
       further will be sent to this address.`
    : `You are getting this because email is switched on for your Easy Shop account.
       Turn it off under Account.`;

  const html = `<!doctype html><html><body style="margin:0;background:#131c2e;padding:24px;
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#1c2740;border:1px solid #2c3a55;
      border-radius:8px;padding:22px 24px;color:#e7eaf2">
      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#d9a441;
        margin-bottom:14px">Easy Shop</div>
      <div style="font-size:17px;font-weight:500;margin-bottom:12px">${esc(title)}</div>
      ${lines.map(l => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#aab3c4">${esc(l)}</p>`).join('')}
      ${action ? `<p style="margin:18px 0 0"><a href="${esc(action.url)}"
        style="display:inline-block;padding:10px 16px;background:#d9a441;color:#131c2e;
        text-decoration:none;border-radius:5px;font-weight:600;font-size:14px">${esc(action.label)}</a></p>` : ''}
      <p style="margin:20px 0 0;font-size:11.5px;color:#9aa6bc">${footHtml}</p>
    </div></body></html>`;

  return { text, html };
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
