import { RowDataPacket } from 'mysql2/promise';
import { tq } from '../db/tenant';

/**
 * The shop's open hours, and how to measure time in them.
 *
 * Two different questions get asked of this, and they are not the same:
 *
 *   - *Is the shop open right now?* — the scheduler, refusing a booking at 9pm.
 *   - *How many WORKING hours have passed?* — the sales onboarding clock when a
 *     shop chooses shop hours over actual ones.
 *
 * The second is the awkward one, and it is why this is a library rather than a
 * SQL expression: elapsed working time between two instants means walking the
 * days between them and adding up the overlap with each day's window. There is
 * no honest way to do that in a TIMESTAMPDIFF.
 *
 * Everything here works in the SHOP's timezone, which is on the company record.
 * A shop in Plano and a droplet in New York are an hour apart for part of the
 * year, and "open at 8" means eight o'clock where the cars are.
 */

export interface DayHours {
  dow: number;          // 0 = Sunday … 6 = Saturday
  open: string;         // 'HH:MM:SS'
  close: string;
  closed: boolean;
}

export type Week = DayHours[];

/**
 * A specific date that does not follow the weekly pattern: a holiday, a half
 * day, or any date the shop marked. Keyed by 'YYYY-MM-DD' in the SHOP's
 * timezone.
 */
export interface Closure { closed: boolean; open?: string; close?: string; label: string }

/**
 * The week plus the exceptions. Everything below takes one of these rather than
 * a bare week, because "is the shop open" has no correct answer on Christmas Eve
 * without both halves.
 */
export interface Calendar { week: Week; closures: Map<string, Closure>; tz: string }

const DEFAULT_WEEK: Week = [0, 1, 2, 3, 4, 5, 6].map(dow => ({
  dow,
  open: '08:00:00',
  close: '17:00:00',
  closed: dow === 0 || dow === 6
}));

/**
 * The shop's week. Falls back to Monday–Friday 8–5 when the table is missing,
 * which keeps a shop whose migration has not run from having a clock that
 * measures zero and a lead that is therefore never late.
 */
export async function shopWeek(companyId: number): Promise<Week> {
  const rows = await tq<Array<RowDataPacket & {
    dow: number; open_time: string; close_time: string; closed: number;
  }>>(companyId, 'SELECT dow, open_time, close_time, closed FROM shop_hours')
    .catch(() => []);

  if (!rows.length) return DEFAULT_WEEK;

  const week = DEFAULT_WEEK.map(d => ({ ...d }));
  for (const r of rows) {
    const i = week.findIndex(d => d.dow === Number(r.dow));
    if (i < 0) continue;
    week[i] = {
      dow: Number(r.dow),
      open: String(r.open_time),
      close: String(r.close_time),
      closed: Number(r.closed) === 1
    };
  }
  return week;
}

/**
 * The whole calendar for a shop: the ordinary week and the dated exceptions.
 *
 * Closures are loaded from today onward plus a little history, because the
 * onboarding clock measures backwards over a span that may include one. A shop
 * with ten years of marked dates does not need all of them in memory to answer
 * a question about this week.
 */
export async function shopCalendar(
  companyId: number, tz: string, fromDays = 60, toDays = 400
): Promise<Calendar> {
  const week = await shopWeek(companyId);

  const rows = await tq<Array<RowDataPacket & {
    on_date: string; kind: string; open_time: string | null;
    close_time: string | null; label: string;
  }>>(companyId,
    `SELECT DATE_FORMAT(on_date, '%Y-%m-%d') AS on_date, kind, open_time, close_time, label
       FROM shop_closures
      WHERE on_date BETWEEN DATE_SUB(CURDATE(), INTERVAL ? DAY)
                        AND DATE_ADD(CURDATE(), INTERVAL ? DAY)`,
    [fromDays, toDays]).catch(() => []);

  const closures = new Map<string, Closure>();
  for (const r of rows) {
    closures.set(String(r.on_date), {
      closed: String(r.kind) === 'closed',
      open: r.open_time ? String(r.open_time) : undefined,
      close: r.close_time ? String(r.close_time) : undefined,
      label: String(r.label)
    });
  }
  return { week, closures, tz };
}

/**
 * What window applies on one local date: the weekday's hours, unless a closure
 * says otherwise.
 *
 * A 'hours' closure with no times is treated as closed rather than as
 * all-day-open, because that is the safer reading of a row somebody half
 * filled in.
 */
export function dayWindow(
  cal: Calendar, ymd: string, dow: number
): { closed: boolean; open: string; close: string; label?: string } {
  const base = cal.week.find(d => d.dow === dow)
    ?? { dow, open: '08:00:00', close: '17:00:00', closed: true };

  const ex = cal.closures.get(ymd);
  if (!ex) return { closed: base.closed, open: base.open, close: base.close };

  if (ex.closed) return { closed: true, open: base.open, close: base.close, label: ex.label };
  if (!ex.open || !ex.close) return { closed: true, open: base.open, close: base.close, label: ex.label };
  return { closed: false, open: ex.open, close: ex.close, label: ex.label };
}

