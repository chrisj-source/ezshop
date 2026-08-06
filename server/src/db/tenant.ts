import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { config } from '../config';
import { mqOne } from './master';

export interface TenantLocation extends RowDataPacket {
  company_id: number;
  db_host: string;
  db_port: number;
  db_name: string;
  db_user: string;
  secret_ref: string;
  read_only: number;
}

interface Entry { pool: Pool; lastUsed: number; }

const pools = new Map<number, Entry>();
const IDLE_MS = 15 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

/**
 * One pool per shop, created on first use and dropped after 15 idle minutes.
 * Small per-tenant limits on purpose — a hundred shops each holding ten
 * connections would exhaust MariaDB long before the app felt busy.
 */
export async function tenantPool(companyId: number): Promise<Pool> {
  const hit = pools.get(companyId);
  if (hit) { hit.lastUsed = Date.now(); return hit.pool; }

  const loc = await mqOne<TenantLocation>(
    'SELECT * FROM company_databases WHERE company_id = ?', [companyId]
  );
  if (!loc) throw new Error(`Company ${companyId} has no database provisioned`);

  const pool = mysql.createPool({
    host: loc.db_host,
    port: loc.db_port,
    user: loc.db_user,
    password: config.tenantSecret(loc.secret_ref),
    database: loc.db_name,
    waitForConnections: true,
    connectionLimit: 6,
    maxIdle: 2,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    namedPlaceholders: true,
    timezone: 'Z'
  });

  pools.set(companyId, { pool, lastUsed: Date.now() });
  return pool;
}

export function forgetTenant(companyId: number): void {
  const hit = pools.get(companyId);
  if (hit) { void hit.pool.end().catch(() => {}); pools.delete(companyId); }
}

const sweeper = setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, e] of pools) {
    if (e.lastUsed < cutoff) { void e.pool.end().catch(() => {}); pools.delete(id); }
  }
}, SWEEP_MS);
sweeper.unref();

export async function tq<T extends RowDataPacket[]>(companyId: number, sql: string, params?: unknown): Promise<T> {
  const p = await tenantPool(companyId);
  const [rows] = await p.query<T>(sql, params as never);
  return rows;
}

export async function tqOne<T extends RowDataPacket>(companyId: number, sql: string, params?: unknown): Promise<T | null> {
  const rows = await tq<T[]>(companyId, sql, params);
  return rows[0] ?? null;
}

export async function texec(companyId: number, sql: string, params?: unknown): Promise<ResultSetHeader> {
  const p = await tenantPool(companyId);
  const [res] = await p.query<ResultSetHeader>(sql, params as never);
  return res;
}

export async function withTenantTx<T>(companyId: number, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const p = await tenantPool(companyId);
  const c = await p.getConnection();
  try {
    await c.beginTransaction();
    const out = await fn(c);
    await c.commit();
    return out;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}

export async function closeAllTenants(): Promise<void> {
  for (const [, e] of pools) await e.pool.end().catch(() => {});
  pools.clear();
}
