import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne } from '../db/tenant';
import { LABOUR_TRADES, Trade, TRADE_LABEL, emsHoursFor, assignmentsFor } from './profit';

/**
 * What a technician is owed on one file.
 *
 * The shop pays differently by job type, so a pay plan is per job type rather
 * than per person. A body tech can be 12.5% of a wholesale car that has paint
 * on it, 25% if it is body only, and flag hours on anything with an estimate
 * behind it.
 *
 * Two rules worth stating once, because everything here follows from them:
 *
 *  - **A percentage runs off the approved amount after any parts we bought come
 *    out at cost.** A $450 wholesale car with no parts pays 12.5% of $450. A
 *    $6,482.19 file carrying $1,900 of parts at cost runs off $4,582.19. Sublet
 *    is *not* deducted — the rule as given names parts.
 *  - **One tech per trade per file**, so nothing is ever split. A file has at
 *    most five paid rows: body, PDR, paint, detail, R&I.
 */

export const JOB_TYPES = ['wholesale', 'insurance', 'cash'] as const;
export type JobType = typeof JOB_TYPES[number];

export const JOB_LABEL: Record<JobType, string> = {
  wholesale: 'Wholesale',
  insurance: 'Retail and insurance',
  cash: 'Cash quote'
};

export type PlanBasis = 'pct' | 'hours' | 'flat';

export interface PayPlan {
  jobType: JobType;
  basis: PlanBasis;
  pctPaint: number;
  pctNoPaint: number;
  rateCents: number;
}

export function emptyPlan(jobType: JobType): PayPlan {
  return { jobType, basis: 'hours', pctPaint: 0, pctNoPaint: 0, rateCents: 0 };
}

/**
 * Which of the three a file is. Derived, never stored: a wholesale account
 * makes it wholesale, a carrier or a claim behind it makes it insurance, and
 * anything else is a customer paying out of their own pocket.
 */
export async function jobTypeFor(companyId: number, roId: number): Promise<JobType> {
  const row = await tqOne<RowDataPacket>(companyId, `
    SELECT r.ro_type, r.insurer_client_id, r.claim_number,
           (SELECT k.kind FROM clients k WHERE k.id = r.client_id) AS client_kind
      FROM repair_orders r WHERE r.id = ?`, [roId]);
  if (!row) return 'cash';
  if (row.client_kind === 'wholesale' || row.ro_type === 'wholesale') return 'wholesale';
  if (row.insurer_client_id || String(row.claim_number ?? '').trim()) return 'insurance';
  return 'cash';
}

/** Every plan for these people, keyed person → job type. */
export async function plansFor(
  companyId: number, userIds: number[]
): Promise<Map<number, Record<JobType, PayPlan>>> {
  const out = new Map<number, Record<JobType, PayPlan>>();
  if (!userIds.length) return out;
  const rows = await tq<RowDataPacket[]>(companyId, `
    SELECT user_id, job_type, basis, pct_paint, pct_nopaint, rate_cents
      FROM staff_pay_plans
     WHERE user_id IN (${userIds.map(() => '?').join(',')})`, userIds);

  for (const id of userIds) {
    out.set(id, {
      wholesale: emptyPlan('wholesale'),
      insurance: emptyPlan('insurance'),
      cash: emptyPlan('cash')
    });
  }
  for (const r of rows) {
    const byType = out.get(Number(r.user_id));
    if (!byType) continue;
    byType[r.job_type as JobType] = {
      jobType: r.job_type as JobType,
      basis: r.basis as PlanBasis,
      pctPaint: Number(r.pct_paint),
      pctNoPaint: Number(r.pct_nopaint),
      rateCents: Number(r.rate_cents)
    };
  }
  return out;
}

export interface FileBasis {
  jobType: JobType;
  approvalCents: number;
  partsCostCents: number;
  /** Approval less parts at cost — what a percentage runs off. */
  pctBaseCents: number;
  hasPaint: boolean;
  paintReason: string;
}

/**
 * What the percentages run off on this file, and whether it counts as having
 * paint. Paint means paint labour on the estimate, or a painter flagged with
 * hours — not merely that a painter is assigned, because an assignment that
 * never worked should not halve a body tech's pay.
 */
export async function fileBasis(companyId: number, roId: number): Promise<FileBasis | null> {
  const f = await tqOne<RowDataPacket>(companyId,
    'SELECT amount_cents, parts_cost_cents FROM repair_orders WHERE id = ?', [roId]);
  if (!f) return null;

  const approvalCents = Number(f.amount_cents) || 0;
  const partsCostCents = Number(f.parts_cost_cents) || 0;

  const ems = await emsHoursFor(companyId, roId);
  const emsPaint = Number(ems.paint ?? 0);
  const flaggedPaint = await tqOne<RowDataPacket>(companyId, `
    SELECT hours FROM ro_labour
     WHERE ro_id = ? AND position_key = 'paint' AND flagged_at IS NOT NULL`, [roId]);
  const flaggedPaintHours = Number(flaggedPaint?.hours ?? 0);

  const hasPaint = emsPaint > 0 || flaggedPaintHours > 0;
  return {
    jobType: await jobTypeFor(companyId, roId),
    approvalCents,
    partsCostCents,
    pctBaseCents: Math.max(0, approvalCents - partsCostCents),
    hasPaint,
    paintReason: emsPaint > 0
      ? `${emsPaint} paint hours on the estimate`
      : flaggedPaintHours > 0
        ? `${flaggedPaintHours} paint hours flagged`
        : 'no paint labour on this file'
  };
}

