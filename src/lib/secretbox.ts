import crypto from 'node:crypto';
import { config } from '../config';

/**
 * Sealing for credentials a shop hands us. AES-256-GCM under CREDENTIALS_KEY.
 * Format: v1.<iv>.<tag>.<ciphertext>, each base64url.
 */
function key(): Buffer {
  const k = config.credentialsKey;
  if (!k) {
    throw new Error('CREDENTIALS_KEY is not set, so shop credentials cannot be stored or read. ' +
      "Generate one with node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\", " +
      'put it in /srv/easyshop/.env, keep a copy in the password manager, and restart.');
  }
  const b = Buffer.from(k, 'base64url');
  if (b.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64url.');
  return b;
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), enc].map(x => typeof x === 'string' ? x : x.toString('base64url')).join('.');
}

export function unseal(sealed: string): string {
  const [v, iv, tag, enc] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Unreadable sealed value.');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}
