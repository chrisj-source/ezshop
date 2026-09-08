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

/**
 * A folder for a set of files that belong together (an EMS import is 15-20
 * files). The database stores this one short key, not a list of file keys —
 * joining twenty keys into a VARCHAR is how the EMS upload used to fail.
 */
export function storagePrefix(companyId: number, kind: string): string {
  const month = new Date().toISOString().slice(0, 7);
  return path.posix.join(String(companyId), month, kind, crypto.randomBytes(8).toString('hex'));
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

/**
 * What a shop is allowed to upload, and what the server will serve back inline.
 *
 * These are two different questions and conflating them was a real hole: the
 * download route used to echo the uploader's own content-type with
 * `disposition: inline`, so an .html or .svg file uploaded as a "photo" ran as
 * script on the app's own origin, with the session cookie attached. nosniff
 * does not help — the type was declared, not sniffed.
 *
 * So: an allowlist at the door, and a second, narrower list of types that may
 * ever be rendered in the browser. Anything already on disk from before this
 * rule still comes back, as an attachment, as octet-stream.
 */
export const ALLOWED_EXT = new Set([
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'pdf'
]);

/**
 * Rendered in the browser. Deliberately short: no svg, no html, no xml.
 *
 * HEIC is accepted but not previewable — no browser renders it. The viewer
 * shows its JPEG thumbnail, which is what it already did.
 */
const PREVIEWABLE = new Map<string, string>([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
  ['gif', 'image/gif'], ['pdf', 'application/pdf']
]);

/**
 * Estimate file sets arrive through the EMS route, not as documents, and the two
 * are not the same question.
 *
 * The document allowlist above exists because those files come back out of the
 * server and into a browser. Estimate files never do: they are parsed on arrival
 * and read off disk by the parser alone, so there is no inline-render path to
 * defend.
 *
 * An allowlist was the wrong shape here regardless of length. A real Audatex set
 * is `.AD1 .AD2 .DBT .ENV .LIN .PFH .PFL .PFM .PFO .PFP .PFT .STL .TTL .VEH
 * .VEN`; CCC and Mitchell each emit their own, supplements bump the digits, and
 * the writers add files between releases. Every fixed list falls behind the next
 * estimating-system update and the shop is the one who finds out, mid-import.
 *
 * So the rule is inverted: take the set, and refuse only what a browser could be
 * made to execute if it ever did get served. That list is short and it does not
 * grow. `extensionOf` has already forced lowercase alphanumeric and a maximum of
 * eight characters before anything reaches here.
 */
const EMS_EXT_DENIED = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'js', 'mjs', 'jsx',
  'php', 'phtml', 'asp', 'aspx', 'jsp', 'cgi', 'pl', 'py', 'rb', 'sh',
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'ps1', 'vbs', 'jar', 'hta'
]);

export function emsExtAllowed(ext: string): boolean {
  const e = (ext ?? '').toLowerCase();
  return e.length > 0 && !EMS_EXT_DENIED.has(e);
}

export function extAllowed(ext: string): boolean {
  return ALLOWED_EXT.has((ext ?? '').toLowerCase());
}

/**
 * The content-type and disposition to answer with — derived from the extension
 * this server assigned at upload, never from what the client claimed.
 */
export function serveAs(ext: string, wantDownload: boolean): { type: string; disposition: 'inline' | 'attachment' } {
  const safe = PREVIEWABLE.get((ext ?? '').toLowerCase());
  if (!safe) return { type: 'application/octet-stream', disposition: 'attachment' };
  return { type: safe, disposition: wantDownload ? 'attachment' : 'inline' };
}

/** The extension we stored, read back off the storage key. */
export function extOfKey(key: string): string {
  return path.extname(key ?? '').replace('.', '').toLowerCase();
}
