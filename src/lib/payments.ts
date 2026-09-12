import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';

/**
 * Money against a file.
 *
 * The rule the whole feature hangs off: **paid is not a flag anyone sets, it is
 * the balance reaching zero.** `repair_orders.paid_cents` is the cached sum of
 * live payments and `paid` follows it, so the board, the closed list and the
 * chase report all read one figure that cannot drift from the receipts.
 */

export const METHODS = ['check', 'cash', 'card', 'draft', 'writeoff'] as const;
export type Method = typeof METHODS[number];

export const METHOD_LABEL: Record<Method, string> = {
  check: 'Check',
  cash: 'Cash',
  card: 'Card',
  draft: 'Insurance draft / EFT',
  writeoff: 'Write-off / discount'
};

/** The two methods that carry a number, and what that number is called. */
export const REF_LABEL: Partial<Record<Method, string>> = {
  check: 'Check number',
  draft: 'Draft number'
};

export interface Payment {
  id: number;
  amountCents: number;
  method: Method;
  methodLabel: string;
  payer: 'customer' | 'insurer';
  reference: string | null;
  note: string | null;
  receivedAt: string;
  recordedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface Balance {
  approvalCents: number;
  paidCents: number;
  balanceCents: number;
  customerCents: number;
  insurerCents: number;
  paid: boolean;
  count: number;
}

/** A DATE column read back without the pool's timezone getting involved. */
function day(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
}

export async function paymentsFor(companyId: number, roId: number): Promise<Payment[]> {
  const rows = await tq<RowDataPacket[]>(companyId, `
    SELECT id, amount_cents, method, payer, reference, note, received_at,
           recorded_by_name, voided_at, void_reason
      FROM ro_payments
     WHERE ro_id = ?
     ORDER BY received_at DESC, id DESC`, [roId]);

  return rows.map(r => ({
    id: Number(r.id),
    amountCents: Number(r.amount_cents),
    method: r.method as Method,
    methodLabel: METHOD_LABEL[r.method as Method],
    payer: r.payer as 'customer' | 'insurer',
    reference: r.reference ?? null,
    note: r.note ?? null,
    receivedAt: day(r.received_at),
    recordedBy: r.recorded_by_name ?? null,
    voidedAt: r.voided_at ? String(r.voided_at) : null,
    voidReason: r.void_reason ?? null
  }));
}

/**
 * Recount from the payments themselves and write the answer onto the file.
 * Called after every write, so the cached figure is never a guess.
 */
export async function recount(companyId: number, roId: number): Promise<Balance> {
  const [sums] = await tq<RowDataPacket[]>(companyId, `
    SELECT COALESCE(SUM(amount_cents), 0) AS paid,
           COALESCE(SUM(IF(payer = 'customer', amount_cents, 0)), 0) AS cust,
           COALESCE(SUM(IF(payer = 'insurer',  amount_cents, 0)), 0) AS ins,
           COUNT(*) AS n
      FROM ro_payments WHERE ro_id = ? AND voided_at IS NULL`, [roId]);

  const paidCents = Number(sums?.paid ?? 0);

  const f = await tqOne<RowDataPacket>(companyId,
    'SELECT amount_cents, paid FROM repair_orders WHERE id = ?', [roId]);
  const approvalCents = Number(f?.amount_cents ?? 0);

  /* A file with no approval amount on it cannot be "paid in full" by an empty
     balance — that would mark every new file paid the moment it opened. */
  const paid = approvalCents > 0 && paidCents >= approvalCents;

  await texec(companyId,
    `UPDATE repair_orders
        SET paid_cents = ?, paid = ?, paid_at = IF(?, COALESCE(paid_at, NOW()), NULL)
      WHERE id = ?`,
    [paidCents, paid ? 1 : 0, paid ? 1 : 0, roId]);

  return {
    approvalCents,
    paidCents,
    balanceCents: approvalCents - paidCents,
    customerCents: Number(sums?.cust ?? 0),
    insurerCents: Number(sums?.ins ?? 0),
    paid,
    count: Number(sums?.n ?? 0)
  };
}

export async function balanceFor(companyId: number, roId: number): Promise<Balance> {
  const [row] = await tq<RowDataPacket[]>(companyId, `
    SELECT r.amount_cents, r.paid_cents, r.paid,
           COALESCE(SUM(IF(p.payer = 'customer', p.amount_cents, 0)), 0) AS cust,
           COALESCE(SUM(IF(p.payer = 'insurer',  p.amount_cents, 0)), 0) AS ins,
           COUNT(p.id) AS n
      FROM repair_orders r
      LEFT JOIN ro_payments p ON p.ro_id = r.id AND p.voided_at IS NULL
     WHERE r.id = ?
     GROUP BY r.id`, [roId]);

  const approvalCents = Number(row?.amount_cents ?? 0);
  const paidCents = Number(row?.paid_cents ?? 0);
  return {
    approvalCents,
    paidCents,
    balanceCents: approvalCents - paidCents,
    customerCents: Number(row?.cust ?? 0),
    insurerCents: Number(row?.ins ?? 0),
    paid: !!row?.paid,
    count: Number(row?.n ?? 0)
  };
}

export interface NewPayment {
  amountCents: number;
  method: Method;
  payer: 'customer' | 'insurer';
  reference: string | null;
  note: string | null;
  receivedAt: string;
}

/**
 * Validate one payment as the form should have. Returns the reason it cannot be
 * taken, or null. The duplicate-number rule is the database's — a unique index
 * on (ro_id, method:reference) — and is caught where the insert happens.
 */
export function checkPayment(p: Partial<NewPayment>): string | null {
  if (!p.method || !(METHODS as readonly string[]).includes(p.method)) {
    return 'Pick how it was paid.';
  }
  if (!Number.isFinite(p.amountCents) || Math.round(Number(p.amountCents)) === 0) {
    return 'An amount is required.';
  }
  if (Number(p.amountCents) < 0) return 'A payment cannot be negative.';
  if (REF_LABEL[p.method] && !String(p.reference ?? '').trim()) {
    return `${REF_LABEL[p.method]} is required for a ${METHOD_LABEL[p.method].toLowerCase()}.`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.receivedAt ?? ''))) {
    return 'A received date is required.';
  }
  return null;
}

/** Is this number already on this file? Asked before the insert, for the message. */
export async function duplicateOf(
  companyId: number, roId: number, method: Method, reference: string | null
): Promise<{ amountCents: number; receivedAt: string } | null> {
  const ref = String(reference ?? '').trim();
  if (!ref) return null;
  const row = await tqOne<RowDataPacket>(companyId, `
    SELECT amount_cents, received_at FROM ro_payments
     WHERE ro_id = ? AND method = ? AND reference = ? AND voided_at IS NULL
     LIMIT 1`, [roId, method, ref]);
  return row ? { amountCents: Number(row.amount_cents), receivedAt: day(row.received_at) } : null;
}
