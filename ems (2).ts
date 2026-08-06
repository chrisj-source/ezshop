import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config';

/**
 * Files live on disk under STORAGE_DIR/<companyId>/<yyyy-mm>/<random>.<ext>.
 * The database holds the key; nothing is served by path from the client.
 */

const SAFE_EXT = /^[a-z0-9]{1,8}$/;

export function extensionOf(filename: string, mime?: string): string {
  const raw = path.extname(filename ?? '').replace('.', '').toLowerCase();
  if (SAFE_EXT.test(raw)) return raw;
  const fromMime: Record<string, string> = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
    'image/heic': 'heic', 'image/webp': 'webp', 'text/plain': 'txt',
    'application/vnd.ms-excel': 'xls', 'text/csv': 'csv'
  };
  return fromMime[mime ?? ''] ?? 'bin';
}

export function storageKey(companyId: number, ext: string): string {
  const month = new Date().toISOString().slice(0, 7);
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  return path.posix.join(String(companyId), month, name);
}

export function absolutePath(key: string): string {
  const resolved = path.resolve(config.storageDir, key);
  const root = path.resolve(config.storageDir);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Bad storage key');
  return resolved;
}

export async function writeStream(key: string, stream: NodeJS.ReadableStream): Promise<number> {
  const abs = absolutePath(key);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(abs);
    stream.on('data', (c: Buffer) => { bytes += c.length; });
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    stream.pipe(out);
  });
  return bytes;
}

export async function writeBuffer(key: string, buf: Buffer): Promise<number> {
  const abs = absolutePath(key);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, buf);
  return buf.length;
}

export function readStream(key: string): fs.ReadStream {
  return fs.createReadStream(absolutePath(key));
}

export async function removeFile(key: string): Promise<void> {
  await fsp.unlink(absolutePath(key)).catch(() => {});
}

export async function fileExists(key: string): Promise<boolean> {
  try { await fsp.access(absolutePath(key)); return true; } catch { return false; }
}

/** Document types the drawer offers, and which are money documents. */
export const DOC_TYPES: Array<{ key: string; label: string; money: boolean }> = [
  { key: 'estimate', label: 'Estimate', money: true },
  { key: 'supplement', label: 'Supplement', money: true },
  { key: 'final_bill', label: 'Final bill', money: true },
  { key: 'invoice', label: 'Invoice', money: true },
  { key: 'parts_invoice', label: 'Parts invoice', money: true },
  { key: 'sublet_invoice', label: 'Sublet invoice', money: true },
  { key: 'authorization', label: 'Authorization', money: false },
  { key: 'photos_intake', label: 'Intake photos', money: false },
  { key: 'photos_teardown', label: 'Teardown photos', money: false },
  { key: 'photos_progress', label: 'Progress photos', money: false },
  { key: 'photos_final', label: 'Final photos', money: false },
  { key: 'scan_report', label: 'Scan / calibration report', money: false },
  { key: 'alignment', label: 'Alignment sheet', money: false },
  { key: 'paint_formula', label: 'Paint formula', money: false },
  { key: 'insurance_letter', label: 'Insurance correspondence', money: false },
  { key: 'other', label: 'Other', money: false }
];

export function isMoneyDoc(type: string): boolean {
  return DOC_TYPES.find(d => d.key === type)?.money ?? false;
}
