import { RowDataPacket } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, withTenantTx } from '../db/tenant';

/**
 * Who a status change messages.
 *
 * Ten targets in two kinds. Six are roles — everyone holding the role hears.
 * Four are the person assigned to a trade ON THIS FILE, which is what keeps the
 * painter out of the disassembly traffic: an unassigned trade messages nobody
 * rather than falling back to everyone who could have done the work.
 *
 * Rows key on `slot_id` because slot ids are canonical. Renaming a status must
 * not move who hears about it.
 *
 * A status with no rows messages nobody, deliberately — Initial Wash ships that
 * way. So "has this shop configured routing at all?" cannot be asked per
 * status; it is asked of the table as a whole (`routingConfigured`), and until
 * any row exists the old NOTIF_GROUPS router still runs.
 */

export type TargetKind = 'role' | 'assigned';

export interface RouteRow {
  slot_id: string;
  target_kind: TargetKind;
  target_key: string;
}

/** The role targets, in the order the grid draws them. */
export const ROUTE_ROLES: Array<{ key: string; code: string }> = [
  { key: 'owner', code: 'O' },
  { key: 'production_manager', code: 'PM' },
  { key: 'parts_manager', code: 'PA' },
  { key: 'estimator', code: 'ES' },
  { key: 'front_office', code: 'FO' },
  { key: 'accounting', code: 'A' }
];

/**
 * The assigned targets. `positions` is what an assignment row has to name for
 * this target to match — "assigned tech" is whoever is on body or R&I, because
 * the shop calls both of them the tech on the car.
 */
export const ROUTE_ASSIGNED: Array<{ key: string; code: string; label: string; positions: string[] }> = [
  { key: 'tech', code: 'T', label: 'Assigned tech', positions: ['body', 'ri'] },
  { key: 'pdr', code: 'PD', label: 'Assigned PDR tech', positions: ['pdr'] },
  { key: 'paint', code: 'PT', label: 'Assigned painter', positions: ['paint'] },
  { key: 'detail', code: 'PR', label: 'Assigned detail', positions: ['detail'] }
];

export const ASSIGNED_KEYS = ROUTE_ASSIGNED.map(a => a.key);

/**
 * What ships. Codes, because this is a table a person reads: O owner, PM
 * production manager, PA parts manager, ES estimator, FO front office, A
 * accounting; then the assigned four — T tech, PD PDR tech, PT painter, PR
 * detail.
 *
 * A slot missing from this map messages nobody. `qa.wash` is the one that ships
 * that way on purpose.
 *
 * Migration 018 carries the same defaults as SQL for shops that already exist;
 * this copy seeds new ones and backs "Reset to default" on the grid.
 */
export const DEFAULT_ROUTES: Record<string, string> = {
  'intake.arrived': 'O PM FO',
  'intake.auth': 'FO',
  'intake.claim': 'FO',

  'assess.awaiting': 'O PM',
  'assess.scope.awaiting': 'ES',
  'assess.scope.working': 'ES',
  'assess.scope.complete': 'PM FO',
  'assess.teardown.awaiting': 'PM T',
  'assess.teardown.working': 'PM T',
  'assess.teardown.complete': 'PM ES',
  'est.needed': 'ES',
  'est.sent': 'FO',
  'est.awaiting': 'FO',
  'est.approved': 'ES FO',
  'est.review': 'ES',

  'parts.needed': 'PA',
  'parts.ordered': 'PM',
  'parts.awaiting': 'PM T',
  'parts.backordered': 'PM T',

  'lane.pdr.awaiting': 'PM PD',
  'lane.pdr.working': 'PM',
  'lane.pdr.complete': 'PM',
  'lane.pdr.supp.needed': 'ES',
  'lane.pdr.supp.sent': 'PM FO',
  'lane.pdr.supp.approved': 'PM ES',

  'lane.body.awaiting': 'PM T',
  'lane.body.working': 'PM T',
  'lane.body.complete': 'PM',
  'lane.body.supp.needed': 'ES',
  'lane.body.supp.sent': 'PM FO',
  'lane.body.supp.approved': 'PM ES',

  'lane.prep.awaiting': 'PM PT PR',
  'lane.prep.working': 'PM PT PR',
  'lane.prep.complete': 'PM PT PR',
  'lane.prep.supp.needed': 'ES',
  'lane.prep.supp.sent': 'PM FO',
  'lane.prep.supp.approved': 'PM FO',

  'lane.paint.awaiting': 'PM PT',
  'lane.paint.working': 'PM PT',
  'lane.paint.complete': 'PM',
  'lane.paint.supp.needed': 'ES',
  'lane.paint.supp.sent': 'PM FO',
  'lane.paint.supp.approved': 'PM FO',

  'lane.reassembly.awaiting': 'PM T',
  'lane.reassembly.working': 'PM T',
  'lane.reassembly.complete': 'PM',
  'lane.reassembly.supp.needed': 'ES',
  'lane.reassembly.supp.sent': 'PM FO',
  'lane.reassembly.supp.approved': 'PM',

  'lane.sublet.awaiting': 'PM',
  'lane.sublet.at': 'PM',
  'lane.sublet.working': 'PM',
  'lane.sublet.complete': 'PM',

  'lane.buff.awaiting': 'PM PR',
  'lane.buff.working': 'PM PR',
  'lane.buff.complete': 'PM',

  'lane.detail.awaiting': 'PM',
  'lane.detail.working': 'PM',
  'lane.detail.complete': 'PM',

  'qa.qc': 'O PM',
  'qa.detail': 'O PM',
  'qa.qc.final': 'O PM',

  'ready.payment': 'A FO',
  'ready.contacted': 'O FO',
  'ready.scheduled': 'O FO',
  'ready.vehicle': 'O PM FO',

  'deliver.payment': 'O FO',
  'deliver.pickup': 'O FO',
  'close.paperwork': 'O A FO',
  'close.file': 'O A'
};

