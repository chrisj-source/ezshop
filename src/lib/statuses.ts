import { RowDataPacket } from 'mysql2/promise';
import { randomBytes } from 'crypto';
import { texec, tq, tqOne } from '../db/tenant';

/**
 * Statuses a shop adds itself (QUEUE, "Adding statuses", 2 Oct 2026).
 *
 * - The slot_id is made here once and never changes, like a built-in one.
 *   Inside a lane it is `lane.<key>.x.<slug>`, so everything that reads the
 *   lane off a slot keeps working; elsewhere `x.<slug>`.
 * - Added at the end of its group. Order is set by dragging, for any status.
 * - Never deleted, only hidden: a file's history points at the slot forever.
 * - Each one gets its own customer text, written but OFF — the SMS terms
 *   publish 4-8 texts a vehicle and a new status must not quietly add one.
 * - Copied to another location only when asked at the time, and only where the
 *   person adding it is an admin there. The copy is that shop's afterwards.
 */

export const KINDS = ['milestone', 'queue', 'active', 'complete'] as const;
export type Kind = typeof KINDS[number];

export interface NewStatus {
  groupId: string;
  laneKey?: string | null;
  label: string;
  customerLabel?: string | null;
  kind: Kind;
  ownerRole: string;
  ageYellowHours?: number | null;
  ageRedHours?: number | null;
  followUpHours?: number | null;
  countsTowardCycle?: boolean;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'status';
}

function hoursOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 24 * 90) throw new Error('Clocks are whole hours, up to 90 days.');
  return n;
}

/** The lanes a group's statuses sit in. Empty means the group is not a lane group. */
export async function lanesOfGroup(companyId: number, groupId: string): Promise<string[]> {
  const rows = await tq<Array<RowDataPacket & { lane_key: string }>>(companyId,
    'SELECT DISTINCT lane_key FROM statuses WHERE group_id = ? AND lane_key IS NOT NULL', [groupId]);
  return rows.map(r => r.lane_key);
}

/** Checks the request against this shop. Throws a sentence a person can act on. */
async function check(companyId: number, s: NewStatus): Promise<{ laneKey: string | null }> {
  const label = String(s.label ?? '').trim();
  if (!label) throw new Error('Give the status a name.');
  if (label.length > 120) throw new Error('That name is too long.');
  if (!KINDS.includes(s.kind)) throw new Error('Pick a kind.');
  if (!String(s.ownerRole ?? '').trim()) throw new Error('Pick who owns it.');

  const g = await tqOne<RowDataPacket>(companyId, 'SELECT group_id FROM status_groups WHERE group_id = ?', [s.groupId]);
  if (!g) throw new Error('That group is not in this shop.');

  const dupe = await tqOne<RowDataPacket>(companyId,
    'SELECT slot_id FROM statuses WHERE group_id = ? AND LOWER(label) = LOWER(?)', [s.groupId, label]);
  if (dupe) throw new Error('There is already a status called that in this group.');

  const lanes = await lanesOfGroup(companyId, s.groupId);
  if (!lanes.length) return { laneKey: null };
  const lane = s.laneKey ?? (lanes.length === 1 ? lanes[0] : null);
  if (!lane) throw new Error('This group holds more than one lane. Pick which lane the status is in.');
  if (!lanes.includes(lane)) throw new Error('That lane is not in this group.');
  return { laneKey: lane };
}

async function freeSlot(companyId: number, base: string, prefer?: string): Promise<string> {
  const taken = async (id: string) =>
    !!(await tqOne<RowDataPacket>(companyId, 'SELECT 1 AS x FROM statuses WHERE slot_id = ?', [id]));
  if (prefer && prefer.startsWith(base.replace(/[^.]+$/, '')) && !(await taken(prefer))) return prefer;
  if (!(await taken(base))) return base;
  for (let i = 2; i < 100; i++) {
    const id = `${base}_${i}`.slice(0, 64);
    if (!(await taken(id))) return id;
  }
  throw new Error('Could not make an identifier for that status.');
}

