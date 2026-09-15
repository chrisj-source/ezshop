import { Connection } from 'mysql2/promise';

/**
 * Running a migration statement that may already be partly applied.
 *
 * Both the provisioner and `npm run migrate` replay every tenant migration and
 * tolerate "already there" errors, which is what lets one base schema plus a
 * pile of migrations land on the same shape as a database that grew.
 *
 * The trap, found the hard way on 15 Sep 2026: **a multi-clause `ALTER TABLE`
 * is atomic.** Migration 002 adds four columns in one statement —
 * `thumb_key`, `width`, `height`, `is_image`. Three of those had been folded
 * back into `db/tenant.sql` over time, so on a brand-new database MySQL
 * rejected the whole ALTER with "Duplicate column name 'width'" and
 * `thumb_key` was never added. The tolerance swallowed it, provisioning carried
 * on, and migration 008 — which adds a column `AFTER thumb_key` — failed with
 * "Unknown column 'thumb_key' in 'documents'". A new shop could not be created.
 *
 * So tolerance has to work per CLAUSE, not per statement. When a multi-clause
 * ALTER fails on a duplicate, it is split into one ALTER per clause and each is
 * tried on its own: the duplicates are skipped and the genuinely missing ones
 * land. That is the difference between a base file that has drifted being
 * harmless and being a bug that surfaces months later.
 */

const ALREADY_THERE =
  /Duplicate column|Duplicate key name|Duplicate entry|already exists|check that column\/key exists|Duplicate foreign key/i;

export function isAlreadyThere(e: unknown): boolean {
  return ALREADY_THERE.test((e as Error).message ?? '');
}

/**
 * Split `ALTER TABLE x ADD COLUMN a ..., ADD COLUMN b ...` into one statement
 * per clause. Commas inside parentheses (`ENUM('a','b')`) and inside quoted
 * strings (`COMMENT 'one, two'`) are not separators, so this scans rather than
 * splitting on a regex.
 *
 * Returns null when the statement is not a multi-clause ALTER, so the caller
 * can tell "nothing to retry" from "retry these".
 */
export function splitAlterClauses(stmt: string): string[] | null {
  const m = /^(\s*ALTER\s+TABLE\s+[^\s]+(?:\s+[^\s]+)??\s)(.*)$/is.exec(stmt);
  if (!m) return null;

  const head = m[1];
  const rest = m[2];

  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];

    if (quote) {
      buf += c;
      if (c === '\\') { buf += rest[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; continue; }
    if (c === '(') { depth++; buf += c; continue; }
    if (c === ')') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());

  if (parts.length < 2) return null;
  return parts.map(p => head + p);
}

/**
 * Split a multi-row `INSERT ... VALUES (a,b),(c,d)` into one INSERT per row.
 *
 * The same atomicity trap as a multi-clause ALTER, for data: migration 011
 * seeds `role_caps` as one INSERT of ~90 rows, and `tenant.sql` seeds many of
 * the same rows. One duplicate rejects the whole statement, the tolerance
 * swallows it, and the rows that were NOT already present never land — a shop
 * quietly missing permission rows nobody will notice until somebody cannot see
 * a screen they should.
 *
 * Returns null when this is not a multi-row INSERT.
 */
export function splitInsertRows(stmt: string): string[] | null {
  const m = /^(\s*INSERT\s+(?:IGNORE\s+)?INTO[\s\S]*?VALUES\s*)([\s\S]*)$/i.exec(stmt);
  if (!m) return null;

  const head = m[1];
  const rest = m[2];

  /* Trailing clauses (ON DUPLICATE KEY UPDATE ...) must ride along on every
     row rather than being treated as part of the last tuple. */
  const tailAt = rest.search(/\)\s*ON\s+DUPLICATE\s+KEY/i);
  const tuplesPart = tailAt >= 0 ? rest.slice(0, tailAt + 1) : rest;
  const tail = tailAt >= 0 ? rest.slice(tailAt + 1) : '';

  const tuples: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < tuplesPart.length; i++) {
    const c = tuplesPart[i];
    if (quote) {
      buf += c;
      if (c === '\\') { buf += tuplesPart[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; continue; }
    if (c === '(') { depth++; buf += c; continue; }
    if (c === ')') {
      depth--;
      buf += c;
      if (depth === 0) { tuples.push(buf.trim()); buf = ''; }
      continue;
    }
    if (depth === 0) continue;   // commas and whitespace between tuples
    buf += c;
  }

  if (tuples.length < 2) return null;
  return tuples.map(t => head + t + tail);
}

export interface TolerantResult {
  /** The statement ran clean. */
  ok: boolean;
  /** Clauses that were skipped as already present. */
  skipped: string[];
  /** Clauses that were retried individually and did apply. */
  recovered: string[];
}

/**
 * Run one migration statement, tolerating what is already there — per clause.
 *
 * Throws only on a real error. A statement that was entirely already applied
 * comes back `ok: false` with what was skipped, which callers may log.
 */
export async function runTolerant(
  conn: Connection, stmt: string
): Promise<TolerantResult> {
  try {
    await conn.query(stmt);
    return { ok: true, skipped: [], recovered: [] };
  } catch (e) {
    if (!isAlreadyThere(e)) throw e;

    const clauses = splitAlterClauses(stmt) ?? splitInsertRows(stmt);
    if (!clauses) {
      /* A single-clause statement that is already there. Genuinely nothing to
         do — this is the case the old tolerance was written for. */
      return { ok: false, skipped: [oneLine(stmt)], recovered: [] };
    }

    const skipped: string[] = [];
    const recovered: string[] = [];
    for (const clause of clauses) {
      try {
        await conn.query(clause);
        recovered.push(oneLine(clause));
      } catch (inner) {
        if (!isAlreadyThere(inner)) throw inner;
        skipped.push(oneLine(clause));
      }
    }
    return { ok: false, skipped, recovered };
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 120);
}
