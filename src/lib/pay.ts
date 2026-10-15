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
import { partsSaleCents, taxOn, taxRule } from './tax';
import { tq, tqOne, texec, withTenantTx } from '../db/tenant';
import { roSplits } from './splits';
import { approvalText } from './sms-staff';

export type TriggerKey = 'arrived' | 'approval' | 'car_gone' | 'file_closed';

export const TRIGGERS: Array<{ key: TriggerKey; label: string; fires: string }> = [
  { key: 'arrived',     label: 'Vehicle arrived', fires: 'the car is dropped off' },
  { key: 'approval',    label: 'Approval',        fires: 'the file moves out of intake, teardown and estimate into production' },
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
  { key: 'discount',  label: 'Promises, discount and deductible assistance', column: 'discount_cents', hint: 'anything given away' },
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

/** The file's tax under the shop's rule — rate and what it applies to (lib/tax.ts). */
async function fileTax(companyId: number, file: FileRow): Promise<number> {
  const rule = await taxRule(companyId);
  return taxOn(rule, {
    approval: Number(file.amount_cents) || 0,
    parts: await partsSaleCents(companyId, file.id, Number(file.parts_cost_cents) || 0),
    materials: Number(file.materials_cost_cents) || 0,
    sublet: Number(file.sublet_cost_cents) || 0
  });
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
  /** Promise changes made after the commission was paid. Owner and accounting
      settle those by hand (commission_reviews), so the formula never sees them. */
  reviewed_promise_cents: number;
  total_loss_at: Date | null;
  voided_at: Date | null;
  sales_user_id: number | null;
}

async function fileFor(companyId: number, roId: number): Promise<FileRow | null> {
  return tqOne<FileRow>(companyId, `
    SELECT r.id, r.ro_number, r.amount_cents, r.parts_cost_cents, r.sublet_cost_cents,
           r.rental_cost_cents, r.towing_cost_cents, r.materials_cost_cents,
           r.discount_cents, r.shortpay_cents, r.total_loss_at, r.voided_at,
           (SELECT COALESCE(SUM(cr.delta_cents), 0) FROM commission_reviews cr WHERE cr.ro_id = r.id)
             AS reviewed_promise_cents,
           a.user_id AS sales_user_id
    FROM repair_orders r
    LEFT JOIN ro_assignments a ON a.ro_id = r.id AND a.position_key = 'sales'
    WHERE r.id = ?`, [roId]);
}

export interface Deduction { key: string; label: string; cents: number }

/** What comes out, line by line, so the screen can show the arithmetic. */
export function deductionsOf(file: FileRow, plan: Plan, taxCents: number): Deduction[] {
  if (plan.mode === 'flat') return [];
  const out: Deduction[] = [];
  for (const d of DEDUCTIONS) {
    if (!plan.deductions.includes(d.key)) continue;
    let cents = d.key === 'tax'
      ? taxCents
      : Number((file as unknown as Record<string, number>)[d.column!] ?? 0);
    if (d.key === 'discount') cents -= Number(file.reviewed_promise_cents) || 0;
    if (cents > 0) out.push({ key: d.key, label: d.label, cents });
  }
  return out;
}

interface TargetLine {
  user_id: number;
  kind: 'drop' | 'commission' | 'total_loss' | 'recovery';
  amount_cents: number;
  basis_cents: number;
  rate_pct: number;
  trigger_key: TriggerKey | null;
  earned_at: Date;
  note: string | null;
}

export interface Share { seq: number; userId: number; pct: number; plan: Plan | null }

/**
 * What the ledger SHOULD say about this file, given the stamps that have fired
 * and the plans as they stand. Nothing is written here.
 *
 * A split sale pays each person on their own plan, on their share of the base.
 * The drop fee is salesperson 1's alone; a total-loss amount is split by the
 * same percentages. Somebody in the split with no active plan earns nothing
 * until one exists (owner and accounting were warned when the split was set).
 */
export async function targetLines(companyId: number, roId: number): Promise<{
  userId: number | null; plan: Plan | null; file: FileRow | null;
  lines: TargetLine[]; deductions: Deduction[]; base: number; shares: Share[];
}> {
  const file = await fileFor(companyId, roId);
  const none = { userId: null, plan: null, file, lines: [], deductions: [], base: 0, shares: [] as Share[] };
  if (!file || !file.sales_user_id) return none;

  const split = await roSplits(companyId, roId);
  const shares: Share[] = [];
  for (const s of split.length ? split : [{ seq: 1, userId: file.sales_user_id, pct: 100 }]) {
    shares.push({ ...s, plan: await loadPlan(companyId, s.userId) });
  }
  const first = shares[0].plan && shares[0].plan.active ? shares[0].plan : null;

  /* A voided file earns nothing. Anything already paid on it comes back as an
     adjustment through the normal reconcile. */
  if (file.voided_at) {
    return { userId: file.sales_user_id, plan: first, file, lines: [], deductions: [], base: 0, shares };
  }

  const stamps = await tq<Array<RowDataPacket & { trigger_key: TriggerKey; fired_at: Date }>>(
    companyId, 'SELECT trigger_key, fired_at FROM ro_triggers WHERE ro_id = ?', [roId]);
  const at = new Map<TriggerKey, Date>(stamps.map(s => [s.trigger_key, new Date(s.fired_at)]));
  const tax = await fileTax(companyId, file);

  const lines: TargetLine[] = [];
  let deductions: Deduction[] = [];
  let base = 0;
  const split3 = shares.length > 1;

  for (const sh of shares) {
    const plan = sh.plan;
    if (!plan || !plan.active) continue;
    const deds = deductionsOf(file, plan, tax);
    const full = plan.mode === 'flat' ? file.amount_cents : file.amount_cents - deds.reduce((x, d) => x + d.cents, 0);
    const mine = Math.round(full * sh.pct / 100);
    if (sh.seq === 1) { deductions = deds; base = full; }
    const tag = split3 ? ` · ${sh.pct}% of a split` : '';
    const u = sh.userId;

    /* The drop fee is money out at arrival, ahead of any commission. Salesperson 1 only. */
    const drop = sh.seq === 1 && plan.drop_on && plan.drop_fee_cents > 0 && at.has('arrived');
    if (drop) {
      lines.push({ user_id: u, kind: 'drop', amount_cents: plan.drop_fee_cents, basis_cents: 0, rate_pct: 0,
        trigger_key: 'arrived', earned_at: at.get('arrived')!, note: 'Drop fee, paid at arrival' });
    }

    if (file.total_loss_at) {
      /* A totalled car pays the total-loss amount and no commission at all. */
      if (plan.tl_amount_cents > 0) {
        lines.push({ user_id: u, kind: 'total_loss', amount_cents: Math.round(plan.tl_amount_cents * sh.pct / 100),
          basis_cents: 0, rate_pct: 0, trigger_key: null, earned_at: new Date(file.total_loss_at),
          note: 'Total loss — no commission' + tag });
      }
      if (drop && !plan.tl_pay_drop) {
        lines.push({ user_id: u, kind: 'recovery', amount_cents: -plan.drop_fee_cents, basis_cents: 0, rate_pct: 0,
          trigger_key: null, earned_at: new Date(file.total_loss_at), note: 'Drop fee recovered against the total loss' });
      }
    } else if (at.has(plan.pay_when)) {
      lines.push({ user_id: u, kind: 'commission', amount_cents: Math.round(mine * (plan.rate_pct / 100)),
        basis_cents: mine, rate_pct: plan.rate_pct, trigger_key: plan.pay_when, earned_at: at.get(plan.pay_when)!,
        note: (plan.mode === 'flat' ? 'Flat off approval' : 'Net of costs') + tag });
      if (drop && plan.drop_recover) {
        lines.push({ user_id: u, kind: 'recovery', amount_cents: -plan.drop_fee_cents, basis_cents: 0, rate_pct: 0,
          trigger_key: plan.pay_when, earned_at: at.get(plan.pay_when)!, note: 'Drop fee recovered from the commission' });
      }
    }
  }

  return { userId: file.sales_user_id, plan: first, file, lines, deductions, base, shares };
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

    /* What has already been settled against each line: the line plus the
       automatic adjustments written against it. A manual adjustment (owner or
       accounting deciding on a late promise) is a person's call and is never
       counted or undone here. Without this, every reconcile after the first
       adjustment wrote the same difference again. */
    const [adj] = await c.query<Array<RowDataPacket & { supersedes_id: number; s: number }>>(
      `SELECT supersedes_id, SUM(amount_cents) AS s FROM commission_lines
       WHERE ro_id = ? AND kind = 'adjustment' AND manual = 0 AND supersedes_id IS NOT NULL
       GROUP BY supersedes_id`, [roId]);
    const adjOf = new Map<number, number>(adj.map(a => [Number(a.supersedes_id), Number(a.s)]));

    const seen = new Set<number>();

    for (const want of lines) {
      const have = existing.find(e => e.kind === want.kind && Number(e.user_id) === want.user_id && !seen.has(e.id));
      const period = periodEndFor(want.earned_at, endDay);

      if (!have) {
        await c.query<ResultSetHeader>(
          `INSERT INTO commission_lines
             (ro_id, user_id, kind, amount_cents, basis_cents, rate_pct, trigger_key,
              earned_at, period_end, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [roId, want.user_id, want.kind, want.amount_cents, want.basis_cents, want.rate_pct,
           want.trigger_key, want.earned_at, period, want.note]);
        continue;
      }

      seen.add(have.id);
      const settled = Number(have.amount_cents) + (have.paid_at ? (adjOf.get(have.id) ?? 0) : 0);
      const diff = want.amount_cents - settled;

      if (have.paid_at) {
        /* Paid. The line stands; the difference travels forward. */
        if (diff !== 0) {
          await c.query(
            `INSERT INTO commission_lines
               (ro_id, user_id, kind, amount_cents, earned_at, period_end, supersedes_id, note)
             VALUES (?, ?, 'adjustment', ?, NOW(), ?, ?, ?)`,
            [roId, have.user_id, diff, periodEndFor(new Date(), endDay), have.id, why]);
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
        const out = Number(e.amount_cents) + (adjOf.get(e.id) ?? 0);
        if (out === 0) continue;
        await c.query(
          `INSERT INTO commission_lines
             (ro_id, user_id, kind, amount_cents, earned_at, period_end, supersedes_id, note)
           VALUES (?, ?, 'adjustment', ?, NOW(), ?, ?, ?)`,
          [roId, e.user_id, -out, periodEndFor(new Date(), endDay), e.id, why]);
      } else {
        await c.query('DELETE FROM commission_lines WHERE id = ?', [e.id]);
      }
    }
  });
}

/** The paid commission on a file, if any. Drop fees do not count: a promise
    after the drop fee but before the commission is paid is still automatic. */
export async function paidCommission(companyId: number, roId: number): Promise<
  { id: number; userId: number; ratePct: number } | null> {
  const r = await tqOne<RowDataPacket & { id: number; user_id: number; rate_pct: number }>(companyId,
    `SELECT id, user_id, rate_pct FROM commission_lines
     WHERE ro_id = ? AND kind = 'commission' AND paid_at IS NOT NULL ORDER BY id DESC LIMIT 1`, [roId]);
  return r ? { id: Number(r.id), userId: Number(r.user_id), ratePct: Number(r.rate_pct) } : null;
}

/**
 * Owner and accounting take a late promise off (or put a reduced one back on)
 * the salesperson's pay for this week. A manual adjustment: reconcile never
 * moves it.
 */
export async function decideReview(
  companyId: number, roId: number, reviewId: number,
  d: { decision: 'adjust' | 'none'; adjustCents?: number; note?: string | null },
  actor: { userId: number; userName: string }
): Promise<{ lineId: number | null; adjustCents: number }> {
  const rev = await tqOne<RowDataPacket & { user_id: number; paid_line_id: number; decided_at: Date | null }>(
    companyId, 'SELECT user_id, paid_line_id, decided_at FROM commission_reviews WHERE id = ? AND ro_id = ?',
    [reviewId, roId]);
  if (!rev) throw Object.assign(new Error('No such review'), { code: 404 });
  if (rev.decided_at) throw Object.assign(new Error('That one has already been decided.'), { code: 409 });

  const cents = d.decision === 'adjust' ? Math.round(Number(d.adjustCents) || 0) : 0;
  if (d.decision === 'adjust' && !cents) throw Object.assign(new Error('Enter the amount.'), { code: 400 });

  const endDay = await payPeriodEnd(companyId);
  /* On a split sale the one decision is divided by the split; salesperson 1
     takes the rounding. Each share is set against that person's own paid line. */
  const split = await roSplits(companyId, roId);
  const parts = split.length > 1 ? split : [{ seq: 1, userId: Number(rev.user_id), pct: 100 }];
  let lineId: number | null = null;
  await withTenantTx(companyId, async (c: PoolConnection) => {
    if (cents) {
      let left = cents;
      for (const s of [...parts].reverse()) {
        const amt = s.seq === 1 ? left : Math.round(cents * s.pct / 100);
        left -= amt;
        if (!amt) continue;
        const [own] = await c.query<RowDataPacket[]>(
          `SELECT id FROM commission_lines WHERE ro_id = ? AND user_id = ? AND kind = 'commission' AND paid_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
          [roId, s.userId]);
        const [ins] = await c.query<ResultSetHeader>(
          `INSERT INTO commission_lines
             (ro_id, user_id, kind, amount_cents, earned_at, period_end, supersedes_id, note, manual)
           VALUES (?, ?, 'adjustment', ?, NOW(), ?, ?, ?, 1)`,
          [roId, s.userId, amt, periodEndFor(new Date(), endDay), own[0]?.id ?? rev.paid_line_id,
           (`Promise after payout — ${actor.userName}` + (parts.length > 1 ? ` · ${s.pct}% share` : '') + (d.note ? `: ${d.note}` : '')).slice(0, 255)]);
        if (s.seq === 1) lineId = ins.insertId;
      }
    }
    await c.query(
      `UPDATE commission_reviews SET decision = ?, adjust_cents = ?, line_id = ?,
         decided_by = ?, decided_by_name = ?, decided_at = NOW(), note = ? WHERE id = ?`,
      [d.decision, cents || null, lineId, actor.userId, actor.userName, d.note ?? null, reviewId]);
  });
  return { lineId, adjustCents: cents };
}

