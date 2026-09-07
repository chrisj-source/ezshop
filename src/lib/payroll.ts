/**
 * Payroll for everyone who is not on a sales plan.
 *
 * The week closes on a day and at a time the shop picks — Wednesday at four, so
 * cheques can be cut that evening. A file counts for the week if it was MARKED
 * closed before that moment. `closed_at` is the moment somebody clicked Close;
 * `close_date` is the books date and can be moved by hand, so it is the wrong
 * thing to pay off. Anything closed after the cutoff waits for the next week and
 * is paid once, there.
 *
 * Nothing here works out what a car should pay. That was settled at close and
 * lives in `ro_labour` — hours at the tech's rate, or a flat price agreed on that
 * file. The basis is per car, not per person: the same body tech can have a flat
 * price on one file and hours on the next. Payroll reads those rows and adds
 * them up.
 */

import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne } from '../db/tenant';

export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface Period {
  /** The close day of this period, as YYYY-MM-DD. */
  end: string;
  closeDay: string;
  cutoff: string;
  /** The exact moment the period closed, or closes. */
  cutoffAt: string;
  /** The moment the period before it closed — the other end of the window. */
  fromAt: string;
  prevEnd: string;
  nextEnd: string;
}

function iso(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}

function stamp(day: string, cutoff: string): string {
  return day + ' ' + (/^\d{1,2}:\d{2}$/.test(cutoff) ? cutoff : '16:00') + ':00';
}

/** The first close day on or after `from`. */
export function periodEndOnOrAfter(from: Date, closeDay: string): string {
  const want = Math.max(0, DAYS.indexOf(closeDay.toLowerCase()));
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== want) d.setDate(d.getDate() + 1);
  return iso(d);
}

export function buildPeriod(end: string, closeDay: string, cutoff: string): Period {
  const d = new Date(end + 'T00:00:00');
  const prev = new Date(d); prev.setDate(prev.getDate() - 7);
  const next = new Date(d); next.setDate(next.getDate() + 7);
  return {
    end,
    closeDay: closeDay.toLowerCase(),
    cutoff,
    cutoffAt: stamp(end, cutoff),
    fromAt: stamp(iso(prev), cutoff),
    prevEnd: iso(prev),
    nextEnd: iso(next)
  };
}

export async function payrollSettings(companyId: number): Promise<{ closeDay: string; cutoff: string }> {
  const rows = await tq<Array<RowDataPacket & { setting_key: string; setting_value: string }>>(
    companyId,
    `SELECT setting_key, setting_value FROM shop_settings
      WHERE setting_key IN ('payroll_close_day', 'payroll_cutoff')`
  ).catch(() => []);
  const get = (k: string, fb: string) => rows.find(r => r.setting_key === k)?.setting_value ?? fb;
  return { closeDay: get('payroll_close_day', 'wednesday'), cutoff: get('payroll_cutoff', '16:00') };
}

/** The period a shop is working in right now — the close day coming up, or today. */
export async function currentPeriod(companyId: number): Promise<Period> {
  const { closeDay, cutoff } = await payrollSettings(companyId);
  return buildPeriod(periodEndOnOrAfter(new Date(), closeDay), closeDay, cutoff);
}

export interface CarRow {
  roId: number;
  roNumber: string;
  vehicle: string;
  client: string | null;
  closedAt: string;
  positionKey: string;
  basis: 'hours' | 'flat' | 'ems' | 'pct';
  hours: number;
  rateCents: number;
  costCents: number;
  totalLoss: boolean;
}

/**
 * Every costed line owed to a person for files closed inside a window. One row
 * per file per trade, so a tech who did both body and R&I on a car appears
 * twice — which is right: they were costed twice.
 */
