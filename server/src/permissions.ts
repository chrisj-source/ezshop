/**
 * Who can see and do what.
 *
 * Roles are the shop's own now: rows in the tenant `roles` table with a
 * capability row each in `role_caps`. A person can hold several (the owner who
 * also writes estimates, the office manager who also does the books) and what
 * they may do is the UNION of all of them.
 *
 * Two roles are locked structurally and cannot be deleted — 'owner', because the
 * platform, the scheduler and the calendar key off it, and 'technician', because
 * the lane rules hang off trades. Both can still be renamed: `label` belongs to
 * the shop, `role_key` belongs to us.
 *
 * Everything here is a pure function of role rows + capability rows — no
 * database access — so it can be mirrored in the client for hiding controls. The
 * server still checks.
 */

/** The eight roles we ship. A shop may add more; the keys are then arbitrary. */
export type Role = string;

/** Labels for the shipped keys, used before the roles table is readable. */
export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  accounting: 'Accounting',
  estimator: 'Estimator',
  production_manager: 'Production manager',
  parts_manager: 'Parts manager',
  front_office: 'Front office',
  salesperson: 'Salesperson',
  technician: 'Technician'
};

export type Lock = 'none' | 'owner' | 'tech';

export interface RoleRow {
  role_key: string;
  label: string;
  rank_order: number;
  locked: Lock;
  own_only: boolean;
  is_custom: boolean;
  note?: string | null;
}

export interface CapRow {
  role_key: string;
  cap_key: string;
  can_see: boolean;
  can_change: boolean;
}

/**
 * The capability list, in the order the permissions screen draws it. `see` and
 * `change` name the Caps fields each column lands in; a capability with no
 * `change` field does not split — its tick is the whole answer.
 */
export interface CapDef {
  key: string;
  label: string;
  section: string;
  see: keyof Caps;
  change?: keyof Caps;
  /** Shown on the screen only when the shop's plan carries this feature. */
  feature?: string;
}

export const CAP_DEFS: CapDef[] = [
  { key: 'ro_totals',     label: 'Repair order totals',        section: 'Money',    see: 'money',            change: 'editMoney' },
  { key: 'parts_money',   label: 'Parts cost and margin',      section: 'Money',    see: 'partsMoney',       change: 'editPartsMoney' },
  { key: 'labour_money',  label: 'Labour hours, paint and PDR', section: 'Money',   see: 'labourMoney',      change: 'editLabourMoney' },
  { key: 'commission',    label: 'Commission',                 section: 'Money',    see: 'commissionMoney' },

  { key: 'sees_all',      label: 'Sees files on the board',    section: 'Files',    see: 'seesRepairOrders' },
  { key: 'edit_ro',       label: 'Create and edit repair orders', section: 'Files', see: 'editRepairOrders' },
  { key: 'any_status',    label: 'Move a file to any status',  section: 'Files',    see: 'anyStatus' },
  { key: 'total_loss',    label: 'Mark a total loss',          section: 'Files',    see: 'markTotalLoss' },
  { key: 'void_ro',       label: 'Void a file and bring it back', section: 'Files', see: 'voidRepairOrders' },
  { key: 'close_ro',      label: 'Close a file',               section: 'Files',    see: 'closeRepairOrders' },
  { key: 'unclose',       label: 'Reopen a closed file',       section: 'Files',    see: 'uncloseRepairOrders' },

  { key: 'leads',         label: 'Leads',                      section: 'Leads',    see: 'viewLeads',        change: 'manageLeads' },
  { key: 'del_lead',      label: 'Delete a lead',              section: 'Leads',    see: 'deleteLeads' },

  { key: 'paperwork',     label: 'Paperwork and PDFs',         section: 'Paperwork', see: 'viewPaperwork',   change: 'uploadPaperwork' },
  { key: 'del_doc',       label: 'Delete a document',          section: 'Paperwork', see: 'deleteDocuments' },
  { key: 'imports',       label: 'Accept an EMS import',       section: 'Paperwork', see: 'acceptImports' },

  { key: 'assign',        label: 'Assign technicians',         section: 'Shop floor', see: 'editAssignments' },
  { key: 'parts',         label: 'Manage parts and ordering',  section: 'Shop floor', see: 'manageParts' },
  { key: 'sublet',        label: 'Manage sublet and vendors',  section: 'Shop floor', see: 'manageSublet' },

  { key: 'reports',       label: 'Reports',                    section: 'Reports and setup', see: 'viewReports', change: 'exportReports' },
  { key: 'money_reports', label: 'Money reports',              section: 'Reports and setup', see: 'viewMoneyReports' },
  { key: 'pay_plans',     label: 'Sales pay plans',            section: 'Reports and setup', see: 'viewPayPlans', change: 'editPayPlans' },
  { key: 'audit',         label: 'Read the audit log',         section: 'Reports and setup', see: 'viewAudit' },
  { key: 'admin',         label: 'Change shop settings',       section: 'Reports and setup', see: 'admin' },
  { key: 'perms',         label: 'Change roles and permissions', section: 'Reports and setup', see: 'managePermissions' }
];

