/**
 * Sales pay: the plan, the triggers, and the ledger.
 *
 * A plan says how a salesperson is paid. A trigger is a stamp on a file saying
 * an event happened. The ledger is what the shop owes, one row per event per
 * file, and it is the only thing the commission report reads.
 *
 * The rule that shapes all of this: a line that has been PAID is never
 * rewritten. Recomputing a file whose lines are already paid writes an
 * adjustment row instead, positive or negative, dated to the trigger that
 * caused it. That is what makes a Tuesday mistake found on Wednesday harmless —
 * the report can be re-run all day, and anything that moves after the money went
 * out lands on the next one.
 */

import { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, tqOne, texec, withTenantTx } from '../db/tenant';

export type TriggerKey = 'arrived' | 'approval' | 'car_gone' | 'file_closed';

export const TRIGGERS: Array<{ key: TriggerKey; label: string; fires: string }> = [
  { key: 'arrived',     label: 'Vehicle arrived', fires: 'the car is dropped off' },
  { key: 'approval',    label: 'Approval',        fires: 'the file leaves Awaiting Approval for Parts' },
  { key: 'car_gone',    label: 'Car gone',        fires: 'the vehicle is delivered' },
  { key: 'file_closed', label: 'File closed',     fires: 'the file is closed' }
];

/** What a plan may take out before the percentage, and where each figure lives. */
export const DEDUCTIONS: Array<{ key: string; label: string; column: string | null; hint: string }> = [
  { key: 'parts',     label: 'Parts cost',                        column: 'parts_cost_cents',     hint: 'what the shop paid' },
  { key: 'sublet',    label: 'Sublet cost',                       column: 'sublet_cost_cents',    hint: 'vendor invoices' },
  { key: 'rental',    label: 'Rental',                            column: 'rental_cost_cents',    hint: 'billed to the shop' },
  { key: 'tax',       label: 'Sales tax liability',               column: null,                   hint: 'the shop rate, off the approval' },
  { key: 'materials', label: 'Paint materials',                   column: 'materials_cost_cents', hint: 'estimate line' },
  { key: 'towing',    label: 'Towing',                            column: 'towing_cost_cents',    hint: 'if the shop paid it' },
  { key: 'discount',  label: 'Discount and deductible assistance', column: 'discount_cents',      hint: 'anything given away' },
  { key: 'shortpay',  label: 'Insurance short-pay',               column: 'shortpay_cents',       hint: 'what never arrived' }
];

export const PAY_WHEN: Array<{ key: TriggerKey; label: string }> = [
  { key: 'approval',    label: 'Approval' },
  { key: 'car_gone',    label: 'Car gone' },
  { key: 'file_closed', label: 'File closed' }
];

