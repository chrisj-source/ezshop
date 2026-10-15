import { RowDataPacket } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, tqOne, texec } from '../db/tenant';
import { capsAt } from '../middleware/context';
import { notify } from '../notify';
import { LANES, laneOf, PARKED } from './pipeline';

/**
 * Who owns a new lead, and the escalation ladder.
 *
 * Field sales → the rep who wrote it. Everything else → set per lane by the
 * owner: sales managers round robin, a notification group round robin, or one
 * person. Sales manager is a capability, any number of people.
 *
 * The ladder is per lane: step 1 the lead owner, step 2 a group (sales
 * managers by default), step 3 the owner of the shop. Wall clock since the last
 * touch. A touch is a logged call, an email, or a note — a text does not count
 * and nor does opening the lead.
 */

export interface LaneCfg {
  lane_key: string; route_mode: 'managers_rr' | 'group_rr' | 'person' | 'writer';
  route_group_id: number | null; route_user_id: number | null; rr_last_user_id: number | null;
  step1_hours: number; step2_hours: number; step2_group_id: number | null; step3_hours: number;
  chase_quote_days: number; statuses_off: string | null;
  step1_min?: number | null; step2_min?: number | null; step3_min?: number | null; rr_users?: string | null;
}

export async function laneCfgs(cid: number): Promise<Record<string, LaneCfg>> {
  const rows = await tq<Array<RowDataPacket & LaneCfg>>(cid, 'SELECT * FROM lead_lanes').catch(() => []);
  const out: Record<string, LaneCfg> = {};
  for (const l of LANES) {
    const r = rows.find(x => x.lane_key === l.key);
    /* Minutes win when set (tenant 046); the hour fields carry the same figure, fractional. */
    if (r && r.step1_min != null) { r.step1_hours = Number(r.step1_min) / 60; r.step2_hours = Number(r.step2_min) / 60; r.step3_hours = Number(r.step3_min) / 60; }
    out[l.key] = r ? { ...r } : {
      lane_key: l.key, route_mode: l.key === 'field' ? 'writer' : 'managers_rr', route_group_id: null, route_user_id: null,
      rr_last_user_id: null, step1_hours: l.overdueHours, step2_hours: l.overdueHours * 2, step2_group_id: null,
      step3_hours: l.overdueHours * 4, chase_quote_days: 3, statuses_off: null
    };
  }
  return out;
}

async function activeMembers(cid: number): Promise<number[]> {
  const m = await mq<Array<RowDataPacket & { user_id: number }>>(
    "SELECT user_id FROM memberships WHERE company_id = ? AND status = 'active'", [cid]).catch(() => []);
  return m.map(x => Number(x.user_id));
}

export async function usersWithCap(cid: number, cap: 'salesManager' | 'admin'): Promise<number[]> {
  const out: number[] = [];
  for (const u of await activeMembers(cid)) if ((await capsAt(u, cid))[cap]) out.push(u);
  return out.sort((a, b) => a - b);
}

/** A group's people. The Sales managers group follows the capability. */
export async function groupMembers(cid: number, groupId: number | null): Promise<number[]> {
  if (!groupId) return usersWithCap(cid, 'salesManager');
  const g = await tqOne<RowDataPacket>(cid, 'SELECT system_key FROM notify_groups WHERE id = ?', [groupId]);
  if (!g) return [];
  if (g.system_key === 'sales_managers') return usersWithCap(cid, 'salesManager');
  const active = new Set(await activeMembers(cid));
  const rows = await tq<Array<RowDataPacket & { user_id: number }>>(cid,
    'SELECT user_id FROM notify_group_members WHERE group_id = ? ORDER BY user_id', [groupId]);
  return rows.map(r => Number(r.user_id)).filter(u => active.has(u));
}

/** The next person in the round robin after the last one given a lead. */
function nextAfter(list: number[], last: number | null): number | null {
  if (!list.length) return null;
  const i = last ? list.indexOf(last) : -1;
  return list[(i + 1) % list.length];
}

/** Pick the owner for a lead in this lane. Does not write. */
export async function pickOwner(cid: number, laneKey: string, writerId: number | null): Promise<number | null> {
  const cfg = (await laneCfgs(cid))[laneKey];
  if (!cfg || cfg.route_mode === 'writer') return writerId;
  if (cfg.route_mode === 'person') return cfg.route_user_id ?? writerId;
  let list = cfg.route_mode === 'group_rr' ? await groupMembers(cid, cfg.route_group_id) : await usersWithCap(cid, 'salesManager');
  if (cfg.route_mode === 'managers_rr' && cfg.rr_users) {
    const pick = String(cfg.rr_users).split(',').map(Number);
    const narrowed = list.filter(u => pick.includes(u));
    if (narrowed.length) list = narrowed;
  }
  const who = nextAfter(list, cfg.rr_last_user_id ? Number(cfg.rr_last_user_id) : null);
  if (who) await texec(cid, 'UPDATE lead_lanes SET rr_last_user_id = ? WHERE lane_key = ?', [who, laneKey]).catch(() => undefined);
  return who ?? writerId;
}

