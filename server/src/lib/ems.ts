import { DbfRow, looksLikeDbf, pickBool, pickNum, pickStr, readDbf } from './dbf';

/**
 * Turn a CCC / Mitchell / Audatex EMS file set into one structured estimate.
 *
 * Field names are looked up through candidate lists (see dbf.pick) because they
 * differ between systems and EMS versions. Everything is optional — a set with
 * only an envelope and a vehicle still imports.
 */

export interface EmsLine {
  lineNo: number | null;
  operation: string | null;
  description: string | null;
  partNumber: string | null;
  partType: string | null;
  qty: number;
  priceCents: number;
  laborHours: number | null;
  laborType: string | null;
  isSublet: boolean;
  subletAmountCents: number;
}

export interface EmsEstimate {
  estimatingSystem: string | null;
  envelopeName: string | null;
  roNumber: string | null;
  supplementNo: string | null;
  supplementSeq: number | null;
  createdAt: string | null;
  emsVersion: string | null;

  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  bodyStyle: string | null;
  engine: string | null;
  mileage: number | null;
  color: string | null;
  paintCode: string | null;
  plate: string | null;
  plateState: string | null;

  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  customerCity: string | null;
  customerState: string | null;
  customerZip: string | null;

  insurer: string | null;
  policyNumber: string | null;
  claimNumber: string | null;
  deductibleCents: number | null;
  deductibleWaived: boolean;
  dateOfLoss: string | null;
  catCode: string | null;
  adjuster: string | null;
  estimator: string | null;

  grossCents: number | null;
  netCents: number | null;
  previousNetCents: number | null;
  supplementCents: number | null;
  taxCents: number | null;
  customerPayCents: number | null;

  laborHoursTotal: number | null;
  laborByType: Array<{ type: string; label: string; hours: number | null; amountCents: number | null }>;
  partsByType: Array<{ type: string; label: string; amountCents: number }>;

  lines: EmsLine[];
  vendors: Array<{ name: string; phone: string | null; kind: string | null }>;
  damageMemo: string | null;

  warnings: string[];
}

export const LABOR_TYPES: Record<string, string> = {
  LAB: 'Body', LAR: 'Paint', LAM: 'Mechanical', LAF: 'Frame', LAS: 'Structural',
  LAD: 'Diagnostic', LAE: 'Electrical', LAG: 'Glass', LAU: 'PDR',
  LA1: 'Aluminum', LA2: 'Aluminum structural', LAT: 'Total'
};

export const PART_TYPES: Record<string, string> = {
  PAO: 'OEM', PAA: 'Aftermarket', PAN: 'New', PAL: 'LKQ / used', PAG: 'Glass',
  PAS: 'Sublet', PAR: 'Remanufactured', PAT: 'Total'
};

/** EMS part type code -> our parts_lines.part_type enum. */
export function partTypeToEnum(code: string | null): string | null {
  switch ((code ?? '').toUpperCase()) {
    case 'PAO': return 'oem';
    case 'PAA': return 'aftermarket';
    case 'PAL': return 'used';
    case 'PAR': return 'reconditioned';
    case 'PAN': return 'oem';
    default: return null;
  }
}

const SYSTEM_NAME: Record<string, string> = {
  C: 'ccc', M: 'mitchell', A: 'audatex', E: 'audatex', U: 'ccc'
};

export type FileSet = Map<string, Buffer>;

/** Files in an estimate folder that are not EMS tables. */
const NOT_A_TABLE = new Set(['lock', 'log', 'bak', 'tmp', 'ini', 'db']);

/** Group uploaded files by their EMS extension, ignoring byte-identical copies. */
export function groupSet(files: Array<{ filename: string; buffer: Buffer }>): {
  set: FileSet; envelopeName: string | null; skipped: string[];
} {
  const set: FileSet = new Map();
  const bases = new Map<string, string>();
  const skipped: string[] = [];
  let envelopeName: string | null = null;
  let firstBase: string | null = null;

  for (const f of files) {
    const m = /^(.*?)(?:-[0-9a-f]{4,})?\.([a-z0-9]{2,4})$/i.exec(f.filename.trim());
    if (!m) { skipped.push(f.filename); continue; }

    const base = m[1];
    const ext = m[2].toLowerCase();

    // CCC leaves a lock file in the export folder; it is not a table.
    if (NOT_A_TABLE.has(ext)) continue;

    if (ext === 'env') envelopeName = base;
    if (!firstBase) firstBase = base;

    if (set.has(ext)) {
      // A second copy of the same table under a -hash name is CCC's own
      // duplicate and expected. A different estimate's table is not.
      if (bases.get(ext) !== base) skipped.push(f.filename);
      continue;
    }
    set.set(ext, f.buffer);
    bases.set(ext, base);
  }

  return { set, envelopeName: envelopeName ?? firstBase, skipped };
}