/** What one plan pays on this file, on the basis the desk chose. */
export function priceFlag(
  basis: PlanBasis,
  value: number,
  file: Pick<FileBasis, 'pctBaseCents'>,
  rateCents: number
): number {
  if (basis === 'flat') return Math.max(0, Math.round(value));
  if (basis === 'pct') return Math.max(0, Math.round(file.pctBaseCents * (value / 100)));
  return Math.max(0, Math.round(value * rateCents));
}

export interface FlagRow {
  positionKey: Trade;
  label: string;
  userId: number | null;
  name: string | null;
  /** What the desk is entering: pct, hours, or a flat dollar figure. */
  basis: PlanBasis;
  /** The figure itself — a percentage, a count of hours, or cents. */
  pct: number;
  hours: number;
  flatCents: number;
  rateCents: number;
  amountCents: number;
  flagged: boolean;
  flaggedAt: string | null;
  flaggedBy: string | null;
  /** Null when the person has a plan for this job type; a sentence when not. */
  noPlan: string | null;
}

/**
 * One row per assigned trade, and only where somebody is assigned — a trade
 * nobody worked is not a row to tick past. What is already flagged wins over
 * what the plan suggests, because somebody decided it.
 */
export async function flagRowsFor(companyId: number, roId: number): Promise<{
  file: FileBasis; rows: FlagRow[];
}> {
  const file = await fileBasis(companyId, roId);
  if (!file) throw new Error('No such repair order');

  const assigned = (await assignmentsFor(companyId, roId))
    .filter(a => (LABOUR_TRADES as readonly string[]).includes(a.positionKey));

  const plans = await plansFor(companyId,
    assigned.map(a => a.userId).filter((n): n is number => n !== null));

  const saved = await tq<RowDataPacket[]>(companyId, `
    SELECT position_key, basis, hours, rate_cents, rate_pct, cost_cents,
           flagged_at, flagged_by_name
      FROM ro_labour WHERE ro_id = ?`, [roId]);
  const savedBy = new Map(saved.map(r => [String(r.position_key), r]));

  const ems = await emsHoursFor(companyId, roId);

  const rows = assigned.map(a => {
    const trade = a.positionKey as Trade;
    const plan = a.userId ? plans.get(a.userId)?.[file.jobType] : undefined;
    const have = savedBy.get(trade);

    const planned: PlanBasis = plan
      ? plan.basis
      : 'hours';
    const plannedPct = plan ? (file.hasPaint ? plan.pctPaint : plan.pctNoPaint) : 0;
    const rateCents = plan?.rateCents ?? 0;

    /* A plan that says "percent" with no percentage in it is not a plan. */
    const usable = !!plan && (
      plan.basis === 'pct' ? plannedPct > 0 : plan.rateCents > 0
    );

    let basis: PlanBasis = planned;
    let pct = plannedPct;
    let hours = Number(ems[trade] ?? 0);
    let flatCents = 0;

    if (have) {
      basis = have.basis === 'flat' ? 'flat' : have.basis === 'pct' ? 'pct' : 'hours';
      pct = Number(have.rate_pct) || plannedPct;
      hours = basis === 'flat' ? hours : Number(have.hours) || hours;
      flatCents = basis === 'flat' ? Number(have.cost_cents) || 0 : 0;
    }

    const value = basis === 'pct' ? pct : basis === 'flat' ? flatCents : hours;
    const amountCents = priceFlag(basis, value, file,
      have && Number(have.rate_cents) ? Number(have.rate_cents) : rateCents);

    return {
      positionKey: trade,
      label: TRADE_LABEL[trade],
      userId: a.userId,
      name: a.name,
      basis,
      pct,
      hours,
      flatCents,
      rateCents: have && Number(have.rate_cents) ? Number(have.rate_cents) : rateCents,
      amountCents,
      flagged: !!have?.flagged_at,
      flaggedAt: have?.flagged_at ? String(have.flagged_at) : null,
      flaggedBy: have?.flagged_by_name ?? null,
      noPlan: usable ? null
        : `No ${JOB_LABEL[file.jobType].toLowerCase()} plan for ${a.name ?? 'them'} — ` +
          'enter a figure here, or set a plan on their person sheet.'
    } as FlagRow;
  });

  return { file, rows };
}
