import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { absolutePath, writeBuffer } from './storage';

/**
 * Making pictures out of things.
 *
 * Three outside tools, all optional — the app runs without them and simply
 * leaves a glyph where a thumbnail would be:
 *
 *   sharp          resizing and JPEG encoding (an npm dependency, prebuilt)
 *   heif-convert   HEIC to JPEG            (Debian: libheif-examples)
 *   mutool         PDF page to PNG         (Debian: mupdf-tools)
 *
 * INSTALL-MEDIA.md has the commands. Everything here reports what it can do so
 * Admin can tell the owner what is missing rather than failing quietly.
 */

const THUMB_EDGE = 400;
const FULL_EDGE = 2048;
const PAGE_EDGE = 1600;

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd}: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}

/* ------------------------------------------------------------------ sharp */

type SharpModule = typeof import('sharp');
let sharpMod: SharpModule | null | undefined;

/** Loaded lazily so a box without sharp still starts. */
async function sharp(): Promise<SharpModule | null> {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = (await import('sharp')).default as unknown as SharpModule;
  } catch {
    sharpMod = null;
  }
  return sharpMod;
}

async function haveCommand(cmd: string): Promise<boolean> {
  try { await run('which', [cmd], 4000); return true; } catch { return false; }
}

export interface MediaTools {
  sharp: boolean;
  heifConvert: boolean;
  mutool: boolean;
}

let toolCache: MediaTools | null = null;

/** What this box can actually do. Cached — Admin reads it, jobs trust it. */
export async function mediaTools(force = false): Promise<MediaTools> {
  if (toolCache && !force) return toolCache;
  toolCache = {
    sharp: !!(await sharp()),
    heifConvert: await haveCommand('heif-convert'),
    mutool: await haveCommand('mutool')
  };
  return toolCache;
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'easyshop-'));
}

/* ------------------------------------------------------------------ images */

export interface Sized { key: string; bytes: number; width: number; height: number }

/**
 * Resize a stored image into a new stored JPEG. `edge` is the long edge; an
 * image already smaller is left at its own size rather than blown up.
 */
export async function resizeToKey(
  sourceKey: string, destKey: string, edge: number, quality: number
): Promise<Sized> {
  const s = await sharp();
  if (!s) throw new Error('sharp is not installed');
  const out = await s(absolutePath(sourceKey))
    .rotate()                             // honour the EXIF the camera wrote
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const bytes = await writeBuffer(destKey, out.data);
  return { key: destKey, bytes, width: out.info.width, height: out.info.height };
}

/** HEIC in, JPEG buffer out. Straight to sharp if it was built with HEIF. */
export async function heicToJpeg(sourceKey: string): Promise<Buffer> {
  const s = await sharp();
  if (s) {
    try {
      return await s(absolutePath(sourceKey)).rotate().jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    } catch {
      /* The prebuilt sharp has no HEIF decoder; fall through to heif-convert. */
    }
  }
  const dir = await tempDir();
  try {
    const out = path.join(dir, 'out.jpg');
    await run('heif-convert', ['-q', '88', absolutePath(sourceKey), out], 60_000);
    return await fsp.readFile(out);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export async function imageSize(key: string): Promise<{ width: number; height: number } | null> {
  const s = await sharp();
  if (!s) return null;
  try {
    const m = await s(absolutePath(key)).metadata();
    return m.width && m.height ? { width: m.width, height: m.height } : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- PDFs */

export async function pdfPageCount(key: string): Promise<number | null> {
  try {
    const out = await run('mutool', ['info', absolutePath(key)], 20_000);
    const m = out.match(/Pages:\s*(\d+)/i);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Render one page of a PDF to a stored JPEG. Rendered wide enough to read an
 * insurer estimate on a laptop, then encoded small enough to send over shop
 * wifi.
 */
export async function renderPdfPage(
  sourceKey: string, pageNo: number, destKey: string, edge = PAGE_EDGE
): Promise<Sized> {
  const s = await sharp();
  if (!s) throw new Error('sharp is not installed');
  const dir = await tempDir();
  try {
    const png = path.join(dir, `p-${crypto.randomBytes(4).toString('hex')}.png`);
    // -r 150 is enough for body text; -w caps the long edge so a poster-size
    // page does not turn into a 40 MB bitmap.
    await run('mutool', [
      'draw', '-r', '150', '-w', String(edge), '-o', png,
      absolutePath(sourceKey), String(pageNo)
    ], 60_000);
    const out = await s(png)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const bytes = await writeBuffer(destKey, out.data);
    return { key: destKey, bytes, width: out.info.width, height: out.info.height };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export const EDGES = { thumb: THUMB_EDGE, full: FULL_EDGE, page: PAGE_EDGE };
