/**
 * The holidays a repair shop might observe, and when they fall.
 *
 * Computed rather than stored, because the dates move: Thanksgiving is the
 * fourth Thursday in November, not a date. A table of dates would need
 * refilling every year and would be wrong the year somebody forgot.
 *
 * The list is the federal set plus the four a shop actually cares about that
 * are not federal — the day after Thanksgiving, both Eves, and New Year's Eve.
 * Christmas Eve is here because it is the classic half day, which is the case
 * the whole closures feature exists for.
 *
 * Nothing here is observed by default. A shop that works Thanksgiving should
 * not have to un-tick it.
 */

export interface Holiday {
  /** Stable across years, so "we observe this" survives into next year. */
  key: string;
  label: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** A hint for the settings screen, not a rule: shops override it. */
  typical: 'closed' | 'half';
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The nth given weekday of a month. `n = -1` means the last one. */
function nth(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return iso(year, month, day);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return iso(year, month, lastDay - ((last - weekday + 7) % 7));
}

function plusDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function holidaysFor(year: number): Holiday[] {
  const thanksgiving = nth(year, 11, 4, 4);   // 4th Thursday in November

  return [
    { key: 'new_years_day',   label: "New Year's Day",          date: iso(year, 1, 1),   typical: 'closed' },
    { key: 'mlk',             label: 'Martin Luther King Jr. Day', date: nth(year, 1, 1, 3), typical: 'closed' },
    { key: 'presidents',      label: "Presidents' Day",         date: nth(year, 2, 1, 3), typical: 'closed' },
    { key: 'good_friday',     label: 'Good Friday',             date: goodFriday(year),  typical: 'closed' },
    { key: 'memorial',        label: 'Memorial Day',            date: nth(year, 5, 1, -1), typical: 'closed' },
    { key: 'juneteenth',      label: 'Juneteenth',              date: iso(year, 6, 19),  typical: 'closed' },
    { key: 'independence',    label: 'Independence Day',        date: iso(year, 7, 4),   typical: 'closed' },
    { key: 'labor',           label: 'Labor Day',               date: nth(year, 9, 1, 1), typical: 'closed' },
    { key: 'veterans',        label: 'Veterans Day',            date: iso(year, 11, 11), typical: 'closed' },
    { key: 'thanksgiving',    label: 'Thanksgiving',            date: thanksgiving,      typical: 'closed' },
    { key: 'day_after_thanks', label: 'Day after Thanksgiving', date: plusDays(thanksgiving, 1), typical: 'closed' },
    { key: 'christmas_eve',   label: 'Christmas Eve',           date: iso(year, 12, 24), typical: 'half' },
    { key: 'christmas',       label: 'Christmas Day',           date: iso(year, 12, 25), typical: 'closed' },
    { key: 'new_years_eve',   label: "New Year's Eve",          date: iso(year, 12, 31), typical: 'half' }
  ];
}

/**
 * Good Friday — the Friday before Easter, by the anonymous Gregorian
 * computus. Included because plenty of shops in Texas take it, and it is the
 * one date here that cannot be expressed as "the nth weekday of a month".
 */
function goodFriday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return plusDays(iso(year, month, day), -2);
}
