import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { config } from '../config';

let pool: Pool | null = null;

export function master(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.masterDb,
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 4,
      idleTimeout: 60_000,
      enableKeepAlive: true,
      namedPlaceholders: true,
      timezone: 'Z',
      dateStrings: false
    });
  }
  return pool;
}

/** An admin connection with no database selected — used to CREATE DATABASE. */
export async function adminConnection(): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true
  });
}

export async function mq<T extends RowDataPacket[]>(sql: string, params?: unknown): Promise<T> {
  const [rows] = await master().query<T>(sql, params as never);
  return rows;
}

export async function mqOne<T extends RowDataPacket>(sql: string, params?: unknown): Promise<T | null> {
  const rows = await mq<T[]>(sql, params);
  return rows[0] ?? null;
}

export async function mexec(sql: string, params?: unknown): Promise<ResultSetHeader> {
  const [res] = await master().query<ResultSetHeader>(sql, params as never);
  return res;
}

export async function withMasterTx<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const c = await master().getConnection();
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

export async function closeMaster(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
