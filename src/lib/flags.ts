import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { buildPeriod, payrollSettings, periodEndOnOrAfter } from './payroll';

/**
 * The flag ledger: what payroll actually pays off.
 *
 * `ro_labour` holds the figure a trade stands at now. `ro_flag_entries` holds
 * every change to it, dated to the day it was flagged, and payroll adds up the
 * entries that fall in its week. That is what lets a trade be paid in parts —
 * a partial flag pays what was entered, and flagging the rest later pays only
 * the difference, on the week it was flagged — and what stops a re-save from
 * dragging an old flag into this week.
 *
 * Neither Vehicle Ready nor the close has any say in which week a flag pays.
 * The flag date does. A car can be flagged while it is still in the shop, at
 * close, or after it closed, and it pays on the week of the date given.
 *
 * `flag_at` is what the person said. `counts_at` is the moment payroll windows
 * on: the same, unless that week was already paid when an automatic flag (a
 * close) landed in it, in which case it rolls to the first open week. A date
 * somebody typed into a paid week is refused rather than moved.
 */

export function sqlStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function todayIso(): string {
  return sqlStamp(new Date()).slice(0, 10);
}

/** The week a moment pays on — after the cutoff on the close day is next week. */
export function periodEndForMoment(at: string, closeDay: string, cutoff: string): string {
  let end = periodEndOnOrAfter(new Date(at.slice(0, 10) + 'T12:00:00'), closeDay);
  const p = buildPeriod(end, closeDay, cutoff);
  if (at > p.cutoffAt) end = p.nextEnd;
  return end;
}

export async function paidPeriodEnds(companyId: number): Promise<string[]> {
  const rows = await tq<Array<RowDataPacket & { e: string }>>(companyId, `
    SELECT DATE_FORMAT(period_end, '%Y-%m-%d') AS e FROM payroll_runs
     WHERE paid_at IS NOT NULL ORDER BY period_end DESC LIMIT 200`).catch(() => []);
  return rows.map(r => r.e);
}

export class PaidWeekError extends Error {
  constructor(public periodEnd: string) {
    super(`The week ending ${periodEnd} is already paid. Pick a date in a week that is ` +
      'still open, or flag it today and it pays this week.');
  }
}

/**
 * Where a flag made at `at` lands. `explicit` means somebody chose the date:
 * a paid week is then an error. Otherwise it rolls forward to the next open one.
 */
export async function landing(companyId: number, at: string, explicit: boolean): Promise<{
  countsAt: string; periodEnd: string; rolled: boolean;
}> {
  const { closeDay, cutoff } = await payrollSettings(companyId);
  const paid = new Set(await paidPeriodEnds(companyId));
  let countsAt = at;
  let end = periodEndForMoment(at, closeDay, cutoff);
  if (paid.has(end) && explicit) throw new PaidWeekError(end);
  let rolled = false;
  for (let i = 0; paid.has(end) && i < 520; i++) {
    const p = buildPeriod(end, closeDay, cutoff);
    const next = new Date(p.cutoffAt.replace(' ', 'T'));
    next.setSeconds(next.getSeconds() + 1);
    countsAt = sqlStamp(next);
    end = p.nextEnd;
    rolled = true;
  }
  return { countsAt, periodEnd: end, rolled };
}

export interface WantFlag {
  positionKey: string;
  userId: number | null;
  displayName: string | null;
  basis: string;
  hours: number;
  rateCents: number;
  costCents: number;
  flagged: boolean;
  partial: boolean;
  /** Changed in this save. Only a touched row is re-dated when its figure has not moved. */
  touched?: boolean;
}

/**
 * Bring the ledger into line with what each trade now stands at, writing only
 * the difference. Returns the trades whose figure moved (or whose date did).
 */
