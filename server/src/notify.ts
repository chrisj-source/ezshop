import { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { tenantPool, tq } from './db/tenant';

/**
 * In-app notifications.
 *
 * A group subscribes to events. Its members are positions, named people, or
 * both. Scope decides whether a member hears about every file or only the
 * ones their position owns — that is what keeps the painter from being
 * notified about disassembly.
 */

export type EventKey =
  | 'status.change' | 'parts.arrived' | 'parts.late' | 'parts.return'
  | 'supp.decision' | 'age.red' | 'assign.file' | 'sms.reply';

export interface NotifyInput {
  companyId: number;
  event: EventKey;
  roId?: number | null;
  leadId?: number | null;
  title: string;
  body: string;
  /** owner_role of the status involved — used by scope='owned' */
  ownerRole?: string | null;
  /** never notify the person who caused the event */
  actorUserId?: number | null;
  /** direct recipients, bypassing groups (assignment, mentions) */
  directUserIds?: number[];
  /** one row per person per event per file */
  dedupeKey?: string;
}

interface GroupRow extends RowDataPacket {
  group_id: number;
  scope: string | null;
  channel_app: number;
}

interface MemberRow extends RowDataPacket {
  group_id: number;
  member_type: 'position' | 'user';
  position_key: string | null;
  user_id: number | null;
}

interface StaffRow extends RowDataPacket {
  user_id: number;
  position_key: string | null;
}

interface PositionRow extends RowDataPacket {
  position_key: string;
  owner_role: string | null;
}

export async function notify(input: NotifyInput): Promise<number> {
  const cid = input.companyId;
  const recipients = new Set<number>(input.directUserIds ?? []);

  const groups = await tq<GroupRow[]>(cid,
    `SELECT ns.group_id, ns.scope, ns.channel_app
     FROM notification_subscriptions ns
     WHERE ns.event_key = ? AND ns.enabled = 1 AND ns.channel_app = 1`,
    [input.event]
  );

  if (groups.length) {
    const ids = groups.map(g => g.group_id);
    const [members, staff, positions] = await Promise.all([
      tq<MemberRow[]>(cid,
        `SELECT group_id, member_type, position_key, user_id
         FROM notification_group_members WHERE group_id IN (?)`, [ids]),
      tq<StaffRow[]>(cid, `SELECT user_id, position_key FROM staff WHERE active = 1`),
      tq<PositionRow[]>(cid, `SELECT position_key, owner_role FROM positions WHERE enabled = 1`)
    ]);

    const ownerRoleOf = new Map(positions.map(p => [p.position_key, p.owner_role]));
    const staffByPosition = new Map<string, number[]>();
    for (const s of staff) {
      if (!s.position_key) continue;
      const list = staffByPosition.get(s.position_key) ?? [];
      list.push(s.user_id);
      staffByPosition.set(s.position_key, list);
    }

    for (const g of groups) {
      const mine = members.filter(m => m.group_id === g.group_id);
      for (const m of mine) {
        if (m.member_type === 'user' && m.user_id) { recipients.add(m.user_id); continue; }
        if (m.member_type !== 'position' || !m.position_key) continue;

        // scope 'owned': only when this position owns the status in question
        if (g.scope === 'owned' && input.ownerRole) {
          const role = ownerRoleOf.get(m.position_key);
          if (!role || role.toLowerCase() !== input.ownerRole.toLowerCase()) continue;
        }
        for (const uid of staffByPosition.get(m.position_key) ?? []) recipients.add(uid);
      }
    }
  }

  if (input.actorUserId) recipients.delete(input.actorUserId);
  if (!recipients.size) return 0;

  const pool = await tenantPool(cid);
  const rows = [...recipients].map(uid => [
    uid, input.event, input.roId ?? null, input.leadId ?? null,
    input.title.slice(0, 120), input.body.slice(0, 500),
    input.dedupeKey ? `${input.dedupeKey}` : null
  ]);

  await pool.query(
    `INSERT IGNORE INTO notifications (user_id, event_key, ro_id, lead_id, title, body, dedupe_key)
     VALUES ?`, [rows]
  );

  return recipients.size;
}

/** Same, inside an open transaction — used by the status-change route. */
export async function notifyIn(c: PoolConnection, input: NotifyInput): Promise<void> {
  // The routing queries are reads; run them on the pool, then insert on the tx.
  await notify(input);
}

export async function unreadCount(companyId: number, userId: number): Promise<number> {
  const rows = await tq<RowDataPacket[]>(companyId,
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`, [userId]);
  return Number(rows[0]?.n ?? 0);
}