/**
 * Add one status to one shop. `preferSlot` lets a copy at another location use
 * the same identifier when it is free there, which is what a combined report
 * will want to line up on later.
 */
export async function addStatus(companyId: number, s: NewStatus, actor: { id: number; name: string },
  preferSlot?: string): Promise<{ slotId: string; triggerKey: string }> {
  const { laneKey } = await check(companyId, s);
  const label = s.label.trim();
  const yellow = hoursOrNull(s.ageYellowHours), red = hoursOrNull(s.ageRedHours), fu = hoursOrNull(s.followUpHours);
  if (yellow && red && red < yellow) throw new Error('Red has to come after the warning.');

  const base = laneKey ? `lane.${laneKey}.x.${slug(label)}` : `x.${slug(label)}`;
  const slotId = await freeSlot(companyId, base.slice(0, 60), preferSlot);

  const next = await tqOne<RowDataPacket & { n: number }>(companyId,
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM statuses WHERE group_id = ?', [s.groupId]);

  /* Modules follow the lane, so a lane switched off takes the status with it. */
  const mod = laneKey ? await tqOne<RowDataPacket & { module_tag: string | null }>(companyId,
    'SELECT module_tag FROM lanes WHERE lane_key = ?', [laneKey]) : null;

  await texec(companyId, `
    INSERT INTO statuses (slot_id, group_id, lane_key, label, customer_label, kind, owner_role,
                          age_yellow_hours, age_red_hours, follow_up_hours, module_tags,
                          counts_toward_cycle, visible, sort_order, is_custom, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, NOW())`,
    [slotId, s.groupId, laneKey, label, (s.customerLabel ?? '').trim() || null, s.kind, s.ownerRole.trim(),
     yellow, red, fu, mod?.module_tag ?? null, s.countsTowardCycle === false ? 0 : 1, Number(next?.n ?? 1), actor.id]);

  /* Its text: the shop's wording from here on, off until they switch it on. */
  let triggerKey = '';
  for (let i = 0; i < 5 && !triggerKey; i++) {
    const k = 'x_' + randomBytes(5).toString('hex');
    const hit = await tqOne<RowDataPacket>(companyId, 'SELECT 1 AS x FROM sms_templates WHERE trigger_key = ?', [k]);
    if (!hit) triggerKey = k;
  }
  const shown = (s.customerLabel ?? '').trim() || label;
  await texec(companyId, `
    INSERT IGNORE INTO sms_templates (trigger_key, label, note, body, enabled, sort_order, slot_id, updated_by)
    VALUES (?, ?, 'Added status', ?, 0, ?, ?, ?)`,
    [triggerKey, label.slice(0, 80),
     `Hi [ first name ], an update on your [ vehicle ]: ${shown}. Questions: [ shop phone ].`.slice(0, 480),
     1000 + Number(next?.n ?? 1), slotId, actor.id]);

  await texec(companyId,
    `INSERT INTO audit_log (user_id, user_name, entity, action, detail) VALUES (?, ?, 'status', 'added', ?)`,
    [actor.id, actor.name, JSON.stringify({ slot: slotId, group: s.groupId, lane: laneKey, label, kind: s.kind })]);

  return { slotId, triggerKey };
}

/** Set the order of one group. Any status may move; slots not named keep their place after. */
export async function reorderGroup(companyId: number, groupId: string, slots: string[]): Promise<void> {
  const rows = await tq<Array<RowDataPacket & { slot_id: string }>>(companyId,
    'SELECT slot_id FROM statuses WHERE group_id = ? ORDER BY sort_order', [groupId]);
  const have = new Set(rows.map(r => r.slot_id));
  const order = slots.filter(s => have.has(s));
  for (const r of rows) if (!order.includes(r.slot_id)) order.push(r.slot_id);
  for (let i = 0; i < order.length; i++) {
    await texec(companyId, 'UPDATE statuses SET sort_order = ? WHERE slot_id = ?', [i + 1, order[i]]);
  }
}