function table(set: FileSet, ext: string, warnings: string[]): DbfRow[] {
  const buf = set.get(ext);
  if (!buf) return [];
  if (!looksLikeDbf(buf)) {
    warnings.push(`.${ext} is not a readable DBF table — skipped.`);
    return [];
  }
  try {
    return readDbf(buf, set.get('dbt') ?? null).rows;
  } catch (e) {
    warnings.push(`.${ext} could not be read: ${(e as Error).message}`);
    return [];
  }
}

const cents = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 100);

/** Two of these are often null; the sum is null only when both are. */
function sumCents(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return Math.round(((a ?? 0) + (b ?? 0)) * 100);
}

/** CCC writes the model year two digits wide. */
function modelYear(v: string | null): number | null {
  const n = Number((v ?? '').trim());
  if (!n || isNaN(n)) return null;
  if (n >= 1900) return n;
  return n < 60 ? 2000 + n : 1900 + n;
}

export function parseEms(files: Array<{ filename: string; buffer: Buffer }>): EmsEstimate {
  const warnings: string[] = [];
  const { set, envelopeName, skipped } = groupSet(files);

  if (skipped.length) {
    warnings.push(`${skipped.length} file${skipped.length === 1 ? '' : 's'} from a different estimate or of an unknown kind ignored.`);
  }
  if (!set.size) throw new Error('No EMS files found in that upload.');

  const env = table(set, 'env', warnings)[0];
  const veh = table(set, 'veh', warnings)[0];
  const ad1 = table(set, 'ad1', warnings)[0];
  const ad2 = table(set, 'ad2', warnings)[0];
  const ttl = table(set, 'ttl', warnings)[0];
  const stl = table(set, 'stl', warnings);
  const lin = table(set, 'lin', warnings);
  const ven = table(set, 'ven', warnings);

  if (!env) warnings.push('No envelope (.env) in the set — RO number and supplement flag may be missing.');
  if (!lin.length) warnings.push('No estimate lines (.lin) in the set — parts and labour will not import.');

  const sysCode = (pickStr(env, ['EST_SYSTEM', 'SYSTEM', 'EST_SYS']) ?? '').toUpperCase().charAt(0);
  const suppNo = pickStr(env, ['SUPP_NO', 'SUPPLEMENT', 'SUPP']);
  const suppSeq = suppNo ? Number((suppNo.match(/(\d+)/) ?? [])[1] ?? 0) || null : null;

  const dateStr = pickStr(env, ['CREATE_DT', 'CREATED', 'DATE']);
  const timeStr = pickStr(env, ['CREATE_TM', 'CREATE_TIME']);
  const clock = /^(\d{2})(\d{2})(\d{2})?$/.exec(timeStr ?? '');

  // Labour and parts subtotals both live in .stl, keyed by family (LA, PA) and
  // code (LAB, LAR, PAO …). The .pf* files are the shop's rate and tax profile,
  // not this estimate's numbers.
  const sub = stl.map(r => ({
    family: (pickStr(r, ['TTL_TYPE']) ?? '').toUpperCase(),
    code: (pickStr(r, ['TTL_TYPECD']) ?? '').toUpperCase(),
    amountCents: cents(pickNum(r, ['TTL_AMT', 'NT_AMT', 'T_AMT'])) ?? 0,
    hours: pickNum(r, ['TTL_HRS', 'NT_HRS', 'T_HRS'])
  }));

  const laborByType = sub
    .filter(s => s.family === 'LA' && s.code && s.code !== 'LAT' && (s.amountCents > 0 || (s.hours ?? 0) > 0))
    .map(s => ({
      type: s.code,
      label: LABOR_TYPES[s.code] ?? s.code,
      hours: s.hours,
      amountCents: s.amountCents
    }));

  const partsByType = sub
    .filter(s => s.family === 'PA' && s.code && s.code !== 'PAT' && s.amountCents > 0)
    .map(s => ({ type: s.code, label: PART_TYPES[s.code] ?? s.code, amountCents: s.amountCents }));

  const laborTotalRow = sub.find(s => s.code === 'LAT');

  // CCC writes one .lin record per labour operation, so a part with body and
  // paint time appears twice carrying the same price. Charging both double-bills
  // the parts total, so the price stays on the first record only. ACT_PRICE is
  // the charged price: when PRICE_INC says the part is included in another
  // line, ACT_PRICE is 0 and DB_PRICE is not — never fall back to DB_PRICE.
  const priced = new Set<string>();

  const lines: EmsLine[] = lin.map(r => {
    const isSublet = pickBool(r, ['MISC_SUBLT']);
    const subletAmt = cents(pickNum(r, ['MISC_AMT'])) ?? 0;
    const lineNo = pickNum(r, ['LINE_NO', 'LINE_REF', 'UNQ_SEQ', 'SEQ_NO']);
    const partNumber = pickStr(r, ['OEM_PARTNO', 'ALT_PARTNO', 'OEM_PART_NO', 'PART_NO']);
    let priceCents = cents(pickNum(r, ['ACT_PRICE', 'PART_PRICE', 'UNIT_PRICE'])) ?? 0;

    if (priceCents > 0) {
      const key = `${lineNo}|${partNumber}|${priceCents}`;
      if (priced.has(key)) priceCents = 0;
      else priced.add(key);
    }

    return {
      lineNo,
      operation: pickStr(r, ['LBR_OP', 'OP_CODE', 'OPERATION']),
      description: pickStr(r, ['LINE_DESC', 'DESCRIPTION', 'PART_DESC']),
      partNumber,
      partType: pickStr(r, ['PART_TYPE']),
      qty: pickNum(r, ['PART_QTY', 'QTY', 'QUANTITY']) || 1,
      priceCents,
      laborHours: pickNum(r, ['MOD_LB_HRS', 'DB_HRS', 'LBR_HRS']),
      laborType: pickStr(r, ['MOD_LBR_TY', 'LBR_TYPE', 'LABOR_TYPE']),
      isSublet,
      subletAmountCents: isSublet ? subletAmt : 0
    };
  }).filter(l => l.description || l.partNumber || l.priceCents || l.laborHours);

  const vin = (pickStr(veh, ['V_VIN', 'VIN', 'VIN_NO']) ?? '').toUpperCase() || null;

  const est: EmsEstimate = {
    estimatingSystem: SYSTEM_NAME[sysCode] ?? (sysCode ? 'other' : null),
    envelopeName,
    roNumber: pickStr(env, ['RO_ID', 'RO_NO', 'RONUM', 'REPAIR_ORD']),
    supplementNo: suppNo,
    supplementSeq: suppSeq,
    createdAt: dateStr
      ? `${dateStr}${clock ? ` ${clock[1]}:${clock[2]}:${clock[3] ?? '00'}` : timeStr ? ' ' + timeStr : ''}`
      : null,
    emsVersion: pickStr(env, ['EMS_VER', 'VERSION']),

    vin,
    year: modelYear(pickStr(veh, ['V_MODEL_YR', 'MODEL_YR', 'V_YEAR', 'YEAR'])),
    make: pickStr(veh, ['V_MAKEDESC', 'V_MAKECODE', 'V_MAKE', 'MAKE']),
    model: pickStr(veh, ['V_MODEL', 'MODEL']),
    bodyStyle: pickStr(veh, ['V_BSTYLE', 'V_BODY_STYLE', 'BODY_STYLE']),
    engine: pickStr(veh, ['V_ENGINE', 'ENGINE']),
    mileage: pickNum(veh, ['V_MILEAGE', 'MILEAGE', 'ODOMETER']),
    color: pickStr(veh, ['V_COLOR', 'COLOR', 'TRIM_COLOR']),
    paintCode: pickStr(veh, ['PAINT_CD1', 'V_PAINT_CODE', 'PAINT_CODE']),
    plate: pickStr(veh, ['PLATE_NO', 'V_LICENSE', 'LICENSE']),
    plateState: pickStr(veh, ['PLATE_ST', 'V_LIC_STATE', 'LIC_STATE']),

    customerName: joinName(
      pickStr(ad1, ['OWNR_FN', 'INSD_FN', 'OWNER_FIRST', 'FIRST_NAME']),
      pickStr(ad1, ['OWNR_LN', 'INSD_LN', 'OWNER_LAST', 'LAST_NAME']),
      pickStr(ad1, ['OWNR_CO_NM', 'INSD_CO_NM'])
    ),
    customerPhone: pickStr(ad1, ['OWNR_PH1', 'INSD_PH1', 'OWNR_PH2', 'INSD_PH2']),
    customerAddress: pickStr(ad1, ['OWNR_ADDR1', 'INSD_ADDR1', 'ADDRESS']),
    customerCity: pickStr(ad1, ['OWNR_CITY', 'INSD_CITY', 'CITY']),
    customerState: pickStr(ad1, ['OWNR_ST', 'INSD_ST', 'STATE']),
    customerZip: pickStr(ad1, ['OWNR_ZIP', 'INSD_ZIP', 'ZIP']),

    insurer: pickStr(ad1, ['INS_CO_NM', 'INS_CO_NAME', 'INSURER', 'CARRIER']),
    policyNumber: pickStr(ad1, ['POLICY_NO', 'POLICY']),
    claimNumber: pickStr(ad1, ['CLM_NO', 'CLAIM_NO', 'ASGN_NO']),
    deductibleCents: cents(pickNum(ad1, ['DED_AMT', 'DEDUCT', 'DEDUCTIBLE'])),
    deductibleWaived: /^W/i.test(String(pickStr(ad1, ['DED_STATUS']) ?? '')),
    dateOfLoss: normDate(pickStr(ad1, ['LOSS_DATE', 'LOSS_DT', 'DATE_LOSS'])),
    catCode: pickStr(ad1, ['CAT_NO', 'LOSS_CAT', 'CAT_CODE']),
    adjuster: joinName(
      pickStr(ad1, ['CLM_CT_FN', 'ADJ_FIRST']),
      pickStr(ad1, ['CLM_CT_LN', 'ADJ_LAST']),
      pickStr(ad1, ['ADJ_NAME', 'ADJUSTER'])
    ),
    estimator: pickStr(ad2, ['RF_ESTIMTR', 'EST_NAME', 'ESTIMATOR']) ??
      joinName(pickStr(ad2, ['EST_CT_FN']), pickStr(ad2, ['EST_CT_LN']), null),

    grossCents: cents(pickNum(ttl, ['G_TTL_AMT', 'GROSS_TOT', 'TOTAL_GROSS'])),
    netCents: cents(pickNum(ttl, ['N_TTL_AMT', 'NET_TOT', 'TOTAL_NET'])),
    previousNetCents: cents(pickNum(ttl, ['PREV_NET', 'PREVIOUS_NET'])),
    supplementCents: cents(pickNum(ttl, ['SUPP_AMT', 'N_SUPP_ANT', 'SUPP_TOT'])),
    taxCents: sumCents(pickNum(ttl, ['G_TAX', 'TAX_TOT', 'SALES_TAX']), pickNum(ttl, ['GST_AMT'])),
    customerPayCents: cents(pickNum(ttl, ['G_CUST_AMT', 'CUST_PAY', 'CUSTOMER_PAY'])),

    laborHoursTotal: laborTotalRow?.hours ??
      (laborByType.reduce((a, l) => a + (l.hours ?? 0), 0) ||
        lines.reduce((a, l) => a + (l.laborHours ?? 0), 0) || null),
    laborByType,
    partsByType,

    lines,
    vendors: ven.map(r => ({
      name: pickStr(r, ['VND_CO_NM', 'VEN_NAME', 'VENDOR']) ?? '',
      phone: pickStr(r, ['VND_PH1', 'VND_CT_PH', 'VEN_PHONE']),
      kind: pickStr(r, ['VND_TYPE', 'VEN_TYPE'])
    })).filter(v => v.name),
    damageMemo: pickStr(veh, ['DMG_MEMO', 'V_MEMO']),

    warnings
  };

  if (!est.roNumber && !est.vin && !est.claimNumber) {
    warnings.push('No RO number, VIN or claim number in the set — this cannot be matched automatically.');
  }

  return est;
}

function joinName(first: string | null, last: string | null, whole: string | null): string | null {
  const parts = [first, last].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return whole ?? null;
}

/** EMS dates arrive as MM-DD-YYYY or YYYY-MM-DD depending on the system. */
function normDate(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
