import { RowDataPacket } from 'mysql2/promise';
import { mq } from '../db/master';
import { texec, tq } from '../db/tenant';
import { notify } from '../notify';

/**
 * Tagging somebody in a note.
 *
 * Three moving parts, kept together because they only make sense as a set:
 * finding the names in a note, raising the mention, and clearing it when the
 * person answers.
 *
 * The rule the shop chose: **opening the file does not clear it — writing a
 * note does.** "I saw it" is not "I dealt with it", and a marker that clears on
 * a glance is one nobody trusts. The note is also the answer the next person
 * reads, so the evidence and the clear are the same act.
 */

export interface Taggable {
  id: number;
  name: string;
  /**
   * A no-space form that is unique at this shop: 'ChrisJ', 'RayW', 'RayG'.
   *
   * Needed because a space is the one thing a tag cannot contain reliably —
   * "@Ray Whitlock, can you" reads fine to a person and is ambiguous to a
   * parser the moment a comma or a second name follows. The handle is what the
   * picker inserts; the full name still works for anyone who types it.
   */
  handle: string;
}

/**
 * First name plus as much of the surname as it takes to be unique here.
 *
 * 'Chris Johnson' becomes ChrisJ. A second Chris J makes both grow a letter
 * rather than one of them becoming Chris2 — a handle should still look like
 * the person's name.
 */
function handlesFor(people: Array<{ id: number; name: string }>): Map<number, string> {
  const out = new Map<number, string>();
  const clean = (s: string): string => s.replace(/[^a-z0-9]/gi, '');

  const parts = people.map(p => {
    const bits = p.name.trim().split(/\s+/);
    return { id: p.id, first: clean(bits[0] ?? ''), last: clean(bits.slice(1).join('')) };
  });

  for (const p of parts) {
    let len = p.last ? 1 : 0;
    let tag = p.first + p.last.slice(0, len);
    /* Grow until nobody else at this shop would produce the same handle. */
    while (len < p.last.length &&
      parts.some(q => q.id !== p.id &&
        (q.first + q.last.slice(0, len)).toLowerCase() === tag.toLowerCase())) {
      len++;
      tag = p.first + p.last.slice(0, len);
    }
    out.set(p.id, tag);
  }
  return out;
}

/**
 * Everyone at this shop who could be tagged.
 *
 * Only people who can actually reach the file: tagging somebody into a screen
 * they cannot open is a dead end that looks like being ignored. That is why
 * this reads the membership rather than every user on the platform.
 */
export async function taggablePeople(companyId: number): Promise<Taggable[]> {
  const rows = await mq<Array<RowDataPacket & { id: number; name: string }>>(
    `SELECT u.id, u.name
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.company_id = ? AND m.status = 'active' AND u.status = 'active'
      ORDER BY CHAR_LENGTH(u.name) DESC`, [companyId]
  ).catch(() => []);

  const base = rows.map(r => ({ id: Number(r.id), name: String(r.name) }));
  const handles = handlesFor(base);
  return base.map(p => ({ ...p, handle: handles.get(p.id) ?? p.name.replace(/\s+/g, '') }));
}

/**
 * Find the people named in a note.
 *
 * Matching is done against the shop's actual people rather than by parsing a
 * pattern, because real names contain spaces: `@Ray Whitlock` is one person and
 * a regex for `@\w+` would find "Ray" and stop. The list is ordered longest
 * name first so `@Ray Whitlock` is not matched as `@Ray` when both exist.
 *
 * A first name on its own counts only when it is unambiguous at this shop. Two
 * people called Ray means `@Ray` matches neither — better to tag nobody and
 * have somebody notice than to tag the wrong Ray silently.
 */