export const CAP_KEYS: string[] = CAP_DEFS.map(c => c.key);

export interface Caps {
  /* money */
  money: boolean;
  editMoney: boolean;
  partsMoney: boolean;
  editPartsMoney: boolean;
  labourMoney: boolean;
  editLabourMoney: boolean;
  commissionMoney: boolean;
  /* files */
  seesRepairOrders: boolean;
  /** Every file, not only their own. Derived: sees files AND not own-only. */
  seesAllRepairOrders: boolean;
  /** True when every role held is own-only. Narrows leads, files and reports. */
  ownWorkOnly: boolean;
  editRepairOrders: boolean;
  anyStatus: boolean;
  markTotalLoss: boolean;
  voidRepairOrders: boolean;
  closeRepairOrders: boolean;
  uncloseRepairOrders: boolean;
  /* leads */
  viewLeads: boolean;
  manageLeads: boolean;
  deleteLeads: boolean;
  /* paperwork */
  viewPaperwork: boolean;
  uploadPaperwork: boolean;
  deleteDocuments: boolean;
  acceptImports: boolean;
  /* shop floor */
  editAssignments: boolean;
  manageParts: boolean;
  manageSublet: boolean;
  /* reports and setup */
  viewReports: boolean;
  exportReports: boolean;
  viewMoneyReports: boolean;
  viewPayPlans: boolean;
  editPayPlans: boolean;
  /** Read the audit log. Its own tick so a manager can have it alone. */
  viewAudit: boolean;
  admin: boolean;
  managePermissions: boolean;
}

const CAPS_FIELDS: Array<keyof Caps> = [
  'money', 'editMoney', 'partsMoney', 'editPartsMoney', 'labourMoney', 'editLabourMoney',
  'commissionMoney', 'seesRepairOrders', 'seesAllRepairOrders', 'ownWorkOnly',
  'editRepairOrders', 'anyStatus', 'markTotalLoss', 'voidRepairOrders', 'closeRepairOrders',
  'uncloseRepairOrders', 'viewLeads', 'manageLeads', 'deleteLeads', 'viewPaperwork',
  'uploadPaperwork', 'deleteDocuments', 'acceptImports', 'editAssignments', 'manageParts',
  'manageSublet', 'viewReports', 'exportReports', 'viewMoneyReports', 'viewPayPlans',
  'editPayPlans', 'viewAudit', 'admin', 'managePermissions'
];

export function emptyCaps(): Caps {
  const out = {} as Caps;
  for (const f of CAPS_FIELDS) out[f] = false;
  return out;
}

/**
 * The union of every role held, read off the shop's own rows.
 *
 * `own_only` is per role, so a person who holds one whole-shop role and one
 * own-only role sees the whole shop — the wider role wins, exactly as the
 * capability union does.
 */
export function capsFromRows(roleKeys: string[], roles: RoleRow[], caps: CapRow[]): Caps {
  const out = emptyCaps();
  const held = roles.filter(r => roleKeys.includes(r.role_key));
  if (!held.length) return out;

  const byKey = new Map<string, RoleRow>(held.map(r => [r.role_key, r]));
  let seesWide = false;

  for (const row of caps) {
    if (!byKey.has(row.role_key)) continue;
    const def = CAP_DEFS.find(d => d.key === row.cap_key);
    if (!def) continue;
    if (row.can_see) out[def.see] = true;
    if (row.can_change && def.change) out[def.change] = true;
    /* A role that sees files and is not own-only is what makes the whole board
       visible. Own-only roles still see files — just their own. */
    if (row.cap_key === 'sees_all' && row.can_see && !byKey.get(row.role_key)!.own_only) {
      seesWide = true;
    }
  }

  /* The owner lock is not a row: it is the guarantee that the owner role cannot
     be reduced, enforced here as well as in the endpoint. */
  if (held.some(r => r.locked === 'owner')) {
    for (const f of CAPS_FIELDS) out[f] = true;
    out.ownWorkOnly = false;
    return out;
  }

  out.seesAllRepairOrders = seesWide;
  out.ownWorkOnly = out.seesRepairOrders && !seesWide;
  return out;
}