/**
 * Leads that arrived with no owner (the website form, imports) are routed
 * by their lane. Called by the ladder job and when the pipeline is read.
 */
export async function routeUnowned(cid: number): Promise<number> {
  const rows = await tq<Array<RowDataPacket & { id: number; source: string; lead_number: string }>>(cid, `
    SELECT id, source, lead_number FROM leads
    WHERE owner_user_id IS NULL AND deleted_at IS NULL AND state NOT IN ('won','lost')
      AND received_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) LIMIT 100`).catch(() => []);
  let n = 0;
  for (const r of rows) {
    const lane = laneOf(r.source);
    if (lane.key === 'field') continue;
    const who = await pickOwner(cid, lane.key, null);
    if (!who) continue;
    await texec(cid, 'UPDATE leads SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL', [who, r.id]);
    const s = await tqOne<RowDataPacket>(cid, 'SELECT display_name FROM staff WHERE user_id = ?', [who]);
    await texec(cid, `INSERT INTO lead_events (lead_id, kind, body, user_name) VALUES (?, 'auto', ?, 'System')`,
      [r.id, `Routed to ${s?.display_name ?? 'a sales manager'} (${lane.label}).`]);
    await notify({ companyId: cid, event: 'lead.chase', leadId: r.id, title: `New ${lane.label.toLowerCase()} lead — ${r.lead_number}`,
      body: 'A new lead was routed to you.', directUserIds: [who], onlyDirect: true, appOnly: true,
      dedupeKey: `route:${r.id}` }).catch(() => undefined);
    n++;
  }
  return n;
}

/** A touch: resets the clock and the ladder. */
export async function touched(cid: number, leadId: number): Promise<void> {
  await texec(cid, `UPDATE leads SET last_followup_at = NOW(), chase_notified_at = NULL, esc_step = 0, esc_step_at = NULL,
    first_reply_at = COALESCE(first_reply_at, NOW()) WHERE id = ?`, [leadId]);
}

/** Steps 2 and 3, for every lead gone quiet past its lane's hours. Step 1 is the existing chase to the owner. */
export async function runLadderFor(cid: number): Promise<number> {
  await routeUnowned(cid).catch(() => 0);
  const cfgs = await laneCfgs(cid);
  const rows = await tq<RowDataPacket[]>(cid, `
    SELECT l.id, l.lead_number, l.source, l.esc_step, TRIM(CONCAT_WS(' ', l.first_name, l.last_name)) AS name,
           TIMESTAMPDIFF(MINUTE, GREATEST(l.received_at, COALESCE(l.last_followup_at, l.received_at)), NOW()) / 60 AS quiet
    FROM leads l
    WHERE l.deleted_at IS NULL AND l.state NOT IN ('won','lost') AND l.ro_id IS NULL
      AND COALESCE(l.pipe_status,'') NOT IN ('appointment_set','in_shop','not_repairing','${PARKED.join("','")}')
      AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.cancelled_at IS NULL AND a.starts_at >= NOW())
      AND l.esc_step < 3`).catch(() => []);
  let sent = 0;
  for (const l of rows) {
    const lane = laneOf(l.source), c = cfgs[lane.key];
    const q = Number(l.quiet), step = Number(l.esc_step);
    let to: number[] = [], next = step;
    if (q >= c.step3_hours && step < 3) { to = await usersWithCap(cid, 'admin'); next = 3; }
    else if (q >= c.step2_hours && step < 2) { to = await groupMembers(cid, c.step2_group_id); next = 2; }
    if (next === step) continue;
    await texec(cid, 'UPDATE leads SET esc_step = ?, esc_step_at = NOW() WHERE id = ?', [next, l.id]);
    await texec(cid, `INSERT INTO lead_events (lead_id, kind, body, user_name) VALUES (?, 'auto', ?, 'System')`,
      [l.id, `Escalated to step ${next} — ${Math.floor(q)} hours with no touch.`]);
    if (to.length) {
      await notify({ companyId: cid, event: 'lead.chase', leadId: Number(l.id),
        title: `Lead ${l.lead_number} — step ${next}, ${Math.floor(q)}h untouched`,
        body: `${l.name || 'A lead'} (${lane.label}) has had no call, email or note for ${Math.floor(q)} hours.`,
        directUserIds: to, onlyDirect: true, dedupeKey: `ladder:${l.id}:${next}` }).catch(() => undefined);
      sent++;
    }
  }
  return sent;
}

export function startLadder(): void {
  const tick = async (): Promise<void> => {
    const shops = await mq<Array<RowDataPacket & { company_id: number }>>(
      `SELECT cd.company_id FROM company_databases cd JOIN companies c ON c.id = cd.company_id WHERE c.status = 'active'`).catch(() => []);
    for (const s of shops) await runLadderFor(Number(s.company_id)).catch(() => 0);
  };
  const timer = setInterval(() => { void tick(); }, 10 * 60 * 1000);
  timer.unref();
}
