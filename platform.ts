/**
 * Who can see and do what.
 *
 * Roles come from memberships.role in the master DB. Everything here is a
 * pure function of role + shop settings — no database access — so it can be
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

/** May accept or reject an EMS import. */
const ACCEPT_IMPORT: Role[] = ['owner', 'estimator', 'production_manager'];

export interface Caps {
  money: boolean;
  seesAllRepairOrders: boolean;
  anyStatus: boolean;
  editRepairOrders: boolean;
  admin: boolean;
  deleteDocuments: boolean;
  acceptImports: boolean;
  editAssignments: boolean;
  manageParts: boolean;
  manageLeads: boolean;
  viewReports: boolean;
  viewMoneyReports: boolean;
}

export function capsFor(role: Role, opts: { techSeesOwnOnly: boolean }): Caps {
  const seesAll = SEES_ALL.includes(role) || (role === 'technician' && !opts.techSeesOwnOnly);
  return {
    money: MONEY.includes(role),
    seesAllRepairOrders: seesAll,
    anyStatus: ANY_STATUS.includes(role),
    editRepairOrders: EDIT_RO.includes(role),
    admin: ADMIN.includes(role),
    deleteDocuments: DELETE_DOCS.includes(role),
    acceptImports: ACCEPT_IMPORT.includes(role),
    editAssignments: ['owner', 'production_manager', 'estimator'].includes(role),
    manageParts: ['owner', 'parts_manager', 'estimator', 'production_manager'].includes(role),
    manageLeads: ['owner', 'front_office', 'salesperson', 'estimator'].includes(role),
    viewReports: ['owner', 'accounting', 'estimator', 'production_manager'].includes(role),
    viewMoneyReports: MONEY.includes(role)
  };
}

/** Technicians only move files within the lanes their position owns. */
export const POSITION_OWNS: Record<string, string[]> = {
  pdr: ['pdr'],
  body: ['body'],
  paint: ['prep', 'paint', 'buff'],
  ri: ['reassembly'],
  detail: ['detail']
};

export function canMoveTo(role: Role, positionKey: string | null, laneKey: string | null): boolean {
  if (ANY_STATUS.includes(role)) return true;
  if (role !== 'technician') return false;
  if (!laneKey || !positionKey) return false;
  return (POSITION_OWNS[positionKey] ?? []).includes(laneKey);
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