const BY_CODE = new Map<string, { kind: TargetKind; key: string }>([
  ...ROUTE_ROLES.map(r => [r.code, { kind: 'role' as TargetKind, key: r.key }] as const),
  ...ROUTE_ASSIGNED.map(a => [a.code, { kind: 'assigned' as TargetKind, key: a.key }] as const)
]);

/** The default map as rows, for the slots a given board actually carries. */
export function defaultRoutesFor(slotIds: string[]): RouteRow[] {
  const out: RouteRow[] = [];
  for (const slot of slotIds) {
    for (const code of (DEFAULT_ROUTES[slot] ?? '').split(' ').filter(Boolean)) {
      const t = BY_CODE.get(code);
      if (t) out.push({ slot_id: slot, target_kind: t.kind, target_key: t.key });
    }
  }
  return out;
}

/**
 * Has this shop's routing table been seeded? Asked of the table, not of a
 * status — see the note above.
 */
export async function routingConfigured(cid: number): Promise<boolean> {
  const rows = await tq<Array<RowDataPacket & { n: number }>>(
    cid, 'SELECT COUNT(*) AS n FROM status_routes'
  ).catch(() => [] as Array<RowDataPacket & { n: number }>);
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function allRoutes(cid: number): Promise<RouteRow[]> {
  return tq<Array<RowDataPacket & RouteRow>>(
    cid, 'SELECT slot_id, target_kind, target_key FROM status_routes'
  ).catch(() => [] as Array<RowDataPacket & RouteRow>);
}

/**
 * The people one status change should reach on one file.
 *
 * Role targets are a master-database question (membership is master-side);
 * `membership_roles` is the truth with `memberships.role` as the pre-migration
 * fallback. Assigned targets are a tenant question and need the file.
 */
export async function recipientsForStatus(
  cid: number, slotId: string, roId: number | null | undefined
): Promise<number[]> {
  const routes = await tq<Array<RowDataPacket & RouteRow>>(
    cid, 'SELECT slot_id, target_kind, target_key FROM status_routes WHERE slot_id = ?', [slotId]
  ).catch(() => [] as Array<RowDataPacket & RouteRow>);
  if (!routes.length) return [];

  const out = new Set<number>();

  const roleKeys = routes.filter(r => r.target_kind === 'role').map(r => r.target_key);
  if (roleKeys.length) {
    const holders = await mq<Array<RowDataPacket & { user_id: number }>>(`
      SELECT DISTINCT m.user_id
      FROM memberships m
      LEFT JOIN membership_roles mr
             ON mr.user_id = m.user_id AND mr.company_id = m.company_id
      WHERE m.company_id = ? AND m.status = 'active'
        AND COALESCE(mr.role_key, m.role) IN (?)`,
      [cid, roleKeys]
    ).catch(() => [] as Array<RowDataPacket & { user_id: number }>);
    for (const h of holders) out.add(Number(h.user_id));
  }

  const assignedKeys = routes.filter(r => r.target_kind === 'assigned').map(r => r.target_key);
  if (assignedKeys.length && roId) {
    const positions = ROUTE_ASSIGNED
      .filter(a => assignedKeys.indexOf(a.key) >= 0)
      .reduce<string[]>((acc, a) => acc.concat(a.positions), []);
    if (positions.length) {
      const people = await tq<Array<RowDataPacket & { user_id: number | null }>>(cid,
        `SELECT DISTINCT user_id FROM ro_assignments
          WHERE ro_id = ? AND user_id IS NOT NULL AND position_key IN (?)`,
        [roId, positions]
      ).catch(() => [] as Array<RowDataPacket & { user_id: number | null }>);
      for (const p of people) if (p.user_id) out.add(Number(p.user_id));
    }
  }

  return [...out];
}

/** Replace the whole grid in one write, so a save cannot half-apply. */
export async function saveRoutes(cid: number, rows: RouteRow[]): Promise<number> {
  const clean = rows
    .filter(r => r.slot_id && (r.target_kind === 'role' || r.target_kind === 'assigned') && r.target_key)
    .map(r => [r.slot_id.slice(0, 48), r.target_kind, r.target_key.slice(0, 32)]);

  await withTenantTx(cid, async (c) => {
    await c.query('DELETE FROM status_routes');
    if (clean.length) {
      await c.query(
        'INSERT IGNORE INTO status_routes (slot_id, target_kind, target_key) VALUES ?',
        [clean]
      );
    }
  });

  return clean.length;
}