/* ----------------------------------------------------- pre-migration fallback
 *
 * A shop whose tenant database has not run migration 011 has no roles table.
 * These are the lists the hard-coded version carried, kept so the app runs on
 * either side of the migration. Nothing else should read them.
 */

const LEGACY: Record<string, Array<[string, 0 | 1, 0 | 1]>> = {
  owner: CAP_KEYS.map(k => [k, 1, 1] as [string, 1, 1]),
  accounting: [['ro_totals', 1, 1], ['parts_money', 1, 0], ['labour_money', 1, 0], ['commission', 1, 1],
    ['sees_all', 1, 0], ['close_ro', 1, 1], ['unclose', 1, 1], ['leads', 1, 0], ['paperwork', 1, 1],
    ['reports', 1, 1], ['money_reports', 1, 0], ['pay_plans', 1, 1]],
  estimator: [['ro_totals', 1, 1], ['parts_money', 1, 1], ['labour_money', 1, 1], ['commission', 1, 0],
    ['sees_all', 1, 0], ['edit_ro', 1, 1], ['any_status', 1, 1], ['total_loss', 1, 1], ['close_ro', 1, 0],
    ['leads', 1, 1], ['del_lead', 1, 1], ['paperwork', 1, 1], ['del_doc', 1, 1], ['imports', 1, 1],
    ['assign', 1, 1], ['parts', 1, 1], ['sublet', 1, 1], ['reports', 1, 0], ['money_reports', 1, 0]],
  production_manager: [['labour_money', 1, 0], ['sees_all', 1, 0], ['edit_ro', 1, 1], ['any_status', 1, 1],
    ['total_loss', 1, 0], ['paperwork', 1, 1], ['imports', 1, 1], ['assign', 1, 1], ['parts', 1, 1],
    ['sublet', 1, 1], ['reports', 1, 0]],
  parts_manager: [['parts_money', 1, 1], ['sees_all', 1, 0], ['paperwork', 1, 0], ['parts', 1, 1], ['sublet', 1, 1]],
  front_office: [['ro_totals', 1, 0], ['sees_all', 1, 0], ['edit_ro', 1, 1], ['any_status', 1, 1],
    ['close_ro', 1, 1], ['leads', 1, 1], ['del_lead', 1, 0], ['paperwork', 1, 1]],
  salesperson: [['sees_all', 1, 0], ['leads', 1, 1], ['paperwork', 1, 0]],
  technician: [['sees_all', 1, 0], ['labour_money', 1, 0]]
};

const LEGACY_RANK: Record<string, number> = {
  owner: 10, accounting: 20, estimator: 30, production_manager: 40,
  parts_manager: 50, front_office: 60, salesperson: 70, technician: 80
};

export function legacyRoleRows(opts: { techSeesOwnOnly: boolean }): RoleRow[] {
  return Object.keys(LEGACY).map(key => ({
    role_key: key,
    label: ROLE_LABEL[key] ?? key,
    rank_order: LEGACY_RANK[key] ?? 100,
    locked: key === 'owner' ? 'owner' : key === 'technician' ? 'tech' : 'none',
    own_only: key === 'salesperson' ? true : key === 'technician' ? opts.techSeesOwnOnly : false,
    is_custom: false
  }));
}

export function legacyCapRows(): CapRow[] {
  const out: CapRow[] = [];
  for (const [role, rows] of Object.entries(LEGACY)) {
    for (const [cap, see, change] of rows) {
      out.push({ role_key: role, cap_key: cap, can_see: !!see, can_change: !!change });
    }
  }
  return out;
}

