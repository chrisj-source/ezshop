import crypto from 'node:crypto';
import { RowDataPacket } from 'mysql2/promise';
import { mq, mqOne, mexec } from '../db/master';
import { tq, tqOne, texec } from '../db/tenant';
import { dayWindow, shopCalendar } from './shophours';

/**
 * Web funnels — the shop's own website, into Leads and the scheduler.
 *
 * The one rule that shapes everything in here: **the public window can only
 * ever be narrower than the shop's.** `funnel_hours` does not grant time, it
 * removes it. That is why every window below is an intersection and never a
 * replacement — a shop that shortens its Friday afternoon must not find the
 * public still being offered four o'clock because a funnel row said so months
 * ago.
 *
 * The second rule: a public booking passes exactly the checks a desk booking
 * passes. `scheduleGuards` is the single gate, and this file's job is to stop
 * offering a time it would refuse, not to re-implement it.
 */

/* --------------------------------------------------------------- the key */

export interface FunnelKey { publicKey: string; companyId: number }

/**
 * A public key to a shop.
 *
 * The key is readable by anyone who views the shop's page — that is what a
 * public key is, and nothing is authorised by holding one. It says WHICH shop;
 * `originAllowed` decides whether this page may speak for it.
 */
export async function resolveKey(publicKey: string): Promise<FunnelKey | null> {
  const k = String(publicKey ?? '').trim();
  if (!/^pk_live_[0-9a-f]{20}$/.test(k)) return null;

  const row = await mqOne<RowDataPacket & { company_id: number }>(
    'SELECT company_id FROM funnel_keys WHERE public_key = ? AND revoked_at IS NULL', [k]
  ).catch(() => null);
  if (!row) return null;

  return { publicKey: k, companyId: Number(row.company_id) };
}

export function newPublicKey(): string {
  return 'pk_live_' + crypto.randomBytes(10).toString('hex');
}

/** Cheap and best effort — a shop wants to know the snippet is alive. */
export async function touchKey(publicKey: string): Promise<void> {
  await mexec('UPDATE funnel_keys SET last_seen_at = NOW() WHERE public_key = ?', [publicKey])
    .catch(() => undefined);
}

export async function keysFor(companyId: number): Promise<Array<{
  publicKey: string; createdAt: Date; lastSeenAt: Date | null;
}>> {
  const rows = await mq<RowDataPacket[]>(
    `SELECT public_key, created_at, last_seen_at FROM funnel_keys
      WHERE company_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`, [companyId]
  ).catch(() => [] as RowDataPacket[]);
  return rows.map(r => ({
    publicKey: String(r.public_key),
    createdAt: new Date(r.created_at as string),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at as string) : null
  }));
}

/* ------------------------------------------------------------ the origin */

/** The bare host of an Origin header, lowercased. Null if it is not one. */
export function hostOf(origin: string | undefined | null): string | null {
  if (!origin) return null;
  try { return new URL(origin).hostname.toLowerCase(); } catch { return null; }
}

/**
 * May a page on this host use this shop's key?
 *
 * This IS the security model. The key is public, so the allowlist is the only
 * thing standing between a scraped key and somebody else's form posting into
 * this shop's leads.
 *
 * A request with no Origin at all is refused, which is the opposite of the
 * app's own CSRF rule and deliberately so: there, a missing Origin means curl
 * and the session cookie is doing the work. Here there is no session, the
 * caller is always a browser on a page, and a browser always sends one on a
 * cross-origin request.
 */
export async function originAllowed(companyId: number, origin: string | undefined): Promise<boolean> {
  const host = hostOf(origin);
  if (!host) return false;

  const row = await tqOne<RowDataPacket>(companyId,
    'SELECT host FROM funnel_domains WHERE host = ?', [host]).catch(() => null);
  if (!row) return false;

  await texec(companyId, 'UPDATE funnel_domains SET last_seen_at = NOW() WHERE host = ?', [host])
    .catch(() => undefined);
  return true;
}

/* ----------------------------------------------------------- the settings */

export interface FunnelSettings {
  enabled: boolean;
  offerEstimate: boolean;
  offerDrop: boolean;
  holdHours: number;
  noticeHours: number;
  accent: string;
  accentInk: string;
  intro: string | null;
  replyTo: string | null;
  contrastAckAt: Date | null;
  contrastAckNote: string | null;
}

const DEFAULTS: FunnelSettings = {
  enabled: false, offerEstimate: true, offerDrop: true,
  holdHours: 24, noticeHours: 2,
  accent: '#2b2622', accentInk: '#ffffff',
  intro: null, replyTo: null, contrastAckAt: null, contrastAckNote: null
};

