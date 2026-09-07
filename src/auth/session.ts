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
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

export function newSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * An IP as bytes: 4 for v4, 16 for v6.
 *
 * The old version stripped the colons and right-padded, which is wrong for
 * every v6 address that is not already fully written out — `2001:db8::1`
 * became `2001:0db8:0001:...` with the 1 in the wrong group. Since `::` stands
 * for an arbitrary run of zero groups, the elision has to be expanded, not
 * padded over. A wrong address in a session record is worse than none: it is
 * evidence that points somewhere else.
 */
function ipToBuffer(ip?: string): Buffer | null {
  if (!ip) return null;
  const clean = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean.replace(/^::ffff:/i, ''));
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some(n => n > 255)) return null;
    return Buffer.from(octets);
  }
  if (!clean.includes(':')) return null;

  const [head, tail] = clean.split('::');
  if (clean.split('::').length > 2) return null;
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];
  const fill = 8 - (left.length + right.length);
  if (fill < 0 || (tail === undefined && fill !== 0)) return null;

  const groups = [...left, ...Array(tail === undefined ? 0 : fill).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i], 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    buf.writeUInt16BE(n, i * 2);
  }
  return buf;
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
     WHERE id = ? AND revoked_at IS NULL AND expires_at > NOW()
       AND (last_seen_at IS NULL OR last_seen_at > DATE_SUB(NOW(), INTERVAL ? DAY))`,
    [id, config.sessionIdleDays]
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
