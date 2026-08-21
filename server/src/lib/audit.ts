import { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { texec, tq } from '../db/tenant';

/**
 * The audit log.
 *
 * The notes on a file say what someone chose to write down. This says what
 * actually happened to the record, whether anyone noted it or not — a deductible
 * edited, a document pulled, a part quietly marked received.
 *
 * Three rules the rest of the server has to hold to:
 *
 *  1. **Append only.** Nothing here is ever updated or deleted. There is no
 *     endpoint that can, and no reason to add one.
 *  2. **Written with the change, not after it.** Where the change runs in a
 *     transaction, `auditIn` writes inside the same one, so a failed write
 *     leaves no entry and an entry can never exist without its write.
 *  3. **Sensitive is decided here.** Money, deletes and voids, permission and
 *     setup changes are marked at write time, so the screen never guesses.
 */

export type Area =
  | 'Repair order' | 'Lead' | 'Parts' | 'Money' | 'Documents'
  | 'Void / delete' | 'Permissions' | 'Setup' | 'Messages' | 'Payroll';

/** Areas that are sensitive whatever the action. */
const SENSITIVE_AREAS: Area[] = ['Money', 'Void / delete', 'Permissions', 'Payroll'];

/** Actions that are sensitive whatever the area. */
const SENSITIVE_ACTIONS = /^(delete|deleted|remove|removed|void|purge|unclose|close_undo|total_loss_undo|permission)/i;

export interface Change { field: string; from: string | number | null; to: string | number | null }

export interface AuditWrite {
  entity: string;
  entityId?: number | null;
  /** The file this touched, when there is one — the screen groups on it. */
  roId?: number | null;
  action: string;
  area: Area;
  /** One line, already written for a human: "Deductible changed — $500.00 → $0.00". */
  label: string;
  changes?: Change[];
  /** What the person wrote with the change. Null is the interesting case. */
  note?: string | null;
  detail?: unknown;
  /** Force the sensitive mark on for something the rules above would miss. */
  sensitive?: boolean;
}

/** Who did it, as the middleware knows them. */
export interface Actor {
  user: { id: number; name: string };
  roleLabel?: string | null;
  source?: string;
  client?: string | null;
}

function sensitiveFor(w: AuditWrite): boolean {
  if (w.sensitive !== undefined) return w.sensitive;
  if (SENSITIVE_AREAS.includes(w.area)) return true;
  return SENSITIVE_ACTIONS.test(w.action);
}

function values(companyActor: Actor, w: AuditWrite): unknown[] {
  return [
    companyActor.user.id, companyActor.user.name, companyActor.roleLabel ?? null,
    w.entity, w.entityId ?? null, w.roId ?? null, w.action, w.area, w.label.slice(0, 190),
    w.changes && w.changes.length ? JSON.stringify(w.changes) : null,
    w.note ? String(w.note).slice(0, 500) : null,
    w.detail === undefined ? null : JSON.stringify(w.detail),
    sensitiveFor(w) ? 1 : 0,
    companyActor.source ?? 'web',
    companyActor.client ? String(companyActor.client).slice(0, 190) : null
  ];
}

const SQL = `
  INSERT INTO audit_log
    (user_id, user_name, actor_role, entity, entity_id, ro_id, action, area, label,
     changes, note, detail, is_sensitive, source, client)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Record a change. Never throws — an audit failure must not take the change with
 * it, and a missing entry is visible in the log's own gaps.
 */
export async function audit(companyId: number, actor: Actor, w: AuditWrite): Promise<void> {
  await texec(companyId, SQL, values(actor, w)).catch(() => undefined);
}

/** The same, inside the transaction that makes the change. Preferred. */
export async function auditIn(conn: PoolConnection, actor: Actor, w: AuditWrite): Promise<void> {
  await conn.query(SQL, values(actor, w));
}

/** A tidy before/after list from two flat objects, skipping what did not move. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  labels: Record<string, string> = {}
): Change[] {
  const out: Change[] = [];
  for (const key of Object.keys(after)) {
    const a = before[key], b = after[key];
    if (a === b) continue;
    if (a == null && b == null) continue;
    out.push({
      field: labels[key] ?? key,
      from: a == null ? null : (typeof a === 'number' ? a : String(a)),
      to: b == null ? null : (typeof b === 'number' ? b : String(b))
    });
  }
  return out;
}

export function moneyStr(cents: number): string {
  return '$' + (Number(cents) / 100).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The distinct people who appear in the log, for the reader's filter. */
export async function auditActors(companyId: number): Promise<Array<{ id: number | null; name: string }>> {
  const rows = await tq<Array<RowDataPacket & { user_id: number | null; user_name: string | null }>>(
    companyId,
    `SELECT user_id, user_name, COUNT(*) AS n FROM audit_log
     GROUP BY user_id, user_name ORDER BY n DESC LIMIT 60`);
  return rows
    .filter(r => r.user_name)
    .map(r => ({ id: r.user_id, name: r.user_name as string }));
}
