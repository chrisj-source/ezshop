/**
 * Who can see and do what.
 *
 * Roles come from membership_roles in the master DB — a person can hold several
 * (the owner who also writes estimates, the office manager who also does the
 * books) and what they may do is the UNION of all of them. Everything here is a
 * pure function of roles + shop settings — no database access — so it can be
 * mirrored in the client for hiding controls. The server still checks.
 */

export type Role =
  | 'owner' | 'accounting' | 'estimator' | 'production_manager'
  | 'parts_manager' | 'front_office' | 'salesperson' | 'technician';

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  accounting: 'Accounting',
  estimator: 'Estimator',
  production_manager: 'Production manager',
  parts_manager: 'Parts manager',
  front_office: 'Front office',
  salesperson: 'Salesperson',
  technician: 'Technician'
};

/** Money figures: amounts, deductibles, costs, commission. */
const MONEY: Role[] = ['owner', 'accounting', 'estimator'];

/** Sees every repair order on the board, not just their own. */
const SEES_ALL: Role[] = ['owner', 'accounting', 'estimator', 'production_manager', 'parts_manager', 'front_office'];

/** May move a file to any status. */
const ANY_STATUS: Role[] = ['owner', 'estimator', 'production_manager', 'front_office'];

/** May create and edit repair orders. */
const EDIT_RO: Role[] = ['owner', 'estimator', 'production_manager', 'front_office'];

/** May change shop configuration — statuses, people, notification groups. */
const ADMIN: Role[] = ['owner'];

/** May delete a document off a file. */
const DELETE_DOCS: Role[] = ['owner', 'estimator'];

/**
 * May see and upload paperwork — PDFs. The office, the owner and the production
 * manager. A technician's business is photos: they shoot damage, and they read
 * the board, not the file's paperwork.
 */
const PAPERWORK: Role[] = [
  'owner', 'accounting', 'estimator', 'production_manager', 'parts_manager', 'front_office'
];

/** May accept or reject an EMS import. */
const ACCEPT_IMPORT: Role[] = ['owner', 'estimator', 'production_manager'];

/**
 * May void a repair order and bring one back. Owner and admin only — in the
 * current role set that is the owner; widen this list, not the endpoint.
 */
const VOID_RO: Role[] = ['owner'];

/**
 * Closing a file puts its money on the books, so it is the office and the people
 * who answer for the books — owner, accounting, front office. Widen this list,
 * not the endpoint.
 */
const CLOSE_RO: Role[] = ['owner', 'accounting', 'front_office'];

export interface Caps {
  money: boolean;
  viewPaperwork: boolean;
  seesAllRepairOrders: boolean;
  anyStatus: boolean;
  editRepairOrders: boolean;
  admin: boolean;
  deleteDocuments: boolean;
  acceptImports: boolean;
  voidRepairOrders: boolean;
  editAssignments: boolean;
  manageParts: boolean;
  manageLeads: boolean;
  closeRepairOrders: boolean;
  viewReports: boolean;
  viewMoneyReports: boolean;
}

export function capsFor(role: Role, opts: { techSeesOwnOnly: boolean }): Caps {
  return capsForRoles([role], opts);
}

/**
 * The union of every role held. A technician who also holds a management role
 * sees the whole board — the manager role wins over the shop's
 * techs-see-only-their-cars setting, which only binds a tech-only user.
 */
export function capsForRoles(roles: Role[], opts: { techSeesOwnOnly: boolean }): Caps {
  const list = roles.length ? roles : (['technician'] as Role[]);
  const any = (set: Role[]): boolean => list.some(r => set.includes(r));
  /* A tech-only user is bound by the shop setting; holding any role that sees the
     whole board wins over it. */
  const seesAll = any(SEES_ALL) || (list.includes('technician') && !opts.techSeesOwnOnly);
  return {
    money: any(MONEY),
    viewPaperwork: any(PAPERWORK),
    seesAllRepairOrders: seesAll,
    anyStatus: any(ANY_STATUS),
    editRepairOrders: any(EDIT_RO),
    admin: any(ADMIN),
    deleteDocuments: any(DELETE_DOCS),
    acceptImports: any(ACCEPT_IMPORT),
    voidRepairOrders: any(VOID_RO),
    editAssignments: any(['owner', 'production_manager', 'estimator']),
    manageParts: any(['owner', 'parts_manager', 'estimator', 'production_manager']),
    manageLeads: any(['owner', 'front_office', 'salesperson', 'estimator']),
    closeRepairOrders: any(CLOSE_RO),
    viewReports: any(['owner', 'accounting', 'estimator', 'production_manager']),
    viewMoneyReports: any(MONEY)
  };
}

/**
 * Rank order, highest first. The first role a person holds in this order is
 * their primary: what they are labelled as, and who notifications treat them
 * as. Derived, never stored.
 */
export const ROLE_RANK: Role[] = [
  'owner', 'accounting', 'estimator', 'production_manager',
  'parts_manager', 'front_office', 'salesperson', 'technician'
];

export function primaryRole(roles: Role[]): Role | null {
  for (const r of ROLE_RANK) if (roles.includes(r)) return r;
  return null;
}

/** Roles in rank order, de-duplicated. */
export function sortRoles(roles: Role[]): Role[] {
  return ROLE_RANK.filter(r => roles.includes(r));
}

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

export function canMoveTo(
  roles: Role | Role[],
  positionKeys: string | string[] | null,
  laneKey: string | null
): boolean {
  const list = Array.isArray(roles) ? roles : [roles];
  if (list.some(r => ANY_STATUS.includes(r))) return true;
  if (!list.includes('technician')) return false;
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

/** Strip money columns from an object before it leaves the server. */
export function scrubMoney<T extends Record<string, unknown>>(row: T, caps: Caps): T {
  if (caps.money) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    if (/_cents$|^amount|^deductible|commission|^rate$/i.test(k)) delete out[k];
  }
  return out as T;
}
