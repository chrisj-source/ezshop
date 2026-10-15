import { RowDataPacket } from 'mysql2/promise';
import { tq, texec } from '../db/tenant';

/**
 * The lead pipeline (1c). One column per lane, side by side; rows oldest
 * first; each row flagged with its status. The lane is read off the source.
 * Status sets are per lane. Appointment set, No show, In the shop and Not
 * repairing are in every lane — the automatic moves land in them.
 */

export interface PipeStatus { key: string; label: string; code: string; tone: string }

const T = (key: string, label: string, code: string, tone: string): PipeStatus => ({ key, label, code, tone });
export const STATUS: Record<string, PipeStatus> = {
  fresh:              T('fresh', 'Fresh', 'NEW', 'oklch(0.80 0.13 80)'),
  no_answer:          T('no_answer', 'No answer', 'N/A', 'oklch(0.72 0.14 30)'),
  awaiting_quote:     T('awaiting_quote', 'Awaiting quote', 'QUOTE', 'oklch(0.74 0.10 245)'),
  estimate_written:   T('estimate_written', 'Estimate written', 'EST', 'oklch(0.74 0.10 245)'),
  estimate_sent:      T('estimate_sent', 'Estimate sent', 'SENT', 'oklch(0.74 0.10 220)'),
  eval_done:          T('eval_done', 'Eval done', 'EVAL', 'oklch(0.74 0.10 270)'),
  referrer_told:      T('referrer_told', 'Referrer told', 'TOLD', 'oklch(0.74 0.10 270)'),
  needs_reschedule:   T('needs_reschedule', 'Needs reschedule', 'RESCH', 'oklch(0.76 0.13 55)'),
  attempting_reclose: T('attempting_reclose', 'Attempting to reclose', 'RECL', 'oklch(0.74 0.12 310)'),
  cancelled_appt:     T('cancelled_appt', 'Cancelled appt', 'CANC', 'oklch(0.70 0.15 25)'),
  appointment_set:    T('appointment_set', 'Appointment set', 'APPT', 'oklch(0.76 0.13 150)'),
  no_show:            T('no_show', 'No show', 'NOSHW', 'oklch(0.70 0.15 25)'),
  in_shop:            T('in_shop', 'In the shop', 'SHOP', 'oklch(0.76 0.10 185)'),
  not_repairing:      T('not_repairing', 'Not repairing', 'LOST', 'oklch(0.60 0.02 260)'),
  junk:               T('junk', 'Junk', 'JUNK', 'oklch(0.55 0.02 260)'),
  unqualified:        T('unqualified', 'Unqualified', 'UNQ', 'oklch(0.55 0.02 260)'),
  vendor:             T('vendor', 'Vendor', 'VEND', 'oklch(0.55 0.02 260)')
};

export const ALWAYS = ['appointment_set', 'no_show', 'in_shop', 'not_repairing'];
export const PARKED = ['junk', 'unqualified', 'vendor'];
/** Off the working columns unless Show closed is ticked. The clock stops here too. */
export const CLOSED = ['in_shop', 'not_repairing', ...PARKED];

export const LANES = [
  { key: 'internet', label: 'Internet', sources: ['website', 'web_form', 'google', 'scheduler', 'meta', 'tiktok'],
    statuses: ['fresh', 'no_answer', 'awaiting_quote', 'needs_reschedule', 'cancelled_appt', 'attempting_reclose'], overdueHours: 1 },
  { key: 'walkin', label: 'Walk-in', sources: ['walk-in'],
    statuses: ['estimate_written', 'estimate_sent', 'eval_done', 'needs_reschedule', 'attempting_reclose'], overdueHours: 24 },
  { key: 'phone', label: 'Phone', sources: ['phone', 'other'],
    statuses: ['fresh', 'no_answer', 'awaiting_quote', 'needs_reschedule', 'cancelled_appt', 'attempting_reclose'], overdueHours: 1 },
  { key: 'referral', label: 'Referral', sources: ['referral'],
    statuses: ['fresh', 'referrer_told', 'awaiting_quote', 'attempting_reclose'], overdueHours: 4 },
  { key: 'field', label: 'Field sales', sources: ['sales app'],
    statuses: ['fresh', 'no_answer', 'awaiting_quote', 'needs_reschedule', 'attempting_reclose'], overdueHours: 24 }
];

export function laneOf(source: unknown): typeof LANES[number] {
  const s = String(source ?? '').toLowerCase();
  return LANES.find(l => l.sources.includes(s)) ?? LANES[2];
}
export function laneStatuses(laneKey: string): string[] {
  const l = LANES.find(x => x.key === laneKey) ?? LANES[2];
  return [...l.statuses, ...ALWAYS];
}

export const meta = () => ({
  lanes: LANES.map(l => ({ key: l.key, label: l.label, sources: l.sources, statuses: laneStatuses(l.key), overdueHours: l.overdueHours })),
  statuses: STATUS, parked: PARKED
});

/**
 * The automatic moves, settled whenever the pipeline is read: RO opened → In
 * the shop; booked → Appointment set; appointment passed with no check-in →
 * No show; appointment cancelled → Cancelled appt. Each move is a timeline line.
 * Parked and Not repairing are a person's call and never moved.
 */
export async function syncPipe(cid: number): Promise<void> {
  const keep = `COALESCE(l.pipe_status, '') NOT IN ('junk','unqualified','vendor','not_repairing')`;
  const future = `EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.cancelled_at IS NULL AND a.starts_at >= NOW())`;
  const rules: Array<[string, string, string]> = [
    ['in_shop', `l.ro_id IS NOT NULL AND COALESCE(l.pipe_status,'') <> 'in_shop'`, 'Moved to In the shop — the file is open.'],
    ['appointment_set', `l.ro_id IS NULL AND COALESCE(l.pipe_status,'') <> 'appointment_set' AND ${future}`, 'Moved to Appointment set — booked.'],
    ['no_show', `l.ro_id IS NULL AND l.pipe_status = 'appointment_set' AND NOT ${future}
       AND EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.cancelled_at IS NULL AND a.starts_at < DATE_SUB(NOW(), INTERVAL 2 HOUR))`,
     'Moved to No show — the appointment passed with no check-in.'],
    ['cancelled_appt', `l.ro_id IS NULL AND l.pipe_status = 'appointment_set' AND NOT ${future}`, 'Moved to Cancelled appt — the appointment was cancelled.']
  ];
  for (const [to, cond, text] of rules) {
    const ids = await tq<Array<RowDataPacket & { id: number }>>(cid,
      `SELECT l.id FROM leads l WHERE l.deleted_at IS NULL AND ${keep} AND ${cond} LIMIT 500`).catch(() => []);
    if (!ids.length) continue;
    const list = ids.map(r => Number(r.id));
    await texec(cid, `UPDATE leads SET pipe_status = ?, pipe_status_at = NOW() WHERE id IN (?)`, [to, list]);
    await texec(cid, `INSERT INTO lead_events (lead_id, kind, body, user_name) SELECT id, 'auto', ?, 'System' FROM leads WHERE id IN (?)`, [text, list]);
  }
}