/**
 * Before approval: intake, and scope / teardown / estimate up to Awaiting
 * Approval. Everything else — Approved and Estimate Review, Parts, every
 * production lane (added statuses included), wash, ready, delivered — is past
 * it. Read from the status's group, so a status a shop adds lands on the right
 * side without a code change.
 */
const PRE_APPROVAL_GROUPS = new Set(['intake', 'assess']);
const PAST_APPROVAL_SLOTS = new Set(['est.approved', 'est.review']);
export function isPreApproval(slot: string | null | undefined, groupId: string | null | undefined): boolean {
  if (!slot) return true;
  if (PAST_APPROVAL_SLOTS.has(slot)) return false;
  return PRE_APPROVAL_GROUPS.has(String(groupId ?? ''));
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
  const ins = await texec(companyId, `
    INSERT INTO ro_triggers (ro_id, trigger_key, fired_at, fired_by, fired_by_name, source, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE fired_at = fired_at`,
    [roId, key, when, opts.userId ?? null, opts.userName ?? null, opts.source ?? 'auto', opts.note ?? null]
  ).catch(() => undefined);

  /* The first approval of a file texts owner and accounting, when the shop
     texts at all. affectedRows is 1 only for a new stamp — a supplement loop or
     a re-fire never sends twice. Not awaited: Twilio must not hold up a move. */
  if (key === 'approval' && ins && Number((ins as { affectedRows?: number }).affectedRows) === 1) {
    void approvalText(companyId, roId).catch(() => undefined);
  }

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
