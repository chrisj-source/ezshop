import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { mq } from '../db/master';
import { capsAt } from '../middleware/context';
import { notify } from '../notify';

/**
 * Split sales. A file (and the lead it came from) has a salesperson 1 and
 * optionally 2 and 3, each with a percentage; the three always add to 100.
 *
 * Salesperson 1 is the `sales` assignment, as it always was — every report
 * that reads that slot keeps working. 2 and 3 and the percentages are columns
 * beside it. Each person is paid on their OWN plan, on their share of the
 * base. The drop fee is salesperson 1's alone. A total-loss amount and a
 * late-promise deduction are split by the same percentages.
 */

export interface Split { seq: number; userId: number; pct: number }

export interface SplitInput {
  ownerPct?: number | null;
  sales2UserId?: number | null; sales2Pct?: number | null;
  sales3UserId?: number | null; sales3Pct?: number | null;
}

const pctOf = (v: unknown) => Math.round(Number(v) * 100) / 100;

/** Check a split before it is saved. Returns the error, or null. */
export function splitError(ownerId: number | null, s: SplitInput): string | null {
  const extra = [[s.sales2UserId, s.sales2Pct], [s.sales3UserId, s.sales3Pct]]
    .filter(([u]) => u) as Array<[number, number | null]>;
  if (!extra.length) return null;
  if (!ownerId) return 'Pick salesperson 1 before adding a split.';
  const ids = [ownerId, ...extra.map(([u]) => Number(u))];
  if (new Set(ids).size !== ids.length) return 'The same person is in the split twice.';
  const pcts = [pctOf(s.ownerPct ?? 0), ...extra.map(([, p]) => pctOf(p ?? 0))];
  if (pcts.some(p => !(p > 0))) return 'Every person in a split needs a percentage above 0.';
  const total = Math.round(pcts.reduce((a, b) => a + b, 0) * 100) / 100;
  if (total !== 100) return `The split adds to ${total}%. It has to come to 100%.`;
  return null;
}

/** The columns a split writes, on leads (owner_pct) or repair_orders (sales_pct). */
export function splitColumns(first: 'owner_pct' | 'sales_pct', s: SplitInput): Array<[string, unknown]> {
  const two = s.sales2UserId ? Number(s.sales2UserId) : null;
  const three = s.sales3UserId ? Number(s.sales3UserId) : null;
  const any = two || three;
  return [
    [first, any ? pctOf(s.ownerPct) : null],
    ['sales2_user_id', two], ['sales2_pct', two ? pctOf(s.sales2Pct) : null],
    ['sales3_user_id', three], ['sales3_pct', three ? pctOf(s.sales3Pct) : null]
  ];
}

/** Who shares this file's commission, salesperson 1 first. */
export async function roSplits(companyId: number, roId: number): Promise<Split[]> {
  const r = await tqOne<RowDataPacket>(companyId, `
    SELECT a.user_id AS s1, r.sales_pct, r.sales2_user_id, r.sales2_pct, r.sales3_user_id, r.sales3_pct
    FROM repair_orders r
    LEFT JOIN ro_assignments a ON a.ro_id = r.id AND a.position_key = 'sales'
    WHERE r.id = ?`, [roId]).catch(() => null);
  if (!r || !r.s1) return [];
  const out: Split[] = [{ seq: 1, userId: Number(r.s1), pct: 100 }];
  if (r.sales2_user_id) out.push({ seq: 2, userId: Number(r.sales2_user_id), pct: Number(r.sales2_pct) || 0 });
  if (r.sales3_user_id) out.push({ seq: 3, userId: Number(r.sales3_user_id), pct: Number(r.sales3_pct) || 0 });
  if (out.length > 1) out[0].pct = Number(r.sales_pct) || Math.max(0, 100 - out.slice(1).reduce((a, s) => a + s.pct, 0));
  return out;
}

/** Everyone at the shop who may change pay plans — owner and accounting, as seeded. */
export async function payPlanEditors(companyId: number): Promise<number[]> {
  const members = await mq<Array<RowDataPacket & { user_id: number }>>(
    "SELECT user_id FROM memberships WHERE company_id = ? AND status = 'active'", [companyId]).catch(() => []);
  const out: number[] = [];
  for (const m of members) if ((await capsAt(Number(m.user_id), companyId)).editPayPlans) out.push(Number(m.user_id));
  return out;
}

