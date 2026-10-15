import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { Caps } from '../permissions';

/**
 * Referrals. A referral lead has an outside referrer — insurance agent,
 * adjuster / carrier, dealer, past customer. Staff are never referrers: a lead
 * a salesperson writes is their sale and earns commission, not a fee.
 *
 * The fee is set on the lead (Fee / No fee, amount defaulting from the
 * referrer). It is EARNED when the referred car is picked up and pays the
 * Friday after, Wednesday cut-off. Voided: no fee. Total loss: held until a
 * sales manager or money role decides. Paid by money roles off the payout list.
 */

export const REFERRER_KINDS = [
  { key: 'agent', label: 'Insurance agent' },
  { key: 'adjuster', label: 'Adjuster / carrier' },
  { key: 'dealer', label: 'Dealer' },
  { key: 'past_customer', label: 'Past customer' }
] as const;
export type ReferrerKind = typeof REFERRER_KINDS[number]['key'];

export const W9_LIMIT_CENTS = 60000;

export const digits10 = (v: unknown) => {
  const d = String(v ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? d : '';
};

/** May change Fee / No fee and the amount after the lead is written, and decide a total loss. */
export const mayEditFee = (c: Caps) => !!(c.salesManager || c.money);

/** The Friday a fee earned on `d` is paid: picked up Sun–Wed → that Friday; Thu–Sat → the next. */
export function payFriday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  x.setDate(x.getDate() + (day <= 3 ? 5 - day : 12 - day));
  return x;
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export type RefStateKey = 'open' | 'lost' | 'owed_pickup' | 'held' | 'owed' | 'paid' | 'no_fee' | 'void';

export interface RefRow {
  lead_id: number; lead_number: string; lead_state: string; customer: string; vehicle: string | null;
  referrer_id: number; referrer_name: string; referrer_kind: string; payee_default: string | null;
  referral_no_fee: number; referral_fee_cents: number | null; referral_payee: string | null;
  referral_tl_decision: string | null; referral_tl_by: string | null;
  ro_id: number | null; ro_number: string | null; closed_at: Date | null; total_loss_at: Date | null; voided_at: Date | null;
  paid_id: number | null; paid_at: Date | null; paid_amount: number | null; paid_payee: string | null;
  paid_method: string | null; paid_reference: string | null;
}

export interface RefState { key: RefStateKey; label: string; earnedAt: string | null; payDate: string | null; payee: string; feeCents: number }

export function refState(r: RefRow): RefState {
  const fee = Number(r.referral_fee_cents) || 0;
  const payee = r.paid_payee || r.referral_payee || (r.referrer_kind === 'dealer' ? r.payee_default : null) || r.referrer_name;
  const base = { payee, feeCents: fee, earnedAt: null as string | null, payDate: null as string | null };
  const day = (d: Date | null) => d ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  if (r.paid_at) {
    return { ...base, feeCents: Number(r.paid_amount) || fee, key: 'paid', label: `Paid ${day(r.paid_at)}` };
  }
  if (r.referral_no_fee) return { ...base, key: 'no_fee', label: 'No fee' };
  if (r.voided_at) return { ...base, key: 'void', label: 'No fee · RO voided' };
  if (!r.ro_id) return r.lead_state === 'lost'
    ? { ...base, key: 'lost', label: 'Lead lost' }
    : { ...base, key: 'open', label: 'Open lead' };
  if (r.total_loss_at) {
    if (!r.referral_tl_decision) return { ...base, key: 'held', label: 'Total loss · held for a manager' };
    if (r.referral_tl_decision === 'none') return { ...base, key: 'no_fee', label: `No fee · total loss (${r.referral_tl_by ?? 'manager'})` };
    const at = new Date(r.total_loss_at), pf = payFriday(at);
    return { ...base, key: 'owed', earnedAt: ymd(at), payDate: ymd(pf), label: `Owed · payout ${day(pf)}` };
  }
  if (!r.closed_at) return { ...base, key: 'owed_pickup', label: `RO ${r.ro_number} in the shop · owed at pick-up` };
  const at = new Date(r.closed_at), pf = payFriday(at);
  return { ...base, key: 'owed', earnedAt: ymd(at), payDate: ymd(pf), label: `Picked up ${day(at)} · payout ${day(pf)}` };
}

const REF_SELECT = `
  SELECT l.id AS lead_id, l.lead_number, l.state AS lead_state,
         TRIM(CONCAT_WS(' ', l.first_name, l.last_name)) AS customer, l.vehicle_text AS vehicle,
         f.id AS referrer_id, f.name AS referrer_name, f.kind AS referrer_kind, f.payee_default,
         l.referral_no_fee, l.referral_fee_cents, l.referral_payee, l.referral_tl_decision, l.referral_tl_by,
         r.id AS ro_id, r.ro_number, r.closed_at, r.total_loss_at, r.voided_at,
         p.id AS paid_id, p.paid_at, p.amount_cents AS paid_amount, p.payee AS paid_payee,
         p.method AS paid_method, p.reference AS paid_reference
  FROM leads l
  JOIN referrers f ON f.id = l.referrer_id
  LEFT JOIN repair_orders r ON r.id = l.ro_id
  LEFT JOIN referral_payouts p ON p.lead_id = l.id
  WHERE l.deleted_at IS NULL`;

export async function referrals(cid: number, where: string, params: unknown[]): Promise<Array<RefRow & { state: RefState }>> {
  const rows = await tq<Array<RefRow & RowDataPacket>>(cid, `${REF_SELECT} AND ${where} ORDER BY l.received_at DESC`, params);
  return rows.map(r => ({ ...r, state: refState(r) }));
}

/** What a referrer has been paid this calendar year, and what is owed on fees earned this year. */
export async function yearTotals(cid: number, referrerId: number) {
  const year = new Date().getFullYear();
  const list = await referrals(cid, 'l.referrer_id = ?', [referrerId]);
  let paid = 0, owed = 0;
  for (const r of list) {
    if (r.state.key === 'paid' && r.paid_at && new Date(r.paid_at).getFullYear() === year) paid += r.state.feeCents;
    if (r.state.key === 'owed' && r.state.earnedAt && Number(r.state.earnedAt.slice(0, 4)) === year) owed += r.state.feeCents;
  }
  return { paidCents: paid, owedCents: owed };
}

/**
 * Who this might already be. Phone (ten digits) or email is a match; name
 * PLUS address is a weaker possible match; a name alone never matches.
 */
export async function matchPeople(cid: number, k: { phone?: string; email?: string; name?: string; address?: string }) {
  const ph = digits10(k.phone), em = String(k.email ?? '').trim().toLowerCase();
  const nm = String(k.name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const ad = String(k.address ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const out = { referrers: [] as RowDataPacket[], clients: [] as RowDataPacket[], possible: [] as RowDataPacket[] };
  if (ph || em) {
    out.referrers = await tq<RowDataPacket[]>(cid, `
      SELECT id, kind, name, company, phone, email, address, city, addr_state, zip, default_fee_cents, client_id
      FROM referrers WHERE active = 1 AND ((? <> '' AND phone = ?) OR (? <> '' AND LOWER(email) = ?)) LIMIT 5`,
      [ph, ph, em, em]);
    out.clients = await tq<RowDataPacket[]>(cid, `
      SELECT id, kind, name, phone, email, address, city, state, zip FROM clients
      WHERE active = 1 AND kind = 'retail'
        AND ((? <> '' AND (RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', ''), 10) = ?
                       OR RIGHT(REGEXP_REPLACE(COALESCE(phone2,''), '[^0-9]', ''), 10) = ?))
          OR (? <> '' AND LOWER(email) = ?)) LIMIT 5`, [ph, ph, ph, em, em]);
  }
  if (nm && ad && !out.clients.length) {
    out.possible = await tq<RowDataPacket[]>(cid, `
      SELECT id, kind, name, phone, email, address, city, state, zip FROM clients
      WHERE active = 1 AND kind = 'retail' AND LOWER(TRIM(name)) = ? AND LOWER(TRIM(address)) = ? LIMIT 5`, [nm, ad]);
  }
  return out;
}

/** The referral on one lead or one RO, as the lead detail and the board drawer show it. */
export async function referralFor(cid: number, by: 'lead' | 'ro', id: number, caps: Caps) {
  const [r] = await referrals(cid, by === 'lead' ? 'l.id = ?' : 'l.ro_id = ?', [id]);
  if (!r) return null;
  const money = !!(caps.money || caps.salesManager);
  return {
    leadId: r.lead_id, leadNumber: r.lead_number,
    referrer: { id: r.referrer_id, name: r.referrer_name, kind: r.referrer_kind },
    noFee: !!r.referral_no_fee, feeCents: money ? r.state.feeCents : null, payee: r.state.payee,
    state: r.state.key, label: r.state.label, tlDecision: r.referral_tl_decision,
    canEdit: mayEditFee(caps) && r.state.key !== 'paid'
  };
}

export async function referrerById(cid: number, id: number) {
  return tqOne<RowDataPacket>(cid, 'SELECT * FROM referrers WHERE id = ?', [id]);
}

export interface NewReferrer {
  kind?: string; name?: string; company?: string; phone?: string; email?: string;
  address?: string; city?: string; addrState?: string; zip?: string;
  defaultFeeCents?: number | null; payeeDefault?: string | null; fromClientId?: number | null;
}

/**
 * Make a referrer, or return the one that already has this phone or email —
 * a number that is already a referrer picks that referrer; no duplicate is
 * made. From a client, the address, email and phone come across, the type is
 * Past customer and the referrer is linked to the client (and so their repairs).
 */
export async function createReferrer(cid: number, n: NewReferrer, userId: number): Promise<{ id: number; existed: boolean }> {
  let src = { ...n };
  if (n.fromClientId) {
    const c = await tqOne<RowDataPacket>(cid, 'SELECT * FROM clients WHERE id = ?', [n.fromClientId]);
    if (!c) throw Object.assign(new Error('No such client'), { code: 404 });
    const linked = await tqOne<RowDataPacket>(cid, 'SELECT id FROM referrers WHERE client_id = ? AND active = 1 LIMIT 1', [c.id]);
    if (linked) return { id: Number(linked.id), existed: true };
    src = { ...n, kind: 'past_customer', name: n.name || c.name, phone: n.phone || c.phone, email: n.email || c.email,
      address: n.address || c.address, city: n.city || c.city, addrState: n.addrState || c.state, zip: n.zip || c.zip };
  }
  const name = String(src.name ?? '').trim();
  if (!name) throw Object.assign(new Error('A referrer needs a name.'), { code: 400 });
  if (!REFERRER_KINDS.some(k => k.key === src.kind)) throw Object.assign(new Error('Pick the referrer type.'), { code: 400 });
  const ph = digits10(src.phone), em = String(src.email ?? '').trim().toLowerCase() || null;
  if (!ph && !em) throw Object.assign(new Error('A referrer needs a phone or an email, so they can be found again.'), { code: 400 });
  const dup = await tqOne<RowDataPacket>(cid,
    `SELECT id FROM referrers WHERE active = 1 AND ((? <> '' AND phone = ?) OR (? IS NOT NULL AND LOWER(email) = ?)) LIMIT 1`,
    [ph, ph, em, em]);
  if (dup) return { id: Number(dup.id), existed: true };
  const r = await texec(cid, `
    INSERT INTO referrers (kind, name, company, phone, email, address, city, addr_state, zip, client_id,
                           default_fee_cents, payee_default, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [src.kind, name, src.company || null, ph || null, em, src.address || null, src.city || null, src.addrState || null,
     src.zip || null, n.fromClientId || null, src.defaultFeeCents ?? null, src.payeeDefault || null, userId]);
  return { id: Number((r as { insertId: number }).insertId), existed: false };
}
