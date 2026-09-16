import { RowDataPacket } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, texec } from '../db/tenant';
import { notify } from '../notify';

/**
 * Automatic chase messages on a lead nobody has touched.
 *
 * The leads screen has always FLAGGED a quiet lead. Nothing ever told anybody,
 * which means the flag only worked for a person already looking at the screen
 * — the one least likely to need telling. This is the telling.
 *
 * Two clocks, because there are two kinds of lead:
 *
 *   - written on the **sales screen**: 12 hours. Somebody stood in front of the
 *     customer, the car is expected, and it is waiting on an onboarding call
 *     that should already have happened.
 *   - everything else: 72 hours — the same three days the on-screen flag
 *     already uses, so the row going red and the message going out are one
 *     moment rather than two numbers that drift apart.
 *
 * Both on the **actual** clock rather than shop hours — the same call as the
 * onboarding clock and the mention reminder, for the same reason.
 *
 * Told: the person who **owns** the lead, and **front office**. The owner
 * because it is theirs; front office because a lead with no owner, or an owner
 * who is off this week, still has to be somebody's problem rather than
 * nobody's.
 */

const DEFAULT_CHASE = 72;
const DEFAULT_SALES = 12;

export async function runLeadChase(): Promise<{ shops: number; sent: number }> {
  const shops = await mq<Array<RowDataPacket & { company_id: number }>>(
    `SELECT cd.company_id FROM company_databases cd
       JOIN companies c ON c.id = cd.company_id
      WHERE c.status = 'active'`).catch(() => []);

  let sent = 0;

  for (const shop of shops) {
    const cid = Number(shop.company_id);

    const cfg = await tq<Array<RowDataPacket & { setting_key: string; setting_value: string }>>(
      cid, `SELECT setting_key, setting_value FROM shop_settings
             WHERE setting_key IN ('lead_chase_hours', 'sales_onboard_red_hours')`).catch(() => []);
    const map: Record<string, string> = {};
    for (const r of cfg) map[r.setting_key] = r.setting_value;

    const chaseHours = Math.max(1, Number(map.lead_chase_hours ?? DEFAULT_CHASE) || DEFAULT_CHASE);
    const salesHours = Math.max(1, Number(map.sales_onboard_red_hours ?? DEFAULT_SALES) || DEFAULT_SALES);

    /**
     * Quiet means quiet since the last CONTACT, not since the lead arrived —
     * `last_followup_at` when somebody has chased it, `received_at` otherwise.
     *
     * A booked appointment stops the clock: being booked IS the follow-up, and
     * that is already how the on-screen flag behaves. Nagging somebody about a
     * lead that is on the calendar is how a notification gets muted.
     */
    const due = await tq<Array<RowDataPacket & {
      id: number; lead_number: string; source: string;
      first_name: string | null; last_name: string | null; phone: string | null;
      owner_user_id: number | null; quiet_hours: number;
    }>>(cid, `
      SELECT l.id, l.lead_number, l.source, l.first_name, l.last_name, l.phone,
             l.owner_user_id,
             TIMESTAMPDIFF(HOUR, COALESCE(l.last_followup_at, l.received_at), NOW()) AS quiet_hours
        FROM leads l
       WHERE l.deleted_at IS NULL
         AND l.state NOT IN ('won', 'lost')
         AND l.chase_notified_at IS NULL
         AND (l.followup_snooze_until IS NULL OR l.followup_snooze_until < CURDATE())
         AND NOT EXISTS (
           SELECT 1 FROM appointments a
            WHERE a.lead_id = l.id AND a.cancelled_at IS NULL AND a.starts_at >= NOW())
         AND TIMESTAMPDIFF(HOUR, COALESCE(l.last_followup_at, l.received_at), NOW()) >=
             CASE WHEN l.source = 'sales app' THEN ? ELSE ? END
       ORDER BY l.received_at
       LIMIT 200`, [salesHours, chaseHours]).catch(() => []);

    if (!due.length) continue;

    /* Front office, from the roles table with the usual fallback to the old
       single column — the same lesson as the pay-plan screen. */
    const office = await mq<Array<RowDataPacket & { user_id: number }>>(
      `SELECT DISTINCT u.id AS user_id
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN membership_roles mr
                ON mr.user_id = m.user_id AND mr.company_id = m.company_id
        WHERE m.company_id = ? AND m.status = 'active' AND u.status = 'active'
          AND (mr.role_key = 'front_office' OR (mr.role_key IS NULL AND m.role = 'front_office'))`,
      [cid]).catch(() => []);
    const officeIds = office.map(o => Number(o.user_id));

    for (const l of due) {
      const who = new Set<number>(officeIds);
      if (l.owner_user_id) who.add(Number(l.owner_user_id));
      if (!who.size) continue;   /* nobody to tell; leave it for next sweep */

      const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || 'a customer';
      const isSales = l.source === 'sales app';
      const hours = Math.round(Number(l.quiet_hours));

      await notify({
        companyId: cid,
        event: 'lead.chase',
        leadId: Number(l.id),
        title: isSales
          ? `${l.lead_number}: onboarding call still not made`
          : `${l.lead_number} has gone quiet`,
        body: `${name}${l.phone ? ' \u00b7 ' + l.phone : ''} \u2014 ${hours} hours with no contact` +
              (isSales ? ', written on the sales app.' : '.') +
              ' Marking it chased resets the clock.',
        directUserIds: [...who],
        dedupeKey: `lead-chase:${l.id}`
      }).catch(() => undefined);

      /* Once. Cleared when somebody actually chases it, so the next silence
         earns a fresh message rather than this one repeating hourly. */
      await texec(cid, 'UPDATE leads SET chase_notified_at = NOW() WHERE id = ?', [l.id])
        .catch(() => undefined);
      sent++;
    }
  }

  return { shops: shops.length, sent };
}

/**
 * Hourly. An interval rather than a cron entry: one process on one box, and
 * `unref` so it never holds a restart open.
 */
export function startLeadChase(): void {
  const tick = (): void => { void runLeadChase().catch(() => undefined); };
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
  const soon = setTimeout(tick, 120 * 1000);
  soon.unref();
}
