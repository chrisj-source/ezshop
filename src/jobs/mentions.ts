import { RowDataPacket } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, texec } from '../db/tenant';
import { notify } from '../notify';

/**
 * The mention reminder sweep.
 *
 * A tag that goes unanswered is the thing this whole feature exists to prevent,
 * so at 24 hours it says so — to three people, decided with the shop:
 *
 *   - the person tagged, again. An unread notification is not a reminder.
 *   - **the person who tagged them**, because otherwise they assume it was
 *     handled and find out days later that it was not.
 *   - the shop **owner(s)**, which is what makes it a shop problem rather than
 *     a private one between two people.
 *
 * Actual elapsed hours, not shop hours: a Friday evening tag needs answering on
 * Saturday, and a clock that waits until Monday is not a reminder.
 *
 * Reminded once, never again — `reminded_at` is stamped, and at the overdue
 * mark the file simply reads as overdue rather than sending more mail. Nagging
 * past the point of being useful is how people learn to filter a sender.
 */

const DEFAULT_REMIND = 24;

export async function runMentionReminders(): Promise<{ shops: number; sent: number }> {
  const shops = await mq<Array<RowDataPacket & { company_id: number; name: string }>>(
    `SELECT cd.company_id, c.name
       FROM company_databases cd JOIN companies c ON c.id = cd.company_id
      WHERE c.status = 'active'`
  ).catch(() => []);

  let sent = 0;

  for (const shop of shops) {
    const cid = Number(shop.company_id);

    const cfg = await tq<Array<RowDataPacket & { setting_key: string; setting_value: string }>>(
      cid, `SELECT setting_key, setting_value FROM shop_settings
             WHERE setting_key = 'mention_remind_hours'`).catch(() => []);
    const hours = Math.max(1, Number(cfg[0]?.setting_value ?? DEFAULT_REMIND) || DEFAULT_REMIND);

    const due = await tq<Array<RowDataPacket & {
      id: number; ro_id: number; user_id: number; by_user_id: number | null;
      by_user_name: string | null; ro_number: string | null; age_hours: number;
    }>>(cid, `
      SELECT m.id, m.ro_id, m.user_id, m.by_user_id, m.by_user_name,
             r.ro_number, TIMESTAMPDIFF(HOUR, m.created_at, NOW()) AS age_hours
        FROM ro_mentions m
        JOIN repair_orders r ON r.id = m.ro_id
       WHERE m.cleared_at IS NULL
         AND m.reminded_at IS NULL
         AND TIMESTAMPDIFF(HOUR, m.created_at, NOW()) >= ?
       ORDER BY m.created_at
       LIMIT 200`, [hours]).catch(() => []);

    if (!due.length) continue;

    /* The shop's owners. Read from the roles table with the usual fallback to
       the old single column — the same lesson as the pay-plan screen. */
    const owners = await mq<Array<RowDataPacket & { user_id: number }>>(
      `SELECT DISTINCT u.id AS user_id
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN membership_roles mr
                ON mr.user_id = m.user_id AND mr.company_id = m.company_id
        WHERE m.company_id = ? AND m.status = 'active'
          AND (mr.role_key = 'owner' OR (mr.role_key IS NULL AND m.role = 'owner'))`,
      [cid]).catch(() => []);
    const ownerIds = owners.map(o => Number(o.user_id));

    for (const m of due) {
      const who = new Set<number>([Number(m.user_id), ...ownerIds]);
      if (m.by_user_id) who.add(Number(m.by_user_id));

      await notify({
        companyId: cid,
        event: 'mention',
        roId: Number(m.ro_id),
        title: `Still waiting: ${m.by_user_name ?? 'somebody'} tagged` +
               `${m.ro_number ? ' on RO ' + m.ro_number : ''}`,
        body: `${Math.round(Number(m.age_hours))} hours with no reply. ` +
              'A note on the file clears it.',
        directUserIds: [...who],
        /* One reminder per mention, whatever else happens on the file. */
        dedupeKey: `mention-remind:${m.id}`
      }).catch(() => undefined);

      await texec(cid, 'UPDATE ro_mentions SET reminded_at = NOW() WHERE id = ?', [m.id])
        .catch(() => undefined);
      sent++;
    }
  }

  return { shops: shops.length, sent };
}

/**
 * Hourly. Not a cron entry: the app is one process on one box, and an interval
 * is the honest shape until it is not. `unref` so it never holds the process
 * open during a restart.
 */
export function startMentionReminders(): void {
  const tick = (): void => {
    void runMentionReminders().catch(() => undefined);
  };
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
  /* A first pass shortly after boot, so a restart does not skip an hour. */
  const soon = setTimeout(tick, 90 * 1000);
  soon.unref();
}
