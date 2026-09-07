/**
 * dBase III DBF reader — enough of the format for CCC, Mitchell and Audatex
 * EMS exports. Every file in the set is a DBF table; one reader handles all of
 * them, so there is no per-file parser to maintain.
 *
 * Layout: 32-byte header, 32-byte field descriptors, 0x0D terminator, then
 * fixed-width latin1 records each prefixed by a deletion flag. `M` fields hold
 * a block number pointing into the sibling .dbt memo file.
 */

export interface DbfField {
  name: string;
  type: string;
  length: number;
  decimals: number;
  offset: number;
}

export type DbfRow = Record<string, string | number | boolean | null>;

export interface DbfTable {
  fields: DbfField[];
  rows: DbfRow[];
  recordCount: number;
}

const DELETED = 0x2a;

export function readDbf(buf: Buffer, memo?: Buffer | null): DbfTable {
  if (buf.length < 32) throw new Error('Not a DBF file — too short.');

  const recordCount = buf.readUInt32LE(4);
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);

  if (headerLength < 33 || recordLength < 1 || headerLength > buf.length) {
    throw new Error('Not a DBF file — header does not make sense.');
  }

  const fields: DbfField[] = [];
  let offset = 1; // past the deletion flag
  for (let p = 32; p < headerLength - 1; p += 32) {
    if (buf[p] === 0x0d) break;
    const name = buf.subarray(p, p + 11).toString('latin1').replace(/\0.*$/, '').trim().toUpperCase();
    if (!name) break;
    const type = String.fromCharCode(buf[p + 11]).toUpperCase();
    const length = buf[p + 16];
    const decimals = buf[p + 17];
    fields.push({ name, type, length, decimals, offset });
    offset += length;
  }

  if (!fields.length) throw new Error('DBF has no fields.');

  const rows: DbfRow[] = [];
  const start = headerLength;
  const max = Math.min(recordCount, Math.floor((buf.length - start) / recordLength));

  for (let i = 0; i < max; i++) {
    const base = start + i * recordLength;
    if (buf[base] === DELETED) continue;

    const row: DbfRow = {};
    let empty = true;

    for (const f of fields) {
      const raw = buf.subarray(base + f.offset, base + f.offset + f.length).toString('latin1');
      const text = raw.replace(/\0/g, '').trim();
      if (text) empty = false;

      switch (f.type) {
        case 'N':
        case 'F': {
          if (!text) { row[f.name] = null; break; }
          const n = Number(text.replace(/,/g, ''));
          row[f.name] = isNaN(n) ? null : n;
          break;
        }
        case 'L':
          row[f.name] = /^[YT]$/i.test(text) ? true : /^[NF]$/i.test(text) ? false : null;
          break;
        case 'D':
          // stored YYYYMMDD
          row[f.name] = /^\d{8}$/.test(text)
            ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
            : (text || null);
          break;
        case 'M': {
          const block = Number(text);
          row[f.name] = memo && block > 0 ? readMemo(memo, block) : null;
          break;
        }
        default:
          row[f.name] = text || null;
      }
    }

    if (!empty) rows.push(row);
  }

  return { fields, rows, recordCount };
}

/** dBase memo: fixed-size blocks; dBase IV prefixes each with FF FF 08 00 + length. */
function readMemo(dbt: Buffer, block: number): string | null {
  const blockSize = dbt.length > 22 ? (dbt.readUInt16LE(20) || 512) : 512;
  const start = block * blockSize;
  if (start >= dbt.length) return null;

  let from = start;
  let end = dbt.length;
  if (dbt[start] === 0xff && dbt[start + 1] === 0xff) {
    const len = dbt.readUInt32LE(start + 4);
    from = start + 8;
    if (len > 8 && start + len <= dbt.length) end = start + len;
  }
  for (let i = from; i < end - 1; i++) {
    if (dbt[i] === 0x1a && dbt[i + 1] === 0x1a) { end = i; break; }
  }

  const text = dbt.subarray(from, end).toString('latin1').replace(/\r/g, '\n').trim();
  return text || null;
}

/**
 * Field names drift between estimating systems and versions, so every read
 * goes through a candidate list rather than a hard-coded name. Tries exact
 * match, then prefix, then "contains".
 *
 * `want` keeps the fuzzy passes honest: CCC's .lin table pairs LBR_OP with a
 * logical LBR_OP_J, and a prefix match would otherwise hand back `false`.
 */
export function pick(
  row: DbfRow | undefined,
  names: string[],
  want?: 'string' | 'number'
): string | number | boolean | null {
  if (!row) return null;
  const keys = Object.keys(row);

  const ok = (v: unknown): boolean => {
    if (v === undefined || v === null || v === '') return false;
    if (!want) return true;
    if (typeof v === 'boolean') return false;
    if (want === 'number') return typeof v === 'number' ||
      !isNaN(Number(String(v).replace(/[$,]/g, '')));
    return true;
  };

  for (const want_ of names) {
    const w = want_.toUpperCase();
    if (ok(row[w])) return row[w];
  }
  for (const want_ of names) {
    const w = want_.toUpperCase();
    const hit = keys.find(k => k.startsWith(w) && ok(row[k]));
    if (hit) return row[hit];
  }
  for (const want_ of names) {
    const w = want_.toUpperCase();
    const hit = keys.find(k => k.includes(w) && ok(row[k]));
    if (hit) return row[hit];
  }
  return null;
}

export function pickStr(row: DbfRow | undefined, names: string[]): string | null {
  const v = pick(row, names, 'string');
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

export function pickNum(row: DbfRow | undefined, names: string[]): number | null {
  const v = pick(row, names, 'number');
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

export function pickBool(row: DbfRow | undefined, names: string[]): boolean {
  const v = pick(row, names);
  if (typeof v === 'boolean') return v;
  return /^[YT1]/i.test(String(v ?? ''));
}

export function looksLikeDbf(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  const version = buf[0] & 0x07;
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);
  return (version === 3 || version === 4 || version === 5) &&
    headerLength >= 33 && headerLength < buf.length && recordLength > 0;
}