export async function funnelSettings(companyId: number): Promise<FunnelSettings> {
  const r = await tqOne<RowDataPacket>(companyId,
    'SELECT * FROM funnel_settings WHERE id = 1').catch(() => null);
  if (!r) return { ...DEFAULTS };
  return {
    enabled: Number(r.enabled) === 1,
    offerEstimate: Number(r.offer_estimate) === 1,
    offerDrop: Number(r.offer_drop) === 1,
    holdHours: Number(r.hold_hours ?? 24),
    noticeHours: Number(r.notice_hours ?? 2),
    accent: String(r.accent ?? DEFAULTS.accent),
    accentInk: String(r.accent_ink ?? DEFAULTS.accentInk),
    intro: r.intro ? String(r.intro) : null,
    replyTo: r.reply_to ? String(r.reply_to) : null,
    contrastAckAt: r.contrast_ack_at ? new Date(r.contrast_ack_at as string) : null,
    contrastAckNote: r.contrast_ack_note ? String(r.contrast_ack_note) : null
  };
}

/* ------------------------------------------------------------- the fields */

export interface FunnelField {
  id: number; key: string; label: string;
  kind: 'builtin' | 'text' | 'choice' | 'yesno';
  options: string[]; purpose: 'both' | 'estimate' | 'drop';
  enabled: boolean; required: boolean; sortOrder: number;
}

/** Never removable: a lead with no way to reach anybody is not a lead. */
export const REQUIRED_FIELDS = ['name', 'phone', 'email'] as const;

export async function funnelFields(companyId: number): Promise<FunnelField[]> {
  const rows = await tq<RowDataPacket[]>(companyId,
    'SELECT * FROM funnel_fields ORDER BY sort_order, id').catch(() => [] as RowDataPacket[]);

  return rows.map(r => ({
    id: Number(r.id),
    key: String(r.key_name),
    label: String(r.label),
    kind: String(r.kind) as FunnelField['kind'],
    options: String(r.options ?? '').split('\n').map(s => s.trim()).filter(Boolean),
    purpose: String(r.purpose) as FunnelField['purpose'],
    /* The three that carry the customer are on whatever the row says, because
       a row can be edited by hand in the database and the form must not lose
       its way of reaching somebody because of it. */
    enabled: (REQUIRED_FIELDS as readonly string[]).includes(String(r.key_name))
      ? true : Number(r.enabled) === 1,
    required: (REQUIRED_FIELDS as readonly string[]).includes(String(r.key_name))
      /* A custom question is never required. */
      ? true : (String(r.kind) === 'builtin' && Number(r.required) === 1),
    sortOrder: Number(r.sort_order ?? 0)
  }));
}

/* -------------------------------------------------------- the public week */

interface PublicDay { blocked: boolean; open: string | null; close: string | null }

async function publicWeek(companyId: number): Promise<Map<number, PublicDay>> {
  const rows = await tq<RowDataPacket[]>(companyId,
    'SELECT dow, blocked, open_time, close_time FROM funnel_hours').catch(() => [] as RowDataPacket[]);
  const out = new Map<number, PublicDay>();
  for (const r of rows) {
    out.set(Number(r.dow), {
      blocked: Number(r.blocked) === 1,
      open: r.open_time ? String(r.open_time) : null,
      close: r.close_time ? String(r.close_time) : null
    });
  }
  return out;
}

async function publicBlocks(companyId: number): Promise<Map<string, string>> {
  const rows = await tq<RowDataPacket[]>(companyId,
    `SELECT DATE_FORMAT(on_date, '%Y-%m-%d') AS d, label FROM funnel_blocks
      WHERE on_date >= CURDATE() AND on_date < DATE_ADD(CURDATE(), INTERVAL 120 DAY)`)
    .catch(() => [] as RowDataPacket[]);
  const out = new Map<string, string>();
  for (const r of rows) out.set(String(r.d), String(r.label));
  return out;
}

/* ------------------------------------------------------------ time in the shop */

function mins(t: string): number {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function hhmmss(m: number): string {
  const h = Math.floor(m / 60), x = m % 60;
  return `${String(h).padStart(2, '0')}:${String(x).padStart(2, '0')}:00`;
}

/** The shop's own calendar date and minute-of-day, right now. */
export function shopNow(tz: string): { ymd: string; minute: number; dow: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    minute: (Number(p.hour) % 24) * 60 + Number(p.minute),
    dow: dows[p.weekday] ?? 0
  };
}

/** Walk calendar dates from a 'YYYY-MM-DD', in the shop's own reckoning. */
function addDays(ymd: string, n: number): { ymd: string; dow: number } {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return { ymd: d.toISOString().slice(0, 10), dow: d.getUTCDay() };
}

