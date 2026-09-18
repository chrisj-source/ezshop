import { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { tenantPool, texec, tq, tqOne } from './db/tenant';
import { recipientsForStatus, routingConfigured } from './lib/status-routes';
import { emailableUser, letter, sendMail, stampEmailed } from './lib/mail';
import { unsubscribeUrl } from './lib/suppression';
import { mqOne } from './db/master';
import { config } from './config';

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
  | 'supp.decision' | 'age.red' | 'assign.file' | 'sms.reply' | 'mention' | 'lead.chase'
  /* Somebody filled in the form on the shop's own website. One arriving at
     11pm on a Saturday reaches the same people as one at midday — it is one
     event, and it obeys the suppression list like everything else: the in-app
     copy always, the email only if that address has not unsubscribed. */
  | 'web.request';

export interface NotifyInput {
  companyId: number;
  event: EventKey;
  roId?: number | null;
  leadId?: number | null;
  title: string;
  body: string;
  /** owner_role of the status involved — used by scope='owned' */
  ownerRole?: string | null;
  /** the status moved to. With this, status.change routes off the shop's grid. */
  slotId?: string | null;
  /** never notify the person who caused the event */
  actorUserId?: number | null;
  /** direct recipients, bypassing groups (assignment, mentions) */
  directUserIds?: number[];
  /** one row per person per event per file */
  dedupeKey?: string;
  /**
   * In-app only — no email copy, whatever the person has switched on.
   *
   * For a message whose text is restricted at the source: a tag on an internal
   * note. The in-app notification is safe because opening it goes back through
   * the file, which applies the same visibility test; an email is a copy nobody
   * can take back.
   */
  appOnly?: boolean;
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

  /* A status change is routed by the shop's own grid (Admin › Notifications),
     which supersedes the groups below for this one event. The grid is allowed
     to say "nobody" — Initial Wash ships that way — so an empty answer for a
     status is an answer, not a reason to fall through. What decides is whether
     the shop has any routing rows at all. */
  if (input.event === 'status.change' && input.slotId && await routingConfigured(cid)) {
    for (const uid of await recipientsForStatus(cid, input.slotId, input.roId)) {
      recipients.add(uid);
    }
    return deliver(input, recipients);
  }

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
      tq<StaffRow[]>(cid,
        /* Every trade a person works, so a painter who also does body is notified
           for both lanes. Falls back to the single column pre-migration. */
        `SELECT s.user_id, COALESCE(sp.position_key, s.position_key) AS position_key
         FROM staff s
         LEFT JOIN staff_positions sp ON sp.user_id = s.user_id
         WHERE s.active = 1`),
      tq<PositionRow[]>(cid, `SELECT position_key, owner_role FROM positions WHERE enabled = 1`)
    ]);

    const ownerRoleOf = new Map(positions.map(p => [p.position_key, p.owner_role]));
    const staffByPosition = new Map<string, number[]>();
    for (const s of staff) {
      if (!s.position_key) continue;
      const list = staffByPosition.get(s.position_key) ?? [];
      if (list.indexOf(s.user_id) < 0) list.push(s.user_id);
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

  return deliver(input, recipients);
}

/** The write half: one row per recipient, plus its in-app delivery record. */
async function deliver(input: NotifyInput, recipients: Set<number>): Promise<number> {
  const cid = input.companyId;
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

  /* Every message gets its in-app delivery row. Email and SMS become further
     rows on the same message when a shop switches them on, so the send history
     of a message lives in one place rather than beside it. */
  await pool.query(`
    INSERT INTO notification_deliveries (notification_id, user_id, channel, state, sent_at)
    SELECT n.id, n.user_id, 'app', 'sent', n.created_at
    FROM notifications n
    LEFT JOIN notification_deliveries d
           ON d.notification_id = n.id AND d.channel = 'app'
    WHERE n.event_key = ? AND n.user_id IN (?) AND d.id IS NULL`,
    [input.event, [...recipients]]
  ).catch(() => undefined);

  /* And out of the building, for anyone who asked for it. Deliberately not
     awaited: a slow provider must never hold up the request that caused the
     notification, and a failed send is recorded rather than thrown. */
  if (!input.appOnly) void mirrorToEmail(cid, [...recipients], input).catch(() => undefined);

  return recipients.size;
}

/** Same, inside an open transaction — used by the status-change route. */
export async function notifyIn(c: PoolConnection, input: NotifyInput): Promise<void> {
  // The routing queries are reads; run them on the pool, then insert on the tx.
  await notify(input);
}

/**
 * The email copy of a notification, for the people who switched it on.
 *
 * Off by default, one per person per throttle window, and every attempt —
 * including the ones that fail — lands on the message's own delivery record, so
 * "did he get told" has one answer in one place.
 */
async function mirrorToEmail(
  companyId: number, userIds: number[], input: NotifyInput
): Promise<void> {
  const shop = await mqOne<RowDataPacket>(
    'SELECT name FROM companies WHERE id = ?', [companyId]).catch(() => null);

  for (const userId of userIds) {
    /* Asked lazily: most events are unscoped, and the ones that are scoped are
       only asked about for people who got that far through the other tests. */
    const assigned = async (): Promise<boolean> => {
      if (!input.roId) return false;
      const hit = await tqOne<RowDataPacket>(companyId,
        'SELECT 1 AS ok FROM ro_assignments WHERE ro_id = ? AND user_id = ? LIMIT 1',
        [input.roId, userId]).catch(() => null);
      return !!hit;
    };

    const who = await emailableUser(userId, input.event, assigned);
    if (!who) continue;

    const note = await tqOne<RowDataPacket>(companyId, `
      SELECT id FROM notifications
       WHERE user_id = ? AND event_key = ?
       ORDER BY id DESC LIMIT 1`, [userId, input.event]).catch(() => null);

    const body = letter(input.title, [input.body], input.roId
      ? { label: 'Open the file', url: `${config.appUrl}/board.html?ro=${input.roId}` }
      : undefined,
      /* The footer link. Signed against this shop and this address, so it works
         without a sign-in and keeps working if the customer record changes. */
      unsubscribeUrl(companyId, 'email', who.email));

    const sent = await sendMail({
      to: who.email,
      subject: input.title,
      text: body.text,
      html: body.html,
      shopName: shop?.name ? String(shop.name) : null,
      companyId,
      context: input.event
    });

    if (note) {
      await texec(companyId, `
        INSERT INTO notification_deliveries
          (notification_id, user_id, channel, address, state, sent_at, error)
        VALUES (?, ?, 'email', ?, ?, NOW(), ?)`,
        [note.id, userId, who.email,
         /* A refusal is its own state. Recording it as 'failed' would put it in
            the same bucket as a provider outage and invite somebody to retry
            it, which is the one thing that must not happen. */
         sent.ok ? 'sent' : sent.suppressed ? 'suppressed' : 'failed',
         sent.ok ? null : (sent.error ?? '').slice(0, 190)]).catch(() => undefined);
    }

    if (sent.ok) await stampEmailed(userId);
  }
}

export async function unreadCount(companyId: number, userId: number): Promise<number> {
  const rows = await tq<RowDataPacket[]>(companyId,
    `SELECT COUNT(*) AS n FROM notifications
      WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL`, [userId]);
  return Number(rows[0]?.n ?? 0);
}
