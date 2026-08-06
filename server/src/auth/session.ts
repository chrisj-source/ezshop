import crypto from 'node:crypto';
import { RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { mexec, mqOne } from '../db/master';

export interface SessionRow extends RowDataPacket {
  id: string;
  user_id: number;
  company_id: number | null;
  impersonating: number;
  expires_at: Date;
  revoked_at: Date | null;
}

export function newSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function ipToBuffer(ip?: string): Buffer | null {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, '');
  const parts = clean.split('.');
  if (parts.length === 4) return Buffer.from(parts.map(Number));
  try { return Buffer.from(clean.replace(/:/g, '').padEnd(32, '0').slice(0, 32), 'hex'); }
  catch { return null; }
}

export async function createSession(
  userId: number,
  companyId: number | null,
  meta: { ip?: string; userAgent?: string; impersonating?: boolean }
): Promise<string> {
  const id = newSessionId();
  await mexec(
    `INSERT INTO sessions (id, user_id, company_id, impersonating, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [id, userId, companyId, meta.impersonating ? 1 : 0, ipToBuffer(meta.ip),
     (meta.userAgent ?? '').slice(0, 255), config.sessionDays]
  );
  await mexec('UPDATE users SET last_login_at = NOW(), failed_logins = 0 WHERE id = ?', [userId]);
  return id;
}

export async function loadSession(id: string): Promise<SessionRow | null> {
  if (!id || id.length !== 43) return null;
  const row = await mqOne<SessionRow>(
    `SELECT * FROM sessions
     WHERE id = ? AND revoked_at IS NULL AND expires_at > NOW()`,
    [id]
  );
  if (row) void mexec('UPDATE sessions SET last_seen_at = NOW() WHERE id = ?', [id]).catch(() => {});
  return row;
}

export async function revokeSession(id: string): Promise<void> {
  await mexec('UPDATE sessions SET revoked_at = NOW() WHERE id = ?', [id]);
}

export async function revokeAllForUser(userId: number): Promise<void> {
  await mexec('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

/** Called when a company is switched off — everyone at that shop is signed out. */
export async function revokeAllForCompany(companyId: number): Promise<void> {
  await mexec('UPDATE sessions SET revoked_at = NOW() WHERE company_id = ? AND revoked_at IS NULL', [companyId]);
}

export async function switchSessionCompany(id: string, companyId: number, impersonating: boolean): Promise<void> {
  await mexec('UPDATE sessions SET company_id = ?, impersonating = ? WHERE id = ?',
    [companyId, impersonating ? 1 : 0, id]);
}

export async function purgeExpiredSessions(): Promise<number> {
  const r = await mexec('DELETE FROM sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)');
  return r.affectedRows;
}
