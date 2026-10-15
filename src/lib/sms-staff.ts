import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne } from '../db/tenant';
import { mq } from '../db/master';
import { capsAt, companyFeatures } from '../middleware/context';
import { sendSms, smsReady } from './sms';

/**
 * Texts to the shop's own people — today, one: a file is approved.
 *
 * On by default whenever the shop texts at all (the sms feature and a verified
 * account); nothing is sent when it does not. No setup: it goes to everyone
 * holding the pay-plan capability (owner and accounting, as seeded), on the
 * phone on their own login. Admin › Text updates can switch a person off, add
 * someone else with money access, or give a different mobile. Because the
 * text carries the approval amount, a recipient must hold the money capability
 * at the moment it is sent — a role changed since is simply skipped.
 *
 * Stored with no ro_id, on purpose: the file's customer-communication thread is
 * read by roles without money, and a reply from a staff phone must never be
 * taken for a customer's reply on that file.
 */

export const STAFF_TOKENS = ['[ro]', '[vehicle]', '[amount]'];
export const APPROVAL_DEFAULT = '[ro] is approved for [vehicle], total approval: [amount]';

async function setting(cid: number, key: string): Promise<string | null> {
  const r = await tqOne<RowDataPacket & { setting_value: string | null }>(cid,
    'SELECT setting_value FROM shop_settings WHERE setting_key = ?', [key]).catch(() => null);
  return r ? r.setting_value : null;
}

export async function approvalSettings(cid: number) {
  return {
    on: (await setting(cid, 'sms_staff_approval_on')) !== '0',
    body: (await setting(cid, 'sms_staff_approval_text')) || APPROVAL_DEFAULT
  };
}

/** Everyone who may receive it, with their number and whether they do. */
export async function approvalPeople(cid: number) {
  const members = await mq<Array<RowDataPacket & { user_id: number; login_phone: string | null }>>(
    `SELECT m.user_id, u.phone AS login_phone FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.company_id = ? AND m.status = 'active'`, [cid]).catch(() => []);
  const rows = await tq<Array<RowDataPacket & { user_id: number; display_name: string; phone: string | null; approval: number | null }>>(cid, `
    SELECT s.user_id, s.display_name, x.phone, x.approval FROM staff s
    LEFT JOIN staff_sms x ON x.user_id = s.user_id`).catch(() => []);
  const out: Array<{ userId: number; name: string; phone: string | null; fromLogin: boolean; on: boolean; isDefault: boolean }> = [];
  for (const m of members) {
    const caps = await capsAt(Number(m.user_id), cid);
    if (!caps.money) continue;
    const r = rows.find(x => Number(x.user_id) === Number(m.user_id));
    const dflt = !!caps.editPayPlans;
    const on = r && r.approval !== null && r.approval !== undefined ? Number(r.approval) === 1 : dflt;
    const login = String(m.login_phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    out.push({ userId: Number(m.user_id), name: r?.display_name ?? `User ${m.user_id}`,
      phone: r?.phone || (login.length === 10 ? login : null), fromLogin: !r?.phone && login.length === 10, on, isDefault: dflt });
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

export function fillStaff(body: string, f: { ro: string; vehicle: string; amount: string }): string {
  return body.replace(/\[ro\]/gi, f.ro).replace(/\[vehicle\]/gi, f.vehicle).replace(/\[amount\]/gi, f.amount);
}

export async function approvalText(cid: number, roId: number): Promise<void> {
  if (!(await companyFeatures(cid)).includes('sms') || !(await smsReady(cid))) return;
  const s = await approvalSettings(cid);
  if (!s.on) return;
  const ro = await tqOne<RowDataPacket>(cid, `
    SELECT r.ro_number, r.amount_cents, TRIM(CONCAT_WS(' ', v.year, v.make, v.model)) AS vehicle
    FROM repair_orders r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = ?`, [roId]);
  if (!ro) return;
  const text = fillStaff(s.body, {
    ro: `RO ${ro.ro_number}`,
    vehicle: String(ro.vehicle || 'the vehicle'),
    amount: '$' + (Number(ro.amount_cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  });
  for (const p of await approvalPeople(cid)) {
    if (!p.on || !p.phone) continue;
    await sendSms(cid, p.phone, text, { purpose: 'staff', roId: null, sentBy: null, sentByName: 'System', triggerKey: 'staff.approval' })
      .catch(() => undefined);
  }
}