export async function syncFlagLedger(
  companyId: number,
  roId: number,
  want: WantFlag[],
  opts: { at: string; explicit: boolean; source: 'flag' | 'close'; actorId: number; actorName: string | null }
): Promise<{ changed: Set<string>; periodEnd: string | null }> {
  const have = await tq<Array<RowDataPacket & {
    position_key: string; user_id: number; cost: string; hours: string;
  }>>(companyId, `
    SELECT position_key, user_id, SUM(cost_cents) AS cost, SUM(hours) AS hours
      FROM ro_flag_entries WHERE ro_id = ? AND user_id IS NOT NULL
     GROUP BY position_key, user_id`, [roId]);

  type Delta = { trade: string; userId: number; name: string | null; basis: string;
    rate: number; cost: number; hours: number; partial: boolean };
  const deltas: Delta[] = [];
  const moves: Array<{ trade: string; userId: number }> = [];

  for (const w of want) {
    const targets = new Map<number, { cost: number; hours: number }>();
    if (w.flagged && w.userId) targets.set(w.userId, { cost: w.costCents, hours: w.hours });

    const users = new Set<number>([
      ...have.filter(h => h.position_key === w.positionKey).map(h => Number(h.user_id)),
      ...targets.keys()
    ]);

    for (const u of users) {
      const h = have.find(x => x.position_key === w.positionKey && Number(x.user_id) === u);
      const t = targets.get(u) ?? { cost: 0, hours: 0 };
      const dCost = Math.round(t.cost - Number(h?.cost ?? 0));
      const dHours = Math.round((t.hours - Number(h?.hours ?? 0)) * 100) / 100;
      if (dCost !== 0 || dHours !== 0) {
        deltas.push({
          trade: w.positionKey, userId: u, name: u === w.userId ? w.displayName : null,
          basis: w.basis, rate: w.rateCents, cost: dCost, hours: dHours,
          partial: u === w.userId && w.flagged && w.partial
        });
      } else if (opts.explicit && w.touched && targets.has(u) && Number(h?.cost ?? 0) !== 0) {
        moves.push({ trade: w.positionKey, userId: u });
      }
    }
  }

  const changed = new Set<string>();
  if (!deltas.length && !moves.length) return { changed, periodEnd: null };

  const land = await landing(companyId, opts.at, opts.explicit);
  const { closeDay, cutoff } = await payrollSettings(companyId);
  const paid = new Set(await paidPeriodEnds(companyId));

  /* Same figure, different date: re-date the latest entry, so long as the week
     it sits in has not been paid. Maintenance, not a new payment. Checked
     before anything is written, so a refusal leaves nothing half-done. */
  const redate: number[] = [];
  for (const m of moves) {
    const last = await tqOne<RowDataPacket & { id: number; flag_day: string; counts_at: string }>(companyId, `
      SELECT id, DATE_FORMAT(flag_at, '%Y-%m-%d') AS flag_day,
             DATE_FORMAT(counts_at, '%Y-%m-%d %H:%i:%s') AS counts_at
        FROM ro_flag_entries WHERE ro_id = ? AND position_key = ? AND user_id = ?
       ORDER BY id DESC LIMIT 1`, [roId, m.trade, m.userId]);
    if (!last || last.flag_day === opts.at.slice(0, 10)) continue;
    const from = periodEndForMoment(String(last.counts_at), closeDay, cutoff);
    if (paid.has(from)) throw new PaidWeekError(from);
    redate.push(last.id);
    changed.add(m.trade);
  }

  for (const id of redate) {
    await texec(companyId,
      'UPDATE ro_flag_entries SET flag_at = ?, counts_at = ? WHERE id = ?',
      [opts.at, land.countsAt, id]);
  }

  for (const d of deltas) {
    await texec(companyId, `
      INSERT INTO ro_flag_entries
        (ro_id, position_key, user_id, display_name, basis, hours, rate_cents, cost_cents,
         partial, flag_at, counts_at, source, entered_by, entered_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [roId, d.trade, d.userId, d.name, d.basis === 'ems' ? 'hours' : d.basis, d.hours, d.rate,
       d.cost, d.partial ? 1 : 0, opts.at, land.countsAt, opts.source, opts.actorId, opts.actorName]);
    changed.add(d.trade);
  }

  return { changed, periodEnd: land.periodEnd };
}
