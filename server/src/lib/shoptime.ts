/**
 * The shop's day.
 *
 * Both connection pools run in UTC (`timezone: 'Z'`), which is right for storing
 * a moment. It is wrong for asking "what day is that", because a lead taken at
 * 8pm Central is already tomorrow in UTC — so `DATEDIFF(CURDATE(), DATE(...))`
 * reported a lead entered last night as arriving today.
 *
 * Everything that answers a question a person would answer with a calendar —
 * how old is this, how many days has it been quiet — has to be asked in the
 * shop's own timezone.
 *
 * The offset is passed to `CONVERT_TZ` as a numeric string rather than a zone
 * name on purpose: named zones need the MySQL timezone tables loaded, which they
 * usually are not on a plain box. Numeric offsets always work.
 */

/**
 * The shop's current UTC offset as `+HH:MM` / `-HH:MM`.
 *
 * Read at call time, so a shop on daylight saving gets the offset in force
 * today rather than one baked in at boot.
 */
export function tzOffset(timezone: string | null | undefined, at: Date = new Date()): string {
  const tz = timezone || 'America/Chicago';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'longOffset'
    }).formatToParts(at);
    const name = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
    // "GMT-05:00", and plain "GMT" at zero.
    const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (m) return `${m[1]}${m[2]}:${m[3]}`;
    if (/^GMT$/.test(name)) return '+00:00';
  } catch {
    /* An unknown zone name, or an old ICU without longOffset. Fall through. */
  }

  /* Fallback: compare the same instant formatted in the zone against UTC. */
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute)
    );
    const mins = Math.round((asUtc - at.getTime()) / 60000);
    const sign = mins < 0 ? '-' : '+';
    const abs = Math.abs(mins);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  } catch {
    return '+00:00';
  }
}

/** Today's date in the shop's timezone, as `YYYY-MM-DD`. */
export function shopToday(timezone: string | null | undefined, at: Date = new Date()): string {
  const tz = timezone || 'America/Chicago';
  try {
    const p: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(at)) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * A SQL fragment giving the calendar days between two moments as the shop counts
 * them. Both sides are shifted into the shop's day before the date is taken.
 *
 * Callers must push `offset` twice into their parameter list, in this order.
 */
export function daysBetweenSql(from: string, to: string): string {
  /* CONVERT_TZ returns NULL if the offset is ever rejected, and a NULL day count
     reads as "today" downstream — the exact bug this exists to fix. Fall back to
     the plain UTC count rather than silently going wrong. */
  return `COALESCE(` +
    `DATEDIFF(DATE(CONVERT_TZ(${to}, '+00:00', ?)), DATE(CONVERT_TZ(${from}, '+00:00', ?))), ` +
    `DATEDIFF(DATE(${to}), DATE(${from})))`;
}
