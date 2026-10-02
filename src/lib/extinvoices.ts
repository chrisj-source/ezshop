import mysql, { RowDataPacket } from 'mysql2/promise';
import { mexec, mq, mqOne } from '../db/master';
import { texec, tq } from '../db/tenant';
import { companyFeatures } from '../middleware/context';
import { seal, unseal } from './secretbox';

/**
 * External invoices (QUEUE, "External invoices", 2 Oct 2026).
 *
 * The shop's own invoicing tool keeps its own database. We read it hourly with
 * a read-only login and keep, per invoice, three facts: generated (the tool's
 * created_at), sent (its sent_at, set by hand in the tool's drawer since
 * migrate-2026-08e) and paid (status = 'paid', dated by its last payment).
 *
 * - Only SELECTs are ever sent. The login should have nothing else, and the
 *   connection is opened read-only as well, so a mistake here cannot write.
 * - One shop's connection reads one company id inside the tool. A location has
 *   its own connection — nothing crosses the group.
 * - The password is sealed and never returned to a screen.
 * - An invoice ties to a file by full VIN, else the last six of its VIN, stock
 *   or number against the RO number (a supplement's "-2" dropped). A manual tie
 *   on the file wins and is never moved by a later read.
 */

export interface SourceInput {
  host?: string; port?: number; dbName?: string; dbUser?: string; password?: string;
  toolCompanyId?: number; useTls?: boolean; enabled?: boolean;
}

export async function sourceSummary(companyId: number) {
  const r = await mqOne<RowDataPacket>('SELECT * FROM company_invoice_sources WHERE company_id = ?', [companyId]);
  if (!r) return { configured: false };
  return {
    configured: true, host: r.host, port: Number(r.port), dbName: r.db_name, dbUser: r.db_user,
    toolCompanyId: Number(r.tool_company_id), useTls: !!Number(r.use_tls), enabled: !!Number(r.enabled),
    lastSyncAt: r.last_sync_at, lastOkAt: r.last_ok_at, lastError: r.last_error, lastCount: r.last_count
  };
}

