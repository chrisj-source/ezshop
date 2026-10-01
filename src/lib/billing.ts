import { RowDataPacket } from 'mysql2/promise';
import { mexec, mq, mqOne } from '../db/master';

/** Seats are sold per location in blocks of five. */
export const SEAT_BLOCK = 5;
export const SEAT_BLOCK_CENTS = 4999;

export interface Plan { code: string; label: string; seat_limit: number | null; monthly_cents: number; is_active: number }

export async function plan(code: string): Promise<Plan | null> {
  return (await mqOne<RowDataPacket & Plan>('SELECT * FROM plans WHERE code = ?', [code])) ?? null;
}

export async function activePlans(): Promise<Plan[]> {
  return mq<Array<RowDataPacket & Plan>>('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order');
}

export function seatsOf(p: Plan | null, blocks: number): number {
  return Number(p?.seat_limit ?? SEAT_BLOCK) + SEAT_BLOCK * Math.max(0, blocks);
}

/** A trial is free whatever its blocks; everything else is plan + blocks. */
export function monthlyCentsOf(p: Plan | null, blocks: number): number {
  if (!p || p.code === 'trial') return 0;
  return Number(p.monthly_cents) + SEAT_BLOCK_CENTS * Math.max(0, blocks);
}

/** `companies.seats` is derived; this is the only thing that writes it. */
export async function setBilling(companyId: number, planCode: string, blocks: number): Promise<void> {
  const p = await plan(planCode);
  await mexec(
    'UPDATE companies SET plan_code = ?, extra_seat_blocks = ?, seats = ? WHERE id = ?',
    [planCode, Math.max(0, blocks), seatsOf(p, blocks), companyId]);
}

/** Paid seats against active people. Used to warn, never to refuse. */
export async function seatUse(companyId: number): Promise<{ paid: number; used: number }> {
  const row = await mqOne<RowDataPacket & { seats: number; used: number }>(
    `SELECT c.seats,
            (SELECT COUNT(*) FROM memberships m WHERE m.company_id = c.id AND m.status = 'active') AS used
       FROM companies c WHERE c.id = ?`, [companyId]);
  return { paid: Number(row?.seats ?? 0), used: Number(row?.used ?? 0) };
}

export function seatWarning(s: { paid: number; used: number }): string | null {
  if (s.used <= s.paid) return null;
  return `This shop now has ${s.used} people on ${s.paid} seats. ` +
    `More seats are added in blocks of ${SEAT_BLOCK} at $${(SEAT_BLOCK_CENTS / 100).toFixed(2)} a month.`;
}