/** 'HH:MM:SS' as minutes past midnight. */
function mins(t: string): number {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * The shop's wall-clock view of an instant: which weekday it is there, and how
 * many minutes past midnight.
 *
 * Uses Intl rather than date arithmetic because that is the only thing that
 * gets daylight saving right without a table of transitions.
 */
function inZone(at: Date, tz: string): { dow: number; minute: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;

  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  /* Intl gives 24 for midnight in some engines; 24:10 is not a time. */
  const hour = Number(parts.hour) % 24;

  return {
    dow: dows[parts.weekday] ?? 0,
    minute: hour * 60 + Number(parts.minute),
    ymd: `${parts.year}-${parts.month}-${parts.day}`
  };
}

export function isOpenAt(cal: Calendar, at: Date): boolean {
  const { dow, minute, ymd } = inZone(at, cal.tz);
  const d = dayWindow(cal, ymd, dow);
  if (d.closed) return false;
  return minute >= mins(d.open) && minute < mins(d.close);
}

/** Why the shop is shut then, in words a screen can show. Null if it is open. */
export function closedReason(cal: Calendar, at: Date): string | null {
  const { dow, minute, ymd } = inZone(at, cal.tz);
  const d = dayWindow(cal, ymd, dow);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (d.closed) return d.label ? `the shop is closed — ${d.label}` : `the shop is closed on ${DAYS[dow]}s`;
  if (minute < mins(d.open) || minute >= mins(d.close)) {
    const hhmm = (t: string) => t.slice(0, 5);
    return d.label
      ? `${d.label}: ${hhmm(d.open)} to ${hhmm(d.close)}`
      : `the shop is open ${hhmm(d.open)} to ${hhmm(d.close)} that day`;
  }
  return null;
}

/**
 * Working hours between two instants.
 *
 * Walks day by day in the shop's timezone and adds the overlap of each day's
 * open window with the span. Day-by-day rather than clever: a month is thirty
 * iterations, this is called per lead on a screen that already runs several
 * queries, and the clever version would be wrong across a daylight-saving
 * boundary.
 *
 * Returns fractional hours. Capped at a year of walking so a bad date on a row
 * cannot spin the loop.
 */
export function workingHoursBetween(cal: Calendar, from: Date, to: Date): number {
  const tz = cal.tz;
  if (!(from instanceof Date) || isNaN(from.getTime())) return 0;
  if (!(to instanceof Date) || isNaN(to.getTime())) return 0;
  if (to <= from) return 0;

  let minutes = 0;
  let guard = 0;

  /* Step through midday of each local day, which is never ambiguous even on the
     two days a year the clocks move. */
  const cursor = new Date(from.getTime());
  cursor.setUTCHours(12, 0, 0, 0);
  if (cursor.getTime() < from.getTime() - 86400000) cursor.setUTCDate(cursor.getUTCDate() + 1);

  while (cursor.getTime() - 86400000 <= to.getTime() && guard++ < 400) {
    const { dow, ymd } = inZone(cursor, tz);
    const day = dayWindow(cal, ymd, dow);

    if (!day.closed) {
      /* This day's open and close as real instants, built from the local date
         so the offset is whatever it is on that date. */
      const openAt = zoned(ymd, day.open, tz);
      const closeAt = zoned(ymd, day.close, tz);

      const start = Math.max(openAt.getTime(), from.getTime());
      const end = Math.min(closeAt.getTime(), to.getTime());
      if (end > start) minutes += (end - start) / 60000;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return minutes / 60;
}

/**
 * A local date and time in a named zone, as a real instant.
 *
 * Done by guessing UTC and correcting by the offset that guess lands on, which
 * is the standard two-step: the first guess is wrong by the offset, and reading
 * the offset AT that guess is right except in the one ambiguous hour when
 * clocks go back — where either answer is defensible.
 */
function zoned(ymd: string, hms: string, tz: string): Date {
  const guess = new Date(`${ymd}T${hms}Z`);
  const offset = offsetMinutes(guess, tz);
  return new Date(guess.getTime() - offset * 60000);
}

function offsetMinutes(at: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(at)) p[x.type] = x.value;
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return (asUtc - at.getTime()) / 60000;
}

/** The next moment the shop is open, at or after `at`. Null if it never is. */
export function nextOpen(cal: Calendar, at: Date): Date | null {
  if (cal.week.every(d => d.closed)) return null;
  if (isOpenAt(cal, at)) return at;

  const tz = cal.tz;
  const cursor = new Date(at.getTime());
  /* Three weeks rather than two: a shop closed for a Christmas fortnight is a
     real thing, and returning null there would read as "never open". */
  for (let i = 0; i < 21; i++) {
    const { dow, ymd, minute } = inZone(cursor, tz);
    const day = dayWindow(cal, ymd, dow);
    if (!day.closed && (i > 0 || minute < mins(day.open))) {
      return zoned(ymd, day.open, tz);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 30, 0, 0);
  }
  return null;
}