export function capsForRoles(roles: string[], opts: { techSeesOwnOnly: boolean }): Caps {
  return capsFromRows(roles, legacyRoleRows(opts), legacyCapRows());
}

export function capsFor(role: string, opts: { techSeesOwnOnly: boolean }): Caps {
  return capsForRoles([role], opts);
}

/* --------------------------------------------------------------- rank, order */

/**
 * The primary role: the lowest rank number held, ties broken by label. It is
 * what a person is called on screen and who notifications treat them as. It
 * never decides what they may do — that is always the union.
 */
export function primaryRoleOf(roleKeys: string[], roles: RoleRow[]): RoleRow | null {
  const held = roles.filter(r => roleKeys.includes(r.role_key));
  if (!held.length) return null;
  return held.slice().sort(byRank)[0];
}

export function byRank(a: RoleRow, b: RoleRow): number {
  if (a.rank_order !== b.rank_order) return a.rank_order - b.rank_order;
  return a.label.localeCompare(b.label);
}

/** Roles in rank order. */
export function sortRoleRows(roles: RoleRow[]): RoleRow[] {
  return roles.slice().sort(byRank);
}

/** Legacy: rank order over the shipped keys, for code that has only keys. */
export const ROLE_RANK: string[] = Object.keys(LEGACY_RANK)
  .sort((a, b) => LEGACY_RANK[a] - LEGACY_RANK[b]);

export function primaryRole(roles: string[]): string | null {
  const ranked = roles.slice().sort((a, b) => (LEGACY_RANK[a] ?? 100) - (LEGACY_RANK[b] ?? 100));
  return ranked[0] ?? null;
}

export function sortRoles(roles: string[]): string[] {
  const seen = new Set(roles);
  const known = ROLE_RANK.filter(r => seen.has(r));
  const custom = roles.filter(r => !ROLE_RANK.includes(r)).sort();
  return [...known, ...custom];
}

/* ------------------------------------------------------------------- trades */

/** Technicians only move files within the lanes their trades own. */
export const POSITION_OWNS: Record<string, string[]> = {
  pdr: ['pdr'],
  body: ['body'],
  paint: ['prep', 'paint', 'buff'],
  ri: ['reassembly'],
  detail: ['detail']
};

/** Every lane a person's trades own, across all of them. */
export function lanesFor(positionKeys: string[]): string[] {
  const out = new Set<string>();
  for (const p of positionKeys) for (const l of POSITION_OWNS[p] ?? []) out.add(l);
  return [...out];
}

/**
 * May this person move a file into this lane? Anyone with `anyStatus` may move
 * anything; anyone else is held to the lanes their trades own.
 */
export function mayMoveTo(caps: Caps, positionKeys: string[] | string | null, laneKey: string | null): boolean {
  if (caps.anyStatus) return true;
  if (!laneKey || !positionKeys) return false;
  const trades = Array.isArray(positionKeys) ? positionKeys : [positionKeys];
  return lanesFor(trades).includes(laneKey);
}

/**
 * A car nobody can start. PDR alone is a complete file — a hail car pulled by
 * one tech needs nobody else. Once body or paint is on it the car is a collision
 * repair and wants both trades: body and PDR still needs a painter, PDR and
 * paint still needs a body tech.
 */
export function needsTech(assigned: Record<string, unknown>): boolean {
  const has = (k: string): boolean => !!assigned[k];
  if (!['pdr', 'body', 'paint', 'ri'].some(has)) return true;
  if (!has('body') && !has('paint')) return false;
  return !has('body') || !has('paint');
}

/**
 * Strip money columns from an object before it leaves the server. Labour hours
 * and the paint and PDR figures are their own capability now, so a technician
 * keeps them while the dollar columns go.
 */
export function scrubMoney<T extends Record<string, unknown>>(row: T, caps: Caps): T {
  if (caps.money) return row;
  const out = { ...row } as Record<string, unknown>;
  const keepLabour = caps.labourMoney;
  const keepParts = caps.partsMoney;
  for (const k of Object.keys(out)) {
    if (keepLabour && /^labor_hours$|^labour_hours$|hours$/i.test(k)) continue;
    if (keepParts && /^parts_/i.test(k)) continue;
    if (/_cents$|^amount|^deductible|commission|^rate$/i.test(k)) delete out[k];
  }
  return out as T;
}