/* -------------------------------------------------------------- the slots */

export interface SlotDay {
  date: string;            // YYYY-MM-DD
  weekday: string;         // 'Mon'
  dayNum: string;          // '22'
  slots: string[];         // 'HH:MM' shop wall clock, on the hour
  /** Why there is nothing, in words a customer reads. Null when there are slots. */
  why: string | null;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * What the public may actually be offered.
 *
 * Every exclusion here has a reason a customer could be told, and several of
 * them are the difference between an honest form and one that takes bookings
 * the shop cannot keep:
 *
 *   - the shop is shut that day, or that date
 *   - the owner blocked the weekday, or that date, from PUBLIC booking
 *   - the hour is outside the narrower public window
 *   - the day's limit for that kind is used up (held requests count — they
 *     hold an appointment row, so this is the same count the desk sees)
 *   - the hour is already taken by an appointment of any kind
 *   - it is inside the notice period, so nobody is asked to be ready in
 *     fifteen minutes for a stranger
 */
export async function publicSlots(
  companyId: number, tz: string, purpose: 'estimate' | 'drop', days = 14
): Promise<SlotDay[]> {
  const kind = purpose === 'estimate' ? 'estimate' : 'drop';
  const [cal, week, blocks, settings] = await Promise.all([
    shopCalendar(companyId, tz),
    publicWeek(companyId),
    publicBlocks(companyId),
    funnelSettings(companyId)
  ]);

  const now = shopNow(tz);
  const last = addDays(now.ymd, days - 1).ymd;

  /* Everything booked in the window, by day and by hour, in one read. A held
     request has an appointment row of its own, so nothing special is needed
     here to make a hold take up a slot — it already does. */
  const booked = await tq<RowDataPacket[]>(companyId, `
    SELECT DATE_FORMAT(starts_at, '%Y-%m-%d') AS d,
           HOUR(starts_at) AS h, kind
      FROM appointments
     WHERE cancelled_at IS NULL
       AND DATE(starts_at) BETWEEN ? AND ?`, [now.ymd, last]).catch(() => [] as RowDataPacket[]);

  const takenHours = new Map<string, Set<number>>();
  const usedOfKind = new Map<string, number>();
  for (const b of booked) {
    const d = String(b.d);
    if (!takenHours.has(d)) takenHours.set(d, new Set());
    takenHours.get(d)!.add(Number(b.h));
    if (String(b.kind) === kind) usedOfKind.set(d, (usedOfKind.get(d) ?? 0) + 1);
  }

  const capRow = await tqOne<RowDataPacket & { setting_value: string }>(companyId,
    'SELECT setting_value FROM shop_settings WHERE setting_key = ?', ['cap_' + kind]).catch(() => null);
  const cap = Number(capRow?.setting_value ?? 0);

  const out: SlotDay[] = [];

  for (let i = 0; i < days; i++) {
    const { ymd, dow } = addDays(now.ymd, i);
    const label = { date: ymd, weekday: WD[dow], dayNum: ymd.slice(8, 10) };

    const shop = dayWindow(cal, ymd, dow);
    if (shop.closed) {
      out.push({ ...label, slots: [], why: shop.label ? `Closed — ${shop.label}` : 'The shop is closed that day' });
      continue;
    }

    const pub = week.get(dow);
    if (pub?.blocked) {
      out.push({ ...label, slots: [], why: 'Not available to book online that day' });
      continue;
    }
    if (blocks.has(ymd)) {
      out.push({ ...label, slots: [], why: blocks.get(ymd) || 'Not available to book online' });
      continue;
    }

    /* The intersection, never the replacement. A public row that opens before
       the shop does is clamped rather than obeyed. */
    const open = Math.max(mins(shop.open), pub?.open ? mins(pub.open) : 0);
    const close = Math.min(mins(shop.close), pub?.close ? mins(pub.close) : 24 * 60);

    if (cap > 0 && (usedOfKind.get(ymd) ?? 0) >= cap) {
      out.push({ ...label, slots: [], why: 'Fully booked that day' });
      continue;
    }

    const taken = takenHours.get(ymd) ?? new Set<number>();
    const slots: string[] = [];

    for (let m = Math.ceil(open / 60) * 60; m + 60 <= close; m += 60) {
      const hour = m / 60;
      if (taken.has(hour)) continue;
      /* Inside the notice period. Public and desk share one day limit, so
         without this a stranger takes the last slot at 8:55 for a 9:00. */
      if (i === 0 && m < now.minute + settings.noticeHours * 60) continue;
      slots.push(hhmmss(m).slice(0, 5));
    }

    out.push({
      ...label, slots,
      why: slots.length ? null
        : i === 0 ? 'Nothing left today' : 'Nothing left that day'
    });
  }

  return out;
}