/**
 * Somebody in a split with no active sales pay plan — a tech put down as
 * salesperson 2. Their share is not paid until a plan exists; owner and
 * accounting are told so they can set one up or fix the split. No amounts.
 */
export async function warnNoPlan(
  companyId: number, ids: number[], where: { roId?: number | null; leadId?: number | null; label: string },
  actorUserId: number
): Promise<void> {
  if (!ids.length) return;
  const rows = await tq<Array<RowDataPacket & { user_id: number; display_name: string; active: number | null }>>(companyId, `
    SELECT s.user_id, s.display_name, p.active FROM staff s
    LEFT JOIN pay_plans p ON p.user_id = s.user_id WHERE s.user_id IN (?)`, [ids]).catch(() => []);
  const missing = ids.filter(id => {
    const r = rows.find(x => Number(x.user_id) === id);
    return !r || !Number(r.active);
  }).map(id => rows.find(x => Number(x.user_id) === id)?.display_name ?? `user ${id}`);
  if (!missing.length) return;
  await notify({
    companyId, event: 'pay.review', roId: where.roId ?? undefined, leadId: where.leadId ?? undefined,
    title: `No sales pay plan — ${where.label}`,
    body: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} in the sales split on ${where.label} with no sales pay plan, so ${missing.length === 1 ? 'that share is' : 'those shares are'} not paid. Set up a plan or change the split.`,
    actorUserId, directUserIds: await payPlanEditors(companyId), onlyDirect: true,
    dedupeKey: `noplan:${where.roId ?? 'l' + where.leadId}:${missing.join(',')}`
  }).catch(() => undefined);
}

/**
 * A lead's owner becomes the file's salesperson when the file has none and
 * the owner is set up for sales pay — the field rep who wrote it, the car drops,
 * they are the sales rep. The split comes across with them.
 */
export async function salesFromLead(companyId: number, leadId: number, roId: number, actor: { id: number; name: string }): Promise<boolean> {
  const lead = await tqOne<RowDataPacket>(companyId, `
    SELECT l.lead_number, l.owner_user_id, l.owner_pct, l.sales2_user_id, l.sales2_pct, l.sales3_user_id, l.sales3_pct,
           s.display_name, p.active
    FROM leads l LEFT JOIN staff s ON s.user_id = l.owner_user_id
    LEFT JOIN pay_plans p ON p.user_id = l.owner_user_id WHERE l.id = ?`, [leadId]).catch(() => null);
  if (!lead?.owner_user_id || !Number(lead.active)) return false;
  const has = await tqOne<RowDataPacket>(companyId,
    "SELECT user_id FROM ro_assignments WHERE ro_id = ? AND position_key = 'sales' AND user_id IS NOT NULL", [roId]);
  if (has) return false;
  await texec(companyId, `
    INSERT INTO ro_assignments (ro_id, position_key, user_id, display_name, assigned_by) VALUES (?, 'sales', ?, ?, ?)
    ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), display_name = VALUES(display_name), assigned_by = VALUES(assigned_by), assigned_at = NOW()`,
    [roId, lead.owner_user_id, lead.display_name ?? null, actor.id]);
  await texec(companyId, `
    UPDATE repair_orders SET sales_pct = ?, sales2_user_id = ?, sales2_pct = ?, sales3_user_id = ?, sales3_pct = ? WHERE id = ?`,
    [lead.owner_pct, lead.sales2_user_id, lead.sales2_pct, lead.sales3_user_id, lead.sales3_pct, roId]);
  await texec(companyId,
    `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
    [roId, `Salesperson set to ${lead.display_name ?? 'the lead owner'} from lead ${lead.lead_number}` +
      (lead.sales2_user_id ? ', with the lead\u2019s split.' : '.'), actor.id, actor.name]);
  const others = [lead.sales2_user_id, lead.sales3_user_id].filter(Boolean).map(Number);
  await warnNoPlan(companyId, others, { roId, label: `lead ${lead.lead_number}` }, actor.id);
  return true;
}