export async function linesBetween(
  companyId: number,
  fromAt: string,
  toAt: string
): Promise<Map<number, CarRow[]>> {
  const rows = await tq<Array<RowDataPacket & {
    user_id: number; ro_id: number; ro_number: string; closed_at: string;
    position_key: string; basis: CarRow['basis']; hours: string; rate_cents: number;
    cost_cents: number; year: number | null; make: string | null; model: string | null;
    client: string | null; total_loss_at: Date | null;
  }>>(companyId, `
    SELECT l.user_id, l.ro_id, r.ro_number, r.closed_at, l.position_key, l.basis,
           l.hours, l.rate_cents, l.cost_cents,
           v.year, v.make, v.model, c.name AS client, r.total_loss_at
    FROM ro_labour l
    JOIN repair_orders r ON r.id = l.ro_id
    LEFT JOIN vehicles v ON v.id = r.vehicle_id
    LEFT JOIN clients c ON c.id = r.client_id
    WHERE l.user_id IS NOT NULL
      AND r.closed_at IS NOT NULL
      AND r.voided_at IS NULL
      AND r.closed_at > ? AND r.closed_at <= ?
    ORDER BY r.closed_at DESC, r.ro_number DESC`, [fromAt, toAt]);

  const out = new Map<number, CarRow[]>();
  for (const r of rows) {
    const car: CarRow = {
      roId: r.ro_id,
      roNumber: r.ro_number,
      vehicle: [r.year || '', r.make || '', r.model || ''].join(' ').trim() || '—',
      client: r.client,
      closedAt: String(r.closed_at),
      positionKey: r.position_key,
      basis: r.basis,
      hours: Number(r.hours) || 0,
      rateCents: Number(r.rate_cents) || 0,
      costCents: Number(r.cost_cents) || 0,
      totalLoss: !!r.total_loss_at
    };
    out.set(r.user_id, [...(out.get(r.user_id) ?? []), car]);
  }
  return out;
}

/** Hours only count on the cars actually paid by the hour. */
export function hoursOf(cars: CarRow[]): number {
  return Math.round(cars.reduce((n, c) => n + (c.basis === 'flat' || c.basis === 'pct' ? 0 : c.hours), 0) * 100) / 100;
}

export function earnedOf(cars: CarRow[]): number {
  return cars.reduce((n, c) => n + c.costCents, 0);
}

export interface Person {
  userId: number;
  name: string;
  positionKey: string | null;
  positionLabel: string | null;
  payMode: 'per_car' | 'salary';
  salaryCents: number;
  payBasis: string;
  rateCents: number;
}

/**
 * Who is on this screen: active staff who are not on a sales pay plan. Somebody
 * who is on a plan is paid there, and paying them twice is exactly the mistake
 * this keeps out.
 */
export async function crew(companyId: number): Promise<Person[]> {
  const rows = await tq<Array<RowDataPacket & {
    user_id: number; display_name: string; position_key: string | null;
    position_label: string | null; pay_mode: 'per_car' | 'salary'; salary_cents: number;
    pay_basis: string; rate_cents: number;
  }>>(companyId, `
    SELECT s.user_id, s.display_name, s.position_key, p.label AS position_label,
           s.pay_mode, s.salary_cents, s.pay_basis, s.rate_cents
    FROM staff s
    LEFT JOIN positions p ON p.position_key = s.position_key
    LEFT JOIN pay_plans pp ON pp.user_id = s.user_id AND pp.active = 1
    WHERE s.active = 1 AND s.user_id IS NOT NULL AND pp.user_id IS NULL
    ORDER BY p.sort_order, s.display_name`);

  return rows.map(r => ({
    userId: r.user_id,
    name: r.display_name,
    positionKey: r.position_key,
    positionLabel: r.position_label,
    payMode: r.pay_mode === 'salary' ? 'salary' : 'per_car',
    salaryCents: Number(r.salary_cents) || 0,
    payBasis: r.pay_basis,
    rateCents: Number(r.rate_cents) || 0
  }));
}

/** The run for a period, if one has been made. */
export async function runFor(companyId: number, end: string): Promise<RowDataPacket | null> {
  return tqOne<RowDataPacket>(companyId,
    'SELECT * FROM payroll_runs WHERE period_end = ?', [end]);
}