export function findMentions(body: string, people: Taggable[]): Taggable[] {
  if (!body.includes('@')) return [];

  const hits = new Map<number, Taggable>();
  const lower = body.toLowerCase();

  /* Full names first, longest to shortest. */
  for (const p of people) {
    if (lower.includes('@' + p.name.toLowerCase())) hits.set(p.id, p);
  }

  /* Then handles — '@ChrisJ'. Bounded the same way a first name is, so
     '@ChrisJohnson' is not caught as '@ChrisJ' with stray letters after it. */
  for (const p of people) {
    if (hits.has(p.id) || !p.handle) continue;
    const re = new RegExp('(^|[^\\w@.])@' + escapeRe(p.handle) + '(?![\\w.])', 'i');
    if (re.test(body)) hits.set(p.id, p);
  }

  /* Then first names, but only the ones that identify exactly one person. */
  const byFirst = new Map<string, Taggable[]>();
  for (const p of people) {
    const first = p.name.split(/\s+/)[0].toLowerCase();
    byFirst.set(first, [...(byFirst.get(first) ?? []), p]);
  }
  for (const [first, group] of byFirst) {
    if (group.length !== 1) continue;
    if (hits.has(group[0].id)) continue;
    /* Bounded so `@Rays` does not match `@Ray`, and so an email address in the
       note body cannot tag anybody. */
    const re = new RegExp('(^|[^\\w@.])@' + escapeRe(first) + '(?![\\w.])', 'i');
    if (re.test(body)) hits.set(group[0].id, group[0]);
  }

  return [...hits.values()];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Raise mentions for a note that has just been written, and tell the people.
 *
 * Never tags the author: writing your own name in a note is not a request to
 * yourself, and a self-notification is noise that teaches people to ignore the
 * marker.
 */
export async function raiseMentions(opts: {
  companyId: number; roId: number; noteId: number; body: string;
  byUserId: number; byUserName: string; roNumber?: string | null;
  /**
   * The note is internal, so the tag is told in-app only.
   *
   * The tag is the thing granting this person the note; mirroring it to email
   * would put restricted text in an inbox, outside every check that made it
   * restricted in the first place.
   */
  internal?: boolean;
}): Promise<Taggable[]> {
  const people = await taggablePeople(opts.companyId);
  const tagged = findMentions(opts.body, people).filter(p => p.id !== opts.byUserId);
  if (!tagged.length) return [];

  for (const p of tagged) {
    await texec(opts.companyId,
      `INSERT INTO ro_mentions (ro_id, note_id, user_id, by_user_id, by_user_name)
       VALUES (?, ?, ?, ?, ?)`,
      [opts.roId, opts.noteId, p.id, opts.byUserId, opts.byUserName]);
  }

  /**
   * Straight to the people named, bypassing the notification groups.
   *
   * A mention is the one event where the routing grid should not get a say:
   * somebody typed your name. It still respects the suppression list and the
   * throttle, because those are about the destination rather than the event.
   */
  await notify({
    companyId: opts.companyId,
    event: 'mention',
    roId: opts.roId,
    title: `${opts.byUserName} tagged you${opts.roNumber ? ' on RO ' + opts.roNumber : ''}`,
    body: trim(opts.body, 400),
    actorUserId: opts.byUserId,
    directUserIds: tagged.map(p => p.id),
    appOnly: !!opts.internal,
    dedupeKey: `mention:${opts.noteId}`
  }).catch(() => undefined);

  return tagged;
}

/**
 * Clear this person's open mentions on this file, because they just wrote.
 *
 * Their mentions only. One person answering does not clear the mark for
 * somebody else who was also tagged — that was the point of a row per mention.
 */
export async function clearMentionsFor(
  companyId: number, roId: number, userId: number, noteId: number
): Promise<number> {
  const res = await texec(companyId,
    `UPDATE ro_mentions SET cleared_at = NOW(), cleared_note_id = ?
      WHERE ro_id = ? AND user_id = ? AND cleared_at IS NULL`,
    [noteId, roId, userId]);
  return res.affectedRows ?? 0;
}

/** Open mention counts per file, for the board. */
export async function openMentionCounts(
  companyId: number, roIds: number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!roIds.length) return out;
  const rows = await tq<Array<RowDataPacket & { ro_id: number; n: number }>>(companyId,
    `SELECT ro_id, COUNT(*) AS n FROM ro_mentions
      WHERE cleared_at IS NULL AND ro_id IN (?) GROUP BY ro_id`, [roIds]).catch(() => []);
  for (const r of rows) out.set(Number(r.ro_id), Number(r.n));
  return out;
}

/** The open mentions on one file, for the drawer. */
export async function openMentions(companyId: number, roId: number): Promise<RowDataPacket[]> {
  return tq<RowDataPacket[]>(companyId,
    `SELECT m.id, m.user_id, m.by_user_name, m.created_at,
            TIMESTAMPDIFF(HOUR, m.created_at, NOW()) AS age_hours
       FROM ro_mentions m
      WHERE m.ro_id = ? AND m.cleared_at IS NULL
      ORDER BY m.created_at`, [roId]).catch(() => []);
}

function trim(s: string, n: number): string {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