/* ------------------------------------------------------------ the letters */

export interface LetterTokens {
  firstName: string; lastName: string;
  appointmentDate: string; appointmentTime: string;
  vehicleYear: string; vehicleMake: string; vehicleModel: string;
  shopName: string; shopAddress: string; shopPhone: string;
}

/** What a shop may write in an email, and what the editor offers them. */
export const LETTER_TOKENS: Array<{ token: string; from: keyof LetterTokens; needs?: string }> = [
  { token: 'first name', from: 'firstName', needs: 'name' },
  { token: 'last name', from: 'lastName', needs: 'name' },
  { token: 'appointment date', from: 'appointmentDate' },
  { token: 'appointment time', from: 'appointmentTime' },
  { token: 'vehicle year', from: 'vehicleYear', needs: 'vehicle' },
  { token: 'vehicle make', from: 'vehicleMake', needs: 'vehicle' },
  { token: 'vehicle model', from: 'vehicleModel', needs: 'vehicle' },
  { token: 'shop name', from: 'shopName' },
  { token: 'shop address', from: 'shopAddress' },
  { token: 'shop phone', from: 'shopPhone' }
];

/**
 * Fill a shop's template.
 *
 * The awkward case is an EMPTY token, and it is not hypothetical: the shop can
 * remove the vehicle field from its own form, so `[ vehicle year ]` has nothing
 * behind it and the drop-off letter arrives as "drop off your  ." Rather than
 * print that, the whole SENTENCE carrying an empty token is dropped — a letter
 * that says less is better than one that says nothing with a gap in it.
 *
 * The settings screen refuses a token for a field the form is not collecting,
 * which is the real fix; this is what happens when a field is switched off
 * after the letter was written.
 */
export function renderLetter(template: string, tokens: LetterTokens): string {
  const value = (name: string): string | null => {
    const def = LETTER_TOKENS.find(t => t.token === name.trim().toLowerCase());
    if (!def) return null;
    const v = String(tokens[def.from] ?? '').trim();
    return v || null;
  };

  /* Sentence by sentence, keeping the terminator so the text reads as written. */
  const parts = String(template).split(/(?<=[.!?])\s+/);
  const kept: string[] = [];

  for (const sentence of parts) {
    let missing = false;
    const filled = sentence.replace(/\[\s*([^\]]+?)\s*\]/g, (_m, name: string) => {
      const v = value(name);
      if (v === null) { missing = true; return ''; }
      return v;
    });
    if (missing) continue;
    kept.push(filled.replace(/\s{2,}/g, ' ').trim());
  }

  return kept.join(' ').trim();
}

export interface FunnelLetter { subject: string; body: string; enabled: boolean }

export async function funnelLetter(
  companyId: number, eventKey: string
): Promise<FunnelLetter | null> {
  const r = await tqOne<RowDataPacket>(companyId,
    'SELECT subject, body, enabled FROM funnel_emails WHERE event_key = ?', [eventKey]
  ).catch(() => null);
  if (!r || Number(r.enabled) !== 1) return null;
  return { subject: String(r.subject), body: String(r.body), enabled: true };
}

/* ---------------------------------------------------------------- colours */

/** WCAG relative luminance of a #rrggbb. */
function luminance(hex: string): number {
  const h = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!h) return 0;
  const n = parseInt(h[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * What breaks, in the words the warning uses.
 *
 * The form is held to WCAG 2.1 AA for the same Title III reason `checkin.html`
 * is — it is a public page a shop's customers fill in. The owner may proceed
 * anyway and that acceptance is logged, but a warning that says "this may be
 * hard to read" is decoration. It has to name the thing that fails, because
 * the two failures have different fixes: the ink is theirs to change, and the
 * focus ring against a pale accent cannot be fixed by changing the ink at all.
 */
export function contrastWarnings(accent: string, ink: string): string[] {
  const out: string[] = [];

  const onButton = contrastRatio(accent, ink);
  if (onButton < 4.5) {
    out.push(
      `The button text reads at ${onButton}:1 against the button — AA wants 4.5:1. ` +
      `Change the text colour and this one goes away.`
    );
  }

  /* The ring is drawn on the form's own paper, which is the shop's page and
     therefore usually white or near it. 3:1 is the bar for a UI component. */
  const onPaper = contrastRatio(accent, '#ffffff');
  if (onPaper < 3) {
    out.push(
      `The focus outline reads at ${onPaper}:1 against a white page — AA wants 3:1 for ` +
      `a control outline. Somebody tabbing through the form with a keyboard cannot see ` +
      `where they are. No text colour fixes this; the accent itself has to be darker.`
    );
  }

  return out;
}