export interface Plan {
  user_id: number;
  mode: 'net' | 'flat';
  rate_pct: number;
  pay_when: TriggerKey;
  drop_on: boolean;
  drop_fee_cents: number;
  drop_recover: boolean;
  tl_amount_cents: number;
  tl_pay_drop: boolean;
  active: boolean;
  deductions: string[];
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The last day of the pay period a date falls in — the next occurrence of the
 * shop's chosen day, that day itself included. Books close that evening, so
 * anything earned on it belongs to it.
 */
export function periodEndFor(when: Date, endDay: string): string {
  const target = DAYS.indexOf((endDay || 'tuesday').toLowerCase());
  const d = new Date(when.getTime());
  d.setHours(12, 0, 0, 0);
  const ahead = (target - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + ahead);
  return isoDay(d);
}

export function isoDay(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export async function payPeriodEnd(companyId: number): Promise<string> {
  const row = await tqOne<RowDataPacket & { setting_value: string }>(companyId,
    "SELECT setting_value FROM shop_settings WHERE setting_key = 'pay_period_end'").catch(() => null);
  return (row?.setting_value ?? 'tuesday').toLowerCase();
}

async function taxRate(companyId: number): Promise<number> {
  const row = await tqOne<RowDataPacket & { setting_value: string }>(companyId,
    "SELECT setting_value FROM shop_settings WHERE setting_key = 'sales_tax_rate'").catch(() => null);
  return Number(row?.setting_value ?? 0);
}

export async function loadPlan(companyId: number, userId: number): Promise<Plan | null> {
  const row = await tqOne<RowDataPacket & Plan>(companyId,
    `SELECT user_id, mode, rate_pct, pay_when, drop_on, drop_fee_cents, drop_recover,
            tl_amount_cents, tl_pay_drop, active
     FROM pay_plans WHERE user_id = ?`, [userId]).catch(() => null);
  if (!row) return null;

  const deds = await tq<Array<RowDataPacket & { deduct_key: string }>>(companyId,
    'SELECT deduct_key FROM pay_plan_deductions WHERE user_id = ?', [userId]).catch(() => []);

  return {
    ...row,
    rate_pct: Number(row.rate_pct),
    drop_on: !!row.drop_on,
    drop_recover: !!row.drop_recover,
    tl_pay_drop: !!row.tl_pay_drop,
    active: !!row.active,
    deductions: deds.map(d => d.deduct_key)
  };
}

export interface FileRow extends RowDataPacket {
  id: number;
  ro_number: string;
  amount_cents: number;
  parts_cost_cents: number;
  sublet_cost_cents: number;
  rental_cost_cents: number;
  towing_cost_cents: number;
  materials_cost_cents: number;
  discount_cents: number;
  shortpay_cents: number;
  total_loss_at: Date | null;
  voided_at: Date | null;
  sales_user_id: number | null;
}

async function fileFor(companyId: number, roId: number): Promise<FileRow | null> {
  return tqOne<FileRow>(companyId, `
    SELECT r.id, r.ro_number, r.amount_cents, r.parts_cost_cents, r.sublet_cost_cents,
           r.rental_cost_cents, r.towing_cost_cents, r.materials_cost_cents,
           r.discount_cents, r.shortpay_cents, r.total_loss_at, r.voided_at,
           a.user_id AS sales_user_id
    FROM repair_orders r
    LEFT JOIN ro_assignments a ON a.ro_id = r.id AND a.position_key = 'sales'
    WHERE r.id = ?`, [roId]);
}

export interface Deduction { key: string; label: string; cents: number }

/** What comes out, line by line, so the screen can show the arithmetic. */
export function deductionsOf(file: FileRow, plan: Plan, rate: number): Deduction[] {
  if (plan.mode === 'flat') return [];
  const out: Deduction[] = [];
  for (const d of DEDUCTIONS) {
    if (!plan.deductions.includes(d.key)) continue;
    const cents = d.key === 'tax'
      ? Math.round(file.amount_cents * (rate / 100))
      : Number((file as unknown as Record<string, number>)[d.column!] ?? 0);
    if (cents > 0) out.push({ key: d.key, label: d.label, cents });
  }
  return out;
}

interface TargetLine {
  kind: 'drop' | 'commission' | 'total_loss' | 'recovery';
  amount_cents: number;
  basis_cents: number;
  rate_pct: number;
  trigger_key: TriggerKey | null;
  earned_at: Date;
  note: string | null;
}

/**
 * What the ledger SHOULD say about this file, given the stamps that have fired
 * and the plan as it stands. Nothing is written here.
 */
export async function targetLines(companyId: number, roId: number): Promise<{
  userId: number | null; plan: Plan | null; file: FileRow | null;
  lines: TargetLine[]; deductions: Deduction[]; base: number;
}> {
  const file = await fileFor(companyId, roId);
  const none = { userId: null, plan: null, file, lines: [], deductions: [], base: 0 };
  if (!file || !file.sales_user_id) return none;

  const plan = await loadPlan(companyId, file.sales_user_id);
  if (!plan || !plan.active) return { ...none, userId: file.sales_user_id };

  /* A voided file earns nothing. Anything already paid on it comes back as an
     adjustment through the normal reconcile. */
  if (file.voided_at) {
    return { userId: file.sales_user_id, plan, file, lines: [], deductions: [], base: 0 };
  }

  const stamps = await tq<Array<RowDataPacket & { trigger_key: TriggerKey; fired_at: Date }>>(
    companyId, 'SELECT trigger_key, fired_at FROM ro_triggers WHERE ro_id = ?', [roId]);
  const at = new Map<TriggerKey, Date>(stamps.map(s => [s.trigger_key, new Date(s.fired_at)]));

  const rate = await taxRate(companyId);
  const deductions = deductionsOf(file, plan, rate);
  const outSum = deductions.reduce((a, d) => a + d.cents, 0);
  const base = plan.mode === 'flat' ? file.amount_cents : file.amount_cents - outSum;

  const lines: TargetLine[] = [];

  /* The drop fee is money out at arrival, ahead of any commission. */
  if (plan.drop_on && plan.drop_fee_cents > 0 && at.has('arrived')) {
    lines.push({
      kind: 'drop', amount_cents: plan.drop_fee_cents, basis_cents: 0, rate_pct: 0,
      trigger_key: 'arrived', earned_at: at.get('arrived')!, note: 'Drop fee, paid at arrival'
    });
  }

  const dropPaidOut = lines.some(l => l.kind === 'drop');

  if (file.total_loss_at) {
    /* A totalled car pays the total-loss amount and no commission at all. */
    if (plan.tl_amount_cents > 0) {
      lines.push({
        kind: 'total_loss', amount_cents: plan.tl_amount_cents, basis_cents: 0, rate_pct: 0,
        trigger_key: null, earned_at: new Date(file.total_loss_at),
        note: 'Total loss — no commission'
      });
    }
    if (dropPaidOut && !plan.tl_pay_drop) {
      lines.push({
        kind: 'recovery', amount_cents: -plan.drop_fee_cents, basis_cents: 0, rate_pct: 0,
        trigger_key: null, earned_at: new Date(file.total_loss_at),
        note: 'Drop fee recovered against the total loss'
      });
    }
  } else if (at.has(plan.pay_when)) {
    const commission = Math.round(base * (plan.rate_pct / 100));
    lines.push({
      kind: 'commission', amount_cents: commission, basis_cents: base, rate_pct: plan.rate_pct,
      trigger_key: plan.pay_when, earned_at: at.get(plan.pay_when)!,
      note: plan.mode === 'flat' ? 'Flat off approval' : 'Net of costs'
    });
    if (dropPaidOut && plan.drop_recover) {
      lines.push({
        kind: 'recovery', amount_cents: -plan.drop_fee_cents, basis_cents: 0, rate_pct: 0,
        trigger_key: plan.pay_when, earned_at: at.get(plan.pay_when)!,
        note: 'Drop fee recovered from the commission'
      });
    }
  }

  return { userId: file.sales_user_id, plan, file, lines, deductions, base };
}

interface LedgerRow extends RowDataPacket {
  id: number; kind: string; amount_cents: number; paid_at: Date | null;
  supersedes_id: number | null; earned_at: Date; user_id: number;
}

/**
 * Bring the ledger into line with what the plan and the stamps now say.
 *
 * Unpaid lines are corrected in place. A paid line is left exactly as it was and
 * the difference is written as an adjustment against the period the change falls
 * in — never a silent restatement of money already handed over.
 */
export async function reconcile(companyId: number, roId: number, why: string): Promise<void> {
  const endDay = await payPeriodEnd(companyId);
  const { userId, lines } = await targetLines(companyId, roId);
  if (!userId) return;

  await withTenantTx(companyId, async (c: PoolConnection) => {
    const [existing] = await c.query<LedgerRow[]>(
      `SELECT id, kind, amount_cents, paid_at, supersedes_id, earned_at, user_id
       FROM commission_lines WHERE ro_id = ? AND kind <> 'adjustment' ORDER BY id`, [roId]);

    const seen = new Set<number>();

    for (const want of lines) {
      const have = existing.find(e => e.kind === want.kind && !seen.has(e.id));
      const period = periodEndFor(want.earned_at, endDay);

      if (!have) {
        await c.query<ResultSetHeader>(
          `INSERT INTO commission_lines
             (ro_id, user_id, kind, amount_cents, basis_cents, rate_pct, trigger_key,
              earned_at, period_end, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [roId, userId, want.kind, want.amount_cents, want.basis_cents, want.rate_pct,
           want.trigger_key, want.earned_at, period, want.note]);
        continue;
      }

      seen.add(have.id);
      const diff = want.amount_cents - Number(have.amount_cents);

      if (have.paid_at) {
        /* Paid. The line stands; the difference travels forward. */
        if (diff !== 0) {
          await c.query(
            `INSERT INTO commission_lines
               (ro_id, user_id, kind, amount_cents, earned_at, period_end, supersedes_id, note)
             VALUES (?, ?, 'adjustment', ?, NOW(), ?, ?, ?)`,
            [roId, userId, diff, periodEndFor(new Date(), endDay), have.id, why]);
        }
        continue;
      }

      if (diff !== 0 || isoDay(have.earned_at) !== isoDay(want.earned_at)) {
        await c.query(
          `UPDATE commission_lines
             SET amount_cents = ?, basis_cents = ?, rate_pct = ?, trigger_key = ?,
                 earned_at = ?, period_end = ?, note = ?
           WHERE id = ?`,
          [want.amount_cents, want.basis_cents, want.rate_pct, want.trigger_key,
           want.earned_at, period, want.note, have.id]);
      }
    }

    /* Lines the plan no longer calls for: drop an unpaid one, reverse a paid one. */
    for (const e of existing) {
      if (seen.has(e.id)) continue;
      if (e.paid_at) {
        await c.query(
          `INSERT INTO commission_lines
             (ro_id, user_id, kind, amount_cents, earned_at, period_end, supersedes_id, note)
           VALUES (?, ?, 'adjustment', ?, NOW(), ?, ?, ?)`,
          [roId, e.user_id, -Number(e.amount_cents), periodEndFor(new Date(), endDay), e.id, why]);
      } else {
        await c.query('DELETE FROM commission_lines WHERE id = ?', [e.id]);
      }
    }
  });
}

/**
 * Stamp an event on a file and settle the ledger behind it. Called on the event
 * itself — the car arriving, the file leaving Awaiting Approval, the delivery,
 * the close — not when a report is run.
 *
 * The same stamps carry the SMS work later, which is why firing is its own
 * function and not something the pay code owns privately.
 */
export async function fireTrigger(
  companyId: number,
  roId: number,
  key: TriggerKey,
  opts: { at?: Date; userId?: number | null; userName?: string | null; source?: 'auto' | 'manual'; note?: string } = {}
): Promise<void> {
  const when = opts.at ?? new Date();
  await texec(companyId, `
    INSERT INTO ro_triggers (ro_id, trigger_key, fired_at, fired_by, fired_by_name, source, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE fired_at = fired_at`,
    [roId, key, when, opts.userId ?? null, opts.userName ?? null, opts.source ?? 'auto', opts.note ?? null]
  ).catch(() => undefined);

  await reconcile(companyId, roId, `${key} fired`).catch(() => undefined);
}

/** Correct a stamp somebody fired by mistake, and settle what it moved. */
export async function correctTrigger(
  companyId: number,
  roId: number,
  key: TriggerKey,
  at: Date | null,
  actor: { userId: number; userName: string }
): Promise<void> {
  if (at === null) {
    await texec(companyId, 'DELETE FROM ro_triggers WHERE ro_id = ? AND trigger_key = ?', [roId, key]);
  } else {
    await texec(companyId, `
      INSERT INTO ro_triggers (ro_id, trigger_key, fired_at, fired_by, fired_by_name, source, corrected_at)
      VALUES (?, ?, ?, ?, ?, 'manual', NOW())
      ON DUPLICATE KEY UPDATE fired_at = VALUES(fired_at), fired_by = VALUES(fired_by),
        fired_by_name = VALUES(fired_by_name), source = 'manual', corrected_at = NOW()`,
      [roId, key, at, actor.userId, actor.userName]);
  }
  await reconcile(companyId, roId, `${key} corrected by ${actor.userName}`);
}

/** Every file whose ledger should be rebuilt after a plan changed. */
export async function reconcilePerson(companyId: number, userId: number, why: string): Promise<number> {
  const rows = await tq<Array<RowDataPacket & { ro_id: number }>>(companyId, `
    SELECT DISTINCT r.id AS ro_id
    FROM repair_orders r
    JOIN ro_assignments a ON a.ro_id = r.id AND a.position_key = 'sales' AND a.user_id = ?
    WHERE r.opened_at > DATE_SUB(NOW(), INTERVAL 18 MONTH)`, [userId]);

  for (const r of rows) await reconcile(companyId, r.ro_id, why).catch(() => undefined);
  return rows.length;
}