export async function saveSource(companyId: number, b: SourceInput, by: number): Promise<void> {
  const cur = await mqOne<RowDataPacket>('SELECT password_sealed FROM company_invoice_sources WHERE company_id = ?', [companyId]);
  const host = String(b.host ?? '').trim(), dbName = String(b.dbName ?? '').trim(), dbUser = String(b.dbUser ?? '').trim();
  if (!host || !dbName || !dbUser) throw new Error('Host, database and login are all needed.');
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('That host is not a hostname.');
  const port = Number(b.port ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('That port is not a port.');
  const tco = Number(b.toolCompanyId);
  if (!Number.isInteger(tco) || tco < 1) throw new Error('Give the company number inside the invoicing tool.');
  if (!b.password && !cur) throw new Error('A password is needed the first time.');
  const sealed = b.password ? seal(String(b.password)) : String(cur!.password_sealed);
  await mexec(`
    INSERT INTO company_invoice_sources (company_id, host, port, db_name, db_user, password_sealed, tool_company_id, use_tls, enabled, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE host = VALUES(host), port = VALUES(port), db_name = VALUES(db_name), db_user = VALUES(db_user),
      password_sealed = VALUES(password_sealed), tool_company_id = VALUES(tool_company_id), use_tls = VALUES(use_tls),
      enabled = VALUES(enabled), updated_by = VALUES(updated_by), last_error = NULL`,
    [companyId, host, port, dbName, dbUser, sealed, tco, b.useTls === false ? 0 : 1, b.enabled === false ? 0 : 1, by]);
}

export async function removeSource(companyId: number): Promise<void> {
  await mexec('DELETE FROM company_invoice_sources WHERE company_id = ?', [companyId]);
}

async function connect(companyId: number) {
  const s = await mqOne<RowDataPacket>('SELECT * FROM company_invoice_sources WHERE company_id = ?', [companyId]);
  if (!s) throw new Error('No invoicing database is set for this shop.');
  const c = await mysql.createConnection({
    host: s.host, port: Number(s.port), database: s.db_name, user: s.db_user, password: unseal(s.password_sealed),
    connectTimeout: 10_000, dateStrings: true,
    ssl: Number(s.use_tls) ? { rejectUnauthorized: true } : undefined
  });
  await c.query('SET SESSION TRANSACTION READ ONLY');
  return { c, toolCompanyId: Number(s.tool_company_id) };
}

/** Try the connection and say what it sees, without keeping anything. */
export async function testSource(companyId: number): Promise<{ company: string | null; invoices: number; hasSent: boolean }> {
  const { c, toolCompanyId } = await connect(companyId);
  try {
    const [co] = await c.query<RowDataPacket[]>('SELECT name FROM companies WHERE id = ?', [toolCompanyId]);
    if (!co.length) throw new Error(`The invoicing tool has no company ${toolCompanyId}.`);
    const [n] = await c.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM invoices WHERE company_id = ?', [toolCompanyId]);
    const [col] = await c.query<RowDataPacket[]>(
      "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'sent_at'");
    return { company: String(co[0].name), invoices: Number(n[0].n), hasSent: col.length > 0 };
  } finally { await c.end().catch(() => undefined); }
}

function last6(v: string | null | undefined): string | null {
  const s = String(v ?? '').toUpperCase().replace(/-\d+$/, '').replace(/[^A-Z0-9]/g, '');
  return s.length >= 6 ? s.slice(-6) : null;
}

async function matchRo(companyId: number, inv: { vin: string | null; stock: string | null; number: string }) {
  const vin = String(inv.vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vin.length === 17) {
    const r = await tq<RowDataPacket[]>(companyId, `
      SELECT r.id FROM repair_orders r JOIN vehicles v ON v.id = r.vehicle_id
       WHERE v.vin = ? AND r.voided_at IS NULL ORDER BY r.opened_at DESC LIMIT 1`, [vin]);
    if (r.length) return { roId: Number(r[0].id), how: 'vin' };
  }
  for (const k of [last6(vin), last6(inv.stock), last6(inv.number)]) {
    if (!k) continue;
    const r = await tq<RowDataPacket[]>(companyId,
      'SELECT id FROM repair_orders WHERE ro_number = ? AND voided_at IS NULL ORDER BY opened_at DESC LIMIT 1', [k]);
    if (r.length) return { roId: Number(r[0].id), how: 'ro' };
  }
  return { roId: null, how: null };
}

/** One read. Every invoice the tool changed since the last good read, plus a margin. */
export async function syncInvoices(companyId: number): Promise<{ read: number; matched: number }> {
  const src = await mqOne<RowDataPacket>('SELECT last_ok_at FROM company_invoice_sources WHERE company_id = ?', [companyId]);
  await mexec('UPDATE company_invoice_sources SET last_sync_at = NOW() WHERE company_id = ?', [companyId]);
  let rows: RowDataPacket[] = [];
  try {
    const { c, toolCompanyId } = await connect(companyId);
    try {
      /* updated_at moves on every status, sent and revision write in the tool.
         Two days of margin covers clock drift between the two servers. */
      const since = src?.last_ok_at ? 'AND i.updated_at >= DATE_SUB(?, INTERVAL 2 DAY)' : '';
      const [r] = await c.query<RowDataPacket[]>(`
        SELECT i.id, i.number, i.vin, i.stock, i.vehicle, i.invoice_date, i.due_date, i.status,
               i.total_cents, i.created_at, i.sent_at,
               COALESCE(NULLIF(cl.name, ''), i.customer) AS client_name, p.name AS profile,
               (SELECT MAX(received_at) FROM payments pm WHERE pm.invoice_id = i.id) AS paid_at,
               (SELECT COALESCE(SUM(amount_cents), 0) FROM payments pm WHERE pm.invoice_id = i.id) AS paid_cents
          FROM invoices i
          LEFT JOIN clients cl ON cl.id = i.client_id
          LEFT JOIN profiles p ON p.id = i.profile_id
         WHERE i.company_id = ? ${since}`,
        src?.last_ok_at ? [toolCompanyId, src.last_ok_at] : [toolCompanyId]);
      rows = r;
    } finally { await c.end().catch(() => undefined); }
  } catch (e) {
    await mexec('UPDATE company_invoice_sources SET last_error = ? WHERE company_id = ?',
      [String((e as Error).message).slice(0, 255), companyId]);
    throw e;
  }

  let matched = 0;
  for (const r of rows) {
    const prev = await tq<RowDataPacket[]>(companyId, 'SELECT ro_id, match_how FROM external_invoices WHERE ext_id = ?', [r.id]);
    let roId = prev[0]?.ro_id ?? null, how = prev[0]?.match_how ?? null;
    if (how !== 'manual') {
      const m = await matchRo(companyId, { vin: r.vin, stock: r.stock, number: String(r.number) });
      roId = m.roId; how = m.how;
    }
    if (roId) matched++;
    await texec(companyId, `
      INSERT INTO external_invoices (ext_id, number, profile, client_name, vehicle, vin, stock, invoice_date, due_date,
        total_cents, paid_cents, status, generated_at, sent_at, paid_at, ro_id, match_how, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE number = VALUES(number), profile = VALUES(profile), client_name = VALUES(client_name),
        vehicle = VALUES(vehicle), vin = VALUES(vin), stock = VALUES(stock), invoice_date = VALUES(invoice_date),
        due_date = VALUES(due_date), total_cents = VALUES(total_cents), paid_cents = VALUES(paid_cents),
        status = VALUES(status), generated_at = VALUES(generated_at), sent_at = VALUES(sent_at),
        paid_at = VALUES(paid_at), ro_id = VALUES(ro_id), match_how = VALUES(match_how), synced_at = NOW()`,
      [r.id, String(r.number).slice(0, 32), r.profile ?? null, r.client_name ? String(r.client_name).slice(0, 160) : null,
       r.vehicle ? String(r.vehicle).slice(0, 160) : null, r.vin || null, r.stock || null,
       r.invoice_date || null, r.due_date || null, Number(r.total_cents ?? 0), Number(r.paid_cents ?? 0),
       String(r.status ?? 'open'), r.created_at || null, r.sent_at || null,
       String(r.status) === 'paid' ? (r.paid_at || null) : null, roId, how]);
  }
  await mexec('UPDATE company_invoice_sources SET last_ok_at = NOW(), last_error = NULL, last_count = ? WHERE company_id = ?',
    [rows.length, companyId]);
  return { read: rows.length, matched };
}

export type Stage = 'generated' | 'sent' | 'paid' | 'void';

export function stageOf(r: { status: string; sent_at: unknown }): Stage {
  if (r.status === 'void') return 'void';
  if (r.status === 'paid') return 'paid';
  return r.sent_at ? 'sent' : 'generated';
}

/**
 * The file's invoice stage, for the board and closed files: the least-advanced
 * live invoice on it, so one unpaid supplement keeps the file unpaid.
 */
export async function stagesFor(companyId: number, roIds: number[]): Promise<Map<number, { stage: Stage; count: number }>> {
  const out = new Map<number, { stage: Stage; count: number }>();
  if (!roIds.length) return out;
  const rows = await tq<RowDataPacket[]>(companyId,
    `SELECT ro_id, status, sent_at FROM external_invoices WHERE ro_id IN (?) AND status <> 'void'`, [roIds]).catch(() => []);
  const rank: Record<Stage, number> = { generated: 0, sent: 1, paid: 2, void: 3 };
  for (const r of rows) {
    const id = Number(r.ro_id), s = stageOf(r as never), cur = out.get(id);
    if (!cur) out.set(id, { stage: s, count: 1 });
    else out.set(id, { stage: rank[s] < rank[cur.stage] ? s : cur.stage, count: cur.count + 1 });
  }
  return out;
}

export async function invoicesForRo(companyId: number, roId: number) {
  return tq<RowDataPacket[]>(companyId, `
    SELECT ext_id, number, profile, client_name, invoice_date, due_date, total_cents, paid_cents, status,
           generated_at, sent_at, paid_at, match_how, synced_at
      FROM external_invoices WHERE ro_id = ? ORDER BY invoice_date, ext_id`, [roId]).catch(() => []);
}

/** Hourly, every shop that has the feature on and a connection set. */
export function startInvoiceSync(log: { error: (o: unknown, m: string) => void }): void {
  const tick = async (): Promise<void> => {
    const shops = await mq<RowDataPacket[]>('SELECT company_id FROM company_invoice_sources WHERE enabled = 1').catch(() => []);
    for (const s of shops) {
      const id = Number(s.company_id);
      if (!(await companyFeatures(id)).includes('extinv')) continue;
      await syncInvoices(id).catch(err => log.error({ err, companyId: id }, 'invoice sync'));
    }
  };
  const t = setInterval(() => { void tick(); }, 60 * 60 * 1000);
  t.unref();
  const soon = setTimeout(() => { void tick(); }, 3 * 60 * 1000);
  soon.unref();
}
