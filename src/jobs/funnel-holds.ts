import { RowDataPacket } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, texec } from '../db/tenant';
import { notify } from '../notify';
import { deskRecipients } from '../routes/funnel';
import { pushAppointment } from '../routes/gcal';
import { shopCalendar, dayWindow } from '../lib/shophours';

/**
 * Held drop-offs that nobody answered, and held slots the shop moved out from
 * under.
 *
 * Two jobs, one sweep, because both are the same question asked of the same
 * rows: is this hold still honest?
 *
 * **Lapsing.** A request held past its window is released and the desk is told.
 * The LEAD stays — the customer still wants the work, and a slot going back on
 * the board is not the same as losing them. Deliberately no email to the
 * customer: they were promised a confirmation or a call, and "your request
 * expired because we did not get to it" is a call, not an automated message.
 *
 * **Conflicts.** The owner can block a morning after somebody has been told
 * they have it. Neither answer is defensible on its own — releasing it
 * silently breaks a promise, honouring it silently puts a stranger outside the
 * hours — so it is FLAGGED and left for a person, which is the only version
 * where somebody decides.
 */

const EVERY = 15 * 60 * 1000;

export function startFunnelHolds(): void {
  const t = setInterval(() => { void sweepHolds().catch(() => undefined); }, EVERY);
  t.unref();
  /* A minute after boot rather than at boot: a restart during shop hours
     should not spend its first moment walking every tenant. */
  const first = setTimeout(() => { void sweepHolds().catch(() => undefined); }, 60_000);
  first.unref();
}

export async function sweepHolds(): Promise<{ lapsed: number; conflicted: number }> {
  const shops = await mq<Array<RowDataPacket & { id: number; timezone: string }>>(
    `SELECT c.id, c.timezone FROM companies c
      WHERE c.status NOT IN ('suspended','closed')`).catch(() => []);

  let lapsed = 0, conflicted = 0;
  for (const shop of shops) {
    lapsed += await lapseExpired(shop.id);
    conflicted += await flagConflicts(shop.id, shop.timezone);
  }
  return { lapsed, conflicted };
}

async function lapseExpired(companyId: number): Promise<number> {
  const due = await tq<RowDataPacket[]>(companyId, `
    SELECT id, appointment_id, lead_id, customer_name, starts_at
      FROM funnel_requests
     WHERE state = 'held' AND answered_at IS NULL
       AND hold_until IS NOT NULL AND hold_until <= NOW()
     LIMIT 100`).catch(() => [] as RowDataPacket[]);

  if (!due.length) return 0;

  for (const r of due) {
    await texec(companyId,
      `UPDATE funnel_requests SET state = 'lapsed', hold_until = NULL WHERE id = ? AND state = 'held'`,
      [r.id]);

    /* The slot goes back. Cancelling the appointment is what releases it — the
       hold was never anything other than a real row on the board. */
    if (r.appointment_id) {
      await texec(companyId,
        'UPDATE appointments SET cancelled_at = NOW() WHERE id = ? AND cancelled_at IS NULL',
        [r.appointment_id]).catch(() => undefined);
      pushAppointment(companyId, Number(r.appointment_id), 'cancel').catch(() => {});
    }

    if (r.lead_id) {
      await texec(companyId, `
        INSERT INTO lead_events (lead_id, kind, body, user_name)
        VALUES (?, 'auto', ?, 'Easy Shop')`,
        [r.lead_id,
         'The held slot expired before anybody answered it, so it went back on the board. ' +
         'The lead is still open.']).catch(() => undefined);
      /* Back to new: it is not a booked appraisal any more, and the follow-up
         clock should treat it as work nobody has done. */
      await texec(companyId,
        `UPDATE leads SET state = 'new' WHERE id = ? AND state = 'appraisal_booked'`,
        [r.lead_id]).catch(() => undefined);
    }

    void notify({
      companyId,
      event: 'web.request',
      leadId: r.lead_id ? Number(r.lead_id) : null,
      title: `A website request lapsed — ${r.customer_name}`,
      body: `Nobody answered it inside the hold window, so the slot has gone back on the board. ` +
            `The lead is still open and wants a call.`,
      directUserIds: await deskRecipients(companyId),
      dedupeKey: `web-lapsed-${r.id}`
    }).catch(() => undefined);
  }

  return due.length;
}

/**
 * A held slot the shop's own hours no longer cover.
 *
 * Only held requests are checked: a confirmed appointment outside hours is the
 * shop's own booking to keep, exactly as a desk override would be.
 */
async function flagConflicts(companyId: number, tz: string): Promise<number> {
  const held = await tq<RowDataPacket[]>(companyId, `
    SELECT id, starts_at, customer_name, lead_id
      FROM funnel_requests
     WHERE state = 'held' AND answered_at IS NULL AND conflicted_at IS NULL
     LIMIT 100`).catch(() => [] as RowDataPacket[]);

  if (!held.length) return 0;

  const cal = await shopCalendar(companyId, tz);
  let n = 0;

  for (const r of held) {
    const when = r.starts_at instanceof Date
      ? r.starts_at.toISOString() : String(r.starts_at).replace(' ', 'T');
    const ymd = when.slice(0, 10);
    const hh = Number(when.slice(11, 13)) * 60 + Number(when.slice(14, 16));
    const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();

    const day = dayWindow(cal, ymd, dow);
    const mins = (t: string): number => {
      const [a, b] = String(t).split(':').map(Number);
      return (a || 0) * 60 + (b || 0);
    };

    const outside = day.closed || hh < mins(day.open) || hh >= mins(day.close);
    if (!outside) continue;

    await texec(companyId, 'UPDATE funnel_requests SET conflicted_at = NOW() WHERE id = ?', [r.id]);
    n++;

    void notify({
      companyId,
      event: 'web.request',
      leadId: r.lead_id ? Number(r.lead_id) : null,
      title: `A held slot no longer fits the shop's hours — ${r.customer_name}`,
      body: `${ymd} at ${when.slice(11, 16)} is now outside the hours for that day. ` +
            `It is still held. Confirm it anyway, move it, or decline — but somebody has to choose.`,
      directUserIds: await deskRecipients(companyId),
      dedupeKey: `web-conflict-${r.id}`
    }).catch(() => undefined);
  }

  return n;
}
