import { RowDataPacket } from 'mysql2/promise';
import { tq, texec } from '../db/tenant';

/**
 * The lead pipeline (1c). One column per lane, side by side; rows oldest
 * first; each row flagged with its status. The lane is read off the source.
 * Status sets are per lane. Appointment set, No show, In the shop and Not
 * repairing are in every lane — the automatic moves land in them.
 */

export interface PipeStatus { key: string; label: string; tone: string }

export const STATUS: Record<string, PipeStatus> = {
  fresh:              { key: 'fresh', label: 'Fresh', tone: 'var(--acc)' },
  contacted:          { key: 'contacted', label: 'Contacted', tone: 'var(--move)' },
  no_answer:          { key: 'no_answer', label: 'No answer', tone: 'var(--blocked)' },
  awaiting_quote:     { key: 'awaiting_quote', label: 'Awaiting quote', tone: 'var(--acc2)' },
  estimate_given:     { key: 'estimate_given', label: 'Estimate given', tone: 'var(--acc2)' },
  eval_booked:        { key: 'eval_booked', label: 'Eval booked', tone: 'var(--move)' },
  signed_up:          { key: 'signed_up', label: 'Signed up', tone: 'var(--acc)' },
  awaiting_drop:      { key: 'awaiting_drop', label: 'Awaiting drop', tone: 'var(--move)' },
  needs_reschedule:   { key: 'needs_reschedule', label: 'Needs reschedule', tone: 'var(--blocked)' },
  attempting_reclose: { key: 'attempting_reclose', label: 'Attempting to reclose', tone: 'var(--blocked)' },
  cancelled_appt:     { key: 'cancelled_appt', label: 'Cancelled appt', tone: 'var(--stopped)' },
  appointment_set:    { key: 'appointment_set', label: 'Appointment set', tone: 'var(--done)' },
  no_show:            { key: 'no_show', label: 'No show', tone: 'var(--stopped)' },
  in_shop:            { key: 'in_shop', label: 'In the shop', tone: 'var(--done)' },
  not_repairing:      { key: 'not_repairing', label: 'Not repairing', tone: 'var(--dim)' },
  junk:               { key: 'junk', label: 'Junk', tone: 'var(--dim)' },
  unqualified:        { key: 'unqualified', label: 'Unqualified', tone: 'var(--dim)' },
  vendor:             { key: 'vendor', label: 'Vendor', tone: 'var(--dim)' }
};

export const ALWAYS = ['appointment_set', 'no_show', 'in_shop', 'not_repairing'];
export const PARKED = ['junk', 'unqualified', 'vendor'];

export const LANES = [
  { key: 'internet', label: 'Internet', sources: ['website', 'google', 'scheduler', 'meta', 'tiktok'],
    statuses: ['fresh', 'no_answer', 'awaiting_quote', 'needs_reschedule', 'attempting_reclose', 'cancelled_appt'], overdueHours: 2 },
  { key: 'walkin', label: 'Walk-in', sources: ['walk-in'],
    statuses: ['estimate_given', 'eval_booked', 'attempting_reclose', 'cancelled_appt'], overdueHours: 48 },
  { key: 'phone', label: 'Phone', sources: ['phone', 'other'],
    statuses: ['fresh', 'no_answer', 'awaiting_quote', 'needs_reschedule', 'cancelled_appt'], overdueHours: 24 },
  { key: 'referral', label: 'Referral', sources: ['referral'],
    statuses: ['fresh', 'contacted', 'awaiting_quote', 'cancelled_appt'], overdueHours: 24 },
  { key: 'field', label: 'Field sales', sources: ['sales app'],
    statuses: ['signed_up', 'awaiting_drop', 'needs_reschedule', 'cancelled_appt'], overdueHours: 24 }
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
