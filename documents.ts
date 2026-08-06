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
  LAD: 'Diagnostic', LAE: 'Electrical', LAG: 'Glass', LAU: 'PDR', LAT: 'Total'
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

/** Group uploaded files by their EMS extension, ignoring byte-identical copies. */
export function groupSet(files: Array<{ filename: string; buffer: Buffer }>): {
  set: FileSet; envelopeName: string | null; skipped: string[];
} {
  const set: FileSet = new Map();
  const skipped: string[] = [];
  let envelopeName: string | null = null;

  for (const f of files) {
    const m = /^(.*?)(?:-[0-9a-f]{4,})?\.([a-z0-9]{2,4})$/i.exec(f.filename.trim());
    if (!m) { skipped.push(f.filename); continue; }

    const base = m[1];
    const ext = m[2].toLowerCase();

    if (ext === 'env' && !envelopeName) envelopeName = base;
    if (!envelopeName) envelopeName = base;

    if (set.has(ext)) { skipped.push(f.filename); continue; }
    set.set(ext, f.buffer);
  }

  return { set, envelopeName, skipped };
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

export function parseEms(files: Array<{ filename: string; buffer: Buffer }>): EmsEstimate {
  const warnings: string[] = [];
  const { set, envelopeName, skipped } = groupSet(files);

  if (skipped.length) {
    warnings.push(`${skipped.length} duplicate or unrecognised file${skipped.length === 1 ? '' : 's'} ignored.`);
  }
  if (!set.size) throw new Error('No EMS files found in that upload.');

  const env = table(set, 'env', warnings)[0];
  const veh = table(set, 'veh', warnings)[0];
  const ad1 = table(set, 'ad1', warnings)[0];
  const ad2 = table(set, 'ad2', warnings)[0];
  const ttl = table(set, 'ttl', warnings)[0];
  const stl = table(set, 'stl', warnings);
  const lin = table(set, 'lin', warnings);
  const pfl = table(set, 'pfl', warnings);
  const ven = table(set, 'ven', warnings);

  if (!env) warnings.push('No envelope (.env) in the set — RO number and supplement flag may be missing.');
  if (!lin.length) warnings.push('No estimate lines (.lin) in the set — parts and labour will not import.');

  const sysCode = (pickStr(env, ['EST_SYSTEM', 'SYSTEM', 'EST_SYS']) ?? '').toUpperCase().charAt(0);
  const suppNo = pickStr(env, ['SUPP_NO', 'SUPPLEMENT', 'SUPP']);
  const suppSeq = suppNo ? Number((suppNo.match(/(\d+)/) ?? [])[1] ?? 0) || null : null;

  const dateStr = pickStr(env, ['CREATE_DT', 'CREATED', 'DATE']);
  const timeStr = pickStr(env, ['CREATE_TM', 'CREATE_TIME']);

  const laborByType = pfl.map(r => {
    const type = (pickStr(r, ['LBR_TYPE', 'LABOR_TYPE', 'TYPE']) ?? '').toUpperCase();
    return {
      type,
      label: LABOR_TYPES[type] ?? type,
      hours: pickNum(r, ['LBR_HRS', 'HOURS', 'HRS']),
      amountCents: cents(pickNum(r, ['LBR_AMT', 'AMOUNT', 'AMT']))
    };
  }).filter(x => x.type);

  const partsByType = stl.map(r => {
    const type = (pickStr(r, ['PART_TYPE', 'TYPE']) ?? '').toUpperCase();
    const amt = cents(pickNum(r, ['PART_AMT', 'AMOUNT', 'AMT', 'TOTAL']));
    return { type, label: PART_TYPES[type] ?? type, amountCents: amt ?? 0 };
  }).filter(x => x.type && x.type !== 'PAT' && x.amountCents > 0);

  const lines: EmsLine[] = lin.map(r => {
    const isSublet = pickBool(r, ['MISC_SUBLT', 'SUBLET', 'SUBLT']);
    const subletAmt = cents(pickNum(r, ['MISC_AMT', 'SUBLET_AMT'])) ?? 0;
    return {
      lineNo: pickNum(r, ['LINE_NO', 'LN_NO', 'SEQ_NO', 'SEQ']),
      operation: pickStr(r, ['OP_CODE', 'LBR_OP', 'OPERATION', 'OP']),
      description: pickStr(r, ['LINE_DESC', 'DESC', 'DESCRIPTION', 'PART_DESC']),
      partNumber: pickStr(r, ['OEM_PART_NO', 'PART_NO', 'PARTNO', 'OEM_PART']),
      partType: pickStr(r, ['PART_TYPE', 'PARTTYPE']),
      qty: pickNum(r, ['QTY', 'QUANTITY']) ?? 1,
      priceCents: cents(pickNum(r, ['PART_PRICE', 'UNIT_PRICE', 'PRICE', 'AMT'])) ?? 0,
      laborHours: pickNum(r, ['LBR_HRS', 'HOURS', 'HRS']),
      laborType: pickStr(r, ['LBR_TYPE', 'LABOR_TYPE']),
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
    createdAt: dateStr ? `${dateStr}${timeStr ? ' ' + timeStr : ''}` : null,
    emsVersion: pickStr(env, ['EMS_VER', 'VERSION']),

    vin,
    year: pickNum(veh, ['V_MODEL_YR', 'MODEL_YR', 'YEAR', 'V_YEAR']),
    make: pickStr(veh, ['V_MAKE', 'MAKE', 'MAKE_DESC']),
    model: pickStr(veh, ['V_MODEL', 'MODEL', 'MODEL_DESC']),
    bodyStyle: pickStr(veh, ['V_BODY_STYLE', 'BODY_STYLE', 'BODY']),
    engine: pickStr(veh, ['V_ENGINE', 'ENGINE', 'ENG_DESC']),
    mileage: pickNum(veh, ['V_MILEAGE', 'MILEAGE', 'ODOMETER', 'MILES']),
    color: pickStr(veh, ['V_COLOR', 'COLOR', 'EXT_COLOR', 'PAINT_DESC']),
    paintCode: pickStr(veh, ['V_PAINT_CODE', 'PAINT_CODE', 'PNT_CODE']),
    plate: pickStr(veh, ['V_LICENSE', 'LICENSE', 'PLATE', 'TAG']),
    plateState: pickStr(veh, ['V_LIC_STATE', 'LIC_STATE', 'PLATE_ST']),

    customerName: joinName(
      pickStr(ad1, ['OWNER_FIRST', 'OWN_FIRST', 'INSD_FIRST', 'FIRST_NAME']),
      pickStr(ad1, ['OWNER_LAST', 'OWN_LAST', 'INSD_LAST', 'LAST_NAME']),
      pickStr(ad1, ['OWNER_NAME', 'OWN_NAME', 'INSURED', 'INSD_NAME'])
    ),
    customerPhone: pickStr(ad1, ['OWNER_PH', 'OWN_PHONE', 'PHONE', 'INSD_PH', 'DAY_PHONE']),
    customerAddress: pickStr(ad1, ['OWNER_ADDR', 'OWN_ADDR', 'ADDRESS', 'INSD_ADDR']),
    customerCity: pickStr(ad1, ['OWNER_CITY', 'OWN_CITY', 'CITY']),
    customerState: pickStr(ad1, ['OWNER_STATE', 'OWN_STATE', 'STATE']),
    customerZip: pickStr(ad1, ['OWNER_ZIP', 'OWN_ZIP', 'ZIP']),

    insurer: pickStr(ad1, ['INS_CO_NAME', 'INS_CO', 'INSURER', 'CARRIER']),
    policyNumber: pickStr(ad1, ['POLICY_NO', 'POLICY']),
    claimNumber: pickStr(ad1, ['CLAIM_NO', 'CLAIM']),
    deductibleCents: cents(pickNum(ad1, ['DED_AMT', 'DEDUCT', 'DEDUCTIBLE'])),
    deductibleWaived: /^[YW]/i.test(String(pickStr(ad1, ['DED_STATUS', 'DED_WAIVED']) ?? '')) &&
      /^W/i.test(String(pickStr(ad1, ['DED_STATUS']) ?? '')),
    dateOfLoss: normDate(pickStr(ad1, ['LOSS_DT', 'DATE_LOSS', 'LOSS_DATE'])),
    catCode: pickStr(ad1, ['CAT_CODE', 'CATASTROPHE', 'CAT']),
    adjuster: pickStr(ad1, ['ADJ_NAME', 'ADJUSTER']),
    estimator: pickStr(ad2, ['EST_NAME', 'ESTIMATOR', 'APPRAISER']),

    grossCents: cents(pickNum(ttl, ['GROSS_TOT', 'GROSS', 'TOTAL_GROSS'])),
    netCents: cents(pickNum(ttl, ['NET_TOT', 'NET', 'TOTAL_NET'])),
    previousNetCents: cents(pickNum(ttl, ['PREV_NET', 'PREVIOUS_NET'])),
    supplementCents: cents(pickNum(ttl, ['SUPP_AMT', 'SUPPLEMENT_AMT', 'SUPP_TOT'])),
    taxCents: cents(pickNum(ttl, ['TAX_TOT', 'TAX', 'SALES_TAX'])),
    customerPayCents: cents(pickNum(ttl, ['CUST_PAY', 'CUSTOMER_PAY'])),

    laborHoursTotal: laborByType.reduce((a, l) => a + (l.hours ?? 0), 0) ||
      lines.reduce((a, l) => a + (l.laborHours ?? 0), 0) || null,
    laborByType,
    partsByType,

    lines,
    vendors: ven.map(r => ({
      name: pickStr(r, ['VEN_NAME', 'NAME', 'VENDOR']) ?? '',
      phone: pickStr(r, ['VEN_PHONE', 'PHONE']),
      kind: pickStr(r, ['VEN_TYPE', 'TYPE'])
    })).filter(v => v.name),
    damageMemo: pickStr(lin[0], ['DMG_MEMO', 'MEMO', 'DAMAGE']),

    warnings
  };

  if (!est.roNumber && !est.vin && !est.claimNumber) {
    warnings.push('No RO number, VIN or claim number in the set — this cannot be matched automatically.');
  }

  return est;
}

function joinName(first: string | null, last: string | null, whole: string | null): string | null {
  if (whole) return whole;
  const parts = [first, last].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
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
