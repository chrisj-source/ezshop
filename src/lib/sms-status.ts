import { RowDataPacket } from 'mysql2/promise';
import { mqOne } from '../db/master';
import { tq, tqOne } from '../db/tenant';
import { companyFeatures } from '../middleware/context';
import { sendSms, smsReady, STOP_LINE } from './sms';

/**
 * Status update texts. The shop writes the wording (Admin › Text updates); the
 * binding of each update to statuses and lanes is ours, keyed on slot ids and
 * lane keys so renaming a status never moves a text. A status the shop added
 * (lib/statuses.ts) has its own row, bound by sms_templates.slot_id.
 *
 * Each update goes once per file — except Supplement Needed, which goes each
 * time a file goes back for one. A refused send counts as sent for that rule:
 * a file that had no consent at Arrived does not get Arrived later.
 */

const SLOT_TRIGGER: Record<string, string> = {
  'intake.arrived': 'arrived',
  'parts.ordered': 'parts_ordered',
  'parts.backordered': 'parts_backordered',
  'lane.sublet.at': 'sublet',
  'qa.detail': 'detail',
  'qa.qc.final': 'final_qc',
  'ready.payment': 'payment',
  'ready.contacted': 'contacted',
  'ready.vehicle': 'ready',
  'deliver.pickup': 'picked'
};

const LANE_TRIGGER: Record<string, string> = {
  pdr: 'lane_pdr', body: 'lane_body', prep: 'lane_paint', paint: 'lane_paint',
  reassembly: 'lane_reassembly', buff: 'lane_buff', detail: 'detail'
};

const REPEATS = new Set(['supp_needed']);

export const TOKENS = ['[ first name ]', '[ vehicle ]', '[ shop name ]', '[ shop phone ]', '[ RO ]', '[ pickup date ]'];

export interface FileFacts {
  firstName: string; vehicle: string; shopName: string; shopPhone: string; ro: string; pickupDate: string;
}

export function fill(body: string, f: FileFacts): string {
  return body
    .replace(/\[\s*first name\s*\]/gi, f.firstName)
    .replace(/\[\s*vehicle\s*\]/gi, f.vehicle)
    .replace(/\[\s*shop name\s*\]/gi, f.shopName)
    .replace(/\[\s*shop phone\s*\]/gi, f.shopPhone)
    .replace(/\[\s*RO\s*\]/g, f.ro)
    .replace(/\[\s*pickup date\s*\]/gi, f.pickupDate)
    .replace(/\s{2,}/g, ' ').trim();
}

/** The full length a text goes out at, STOP line included. */
export function sentLength(filled: string): number {
  return `${filled}\n${STOP_LINE}`.length;
}

export const SAMPLE: FileFacts = {
  firstName: 'Dana', vehicle: '2021 Toyota Tacoma', shopName: '', shopPhone: '(972) 555-0100',
  ro: '482913', pickupDate: 'Fri 3 Oct'
};

export async function shopFacts(companyId: number): Promise<{ shopName: string; shopPhone: string }> {
  const co = await mqOne<RowDataPacket & { name: string }>('SELECT name FROM companies WHERE id = ?', [companyId]);
  const tel = await tqOne<RowDataPacket & { setting_value: string }>(companyId,
    "SELECT setting_value FROM shop_settings WHERE setting_key = 'shop_phone'").catch(() => null);
  return { shopName: co?.name ?? '', shopPhone: tel?.setting_value ?? '' };
}

export async function fileFacts(companyId: number, roId: number): Promise<(FileFacts & { phone: string | null }) | null> {
  const r = await tqOne<RowDataPacket>(companyId, `
    SELECT r.ro_number, c.name, c.phone, v.year, v.make, v.model
      FROM repair_orders r LEFT JOIN clients c ON c.id = r.client_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = ?`, [roId]);
  if (!r) return null;
  const pick = await tqOne<RowDataPacket & { starts_at: Date }>(companyId, `
    SELECT starts_at FROM appointments WHERE ro_id = ? AND kind = 'pickup' AND cancelled_at IS NULL
     ORDER BY starts_at DESC LIMIT 1`, [roId]).catch(() => null);
  const shop = await shopFacts(companyId);
  return {
    phone: (r.phone as string | null) ?? null,
    firstName: String(r.name ?? '').trim().split(/\s+/)[0] || 'there',
    vehicle: [r.year, r.make, r.model].filter(Boolean).join(' ') || 'vehicle',
    shopName: shop.shopName, shopPhone: shop.shopPhone,
    ro: String(r.ro_number ?? ''),
    pickupDate: pick ? new Date(pick.starts_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''
  };
}

async function approvals(companyId: number, roId: number): Promise<number> {
  const r = await tqOne<RowDataPacket & { n: number }>(companyId,
    "SELECT COUNT(*) AS n FROM ro_status_history WHERE ro_id = ? AND to_slot = 'est.approved'", [roId]);
  return Number(r?.n ?? 0);
}

/** Which update a move fires, if any. Called after the move is written. */
async function triggerFor(companyId: number, roId: number, toSlot: string,
  fromLane: string | null, toLane: string | null): Promise<string | null> {
  if (toSlot === 'est.approved') return (await approvals(companyId, roId)) === 1 ? 'approved' : null;
  if (toSlot === 'est.sent') return (await approvals(companyId, roId)) === 0 ? 'est_sent' : null;
  if (toSlot === 'est.needed') return (await approvals(companyId, roId)) > 0 ? 'supp_needed' : null;
  if (SLOT_TRIGGER[toSlot]) return SLOT_TRIGGER[toSlot];
  /* A status the shop added carries its own text, bound by slot. Switched on,
     it takes precedence over the lane update the way a built-in slot does;
     switched off, the lane update still goes as it would have. */
  const own = await tqOne<RowDataPacket & { trigger_key: string }>(companyId,
    'SELECT trigger_key FROM sms_templates WHERE slot_id = ? AND enabled = 1', [toSlot]).catch(() => null);
  if (own) return own.trigger_key;
  if (toLane && toLane !== fromLane && LANE_TRIGGER[toLane]) return LANE_TRIGGER[toLane];
  return null;
}

/**
 * Fire-and-forget from the status route. Quiet when texting is off or the
 * account is not verified — a shop without texting must not collect a refused
 * row on every move. Once texting is on, a refusal (no consent, STOP) is a row
 * on the file with its reason.
 */
export async function statusText(companyId: number, roId: number, move: {
  toSlot: string; fromLane: string | null; toLane: string | null; userId?: number | null; userName?: string | null;
}): Promise<void> {
  if (!(await companyFeatures(companyId)).includes('sms')) return;
  if (!(await smsReady(companyId))) return;

  const key = await triggerFor(companyId, roId, move.toSlot, move.fromLane, move.toLane);
  if (!key) return;
  const t = await tqOne<RowDataPacket & { body: string; enabled: number }>(companyId,
    'SELECT body, enabled FROM sms_templates WHERE trigger_key = ?', [key]).catch(() => null);
  if (!t || Number(t.enabled) !== 1) return;

  if (!REPEATS.has(key)) {
    const done = await tq<RowDataPacket[]>(companyId,
      "SELECT 1 FROM sms_messages WHERE ro_id = ? AND trigger_key = ? AND direction = 'out' LIMIT 1", [roId, key]);
    if (done.length) return;
  }

  const f = await fileFacts(companyId, roId);
  if (!f || !f.phone) return;
  await sendSms(companyId, f.phone, fill(t.body, f), {
    purpose: 'transactional', roId, triggerKey: key, sentBy: move.userId ?? null, sentByName: 'Automatic'
  });
}
