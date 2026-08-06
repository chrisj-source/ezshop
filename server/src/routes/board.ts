import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { scrubMoney } from '../permissions';

interface BoardRow extends RowDataPacket {
  id: number; ro_number: string; status_slot: string | null; status_since: Date | null;
  on_hold: number; hold_reason: string | null; hold_owner: string | null;
  repair_path: string; opened_at: Date; promised_at: Date | null; target_days: number | null;
  amount_cents: number; labor_hours: string;
  customer_name: string | null; insurer_name: string | null;
  vin: string | null; year: number | null; make: string | null; model: string | null; color: string | null;
  status_label: string | null; customer_label: string | null; group_id: string | null;
  group_label: string | null; lane_key: string | null; kind: string | null;
  age_yellow_hours: number | null; age_red_hours: number | null;
  parts_waiting: number; supp_open: number;
}

export async function registerBoard(app: FastifyInstance): Promise<void> {

  /**
   * The whole board in one payload. A shop with a few hundred open files is
   * well under a megabyte; pagination lives in the client.
   */
  app.get('/api/board', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'board', reply)) return;

    const q = req.query as { closed?: string; since?: string };
    const wantClosed = q.closed === '1';

    const params: unknown[] = [];
    let scope = '';

    // Technicians see only the files assigned to them, when the shop says so.
    if (!ctx.caps.seesAllRepairOrders) {
      scope = ` AND EXISTS (SELECT 1 FROM ro_assignments a WHERE a.ro_id = r.id AND a.user_id = ?)`;
      params.push(ctx.user.id);
    }

    const closedClause = wantClosed
      ? 'r.closed_at IS NOT NULL AND r.closed_at > DATE_SUB(NOW(), INTERVAL 90 DAY)'
      : 'r.closed_at IS NULL';

    const rows = await tq<BoardRow[]>(ctx.company!.id, `
      SELECT
        r.id, r.ro_number, r.status_slot, r.status_since, r.on_hold, r.hold_reason, r.hold_owner,
        r.repair_path, r.opened_at, r.promised_at, r.target_days,
        r.amount_cents, r.labor_hours,
        c.name AS customer_name,
        ins.name AS insurer_name,
        v.vin, v.year, v.make, v.model, v.color,
        s.label AS status_label, s.customer_label, s.group_id, s.lane_key, s.kind,
        s.age_yellow_hours, s.age_red_hours,
        g.label AS group_label,
        (SELECT COUNT(*) FROM parts_lines p
          WHERE p.ro_id = r.id AND p.gating = 1
            AND p.state IN ('need','ordered','partial','backordered')) AS parts_waiting,
        (SELECT COUNT(*) FROM supplements sp
          WHERE sp.ro_id = r.id AND sp.state IN ('draft','sent','awaiting')) AS supp_open
      FROM repair_orders r
      LEFT JOIN clients c   ON c.id = r.client_id
      LEFT JOIN clients ins ON ins.id = r.insurer_client_id
      LEFT JOIN vehicles v  ON v.id = r.vehicle_id
      LEFT JOIN statuses s  ON s.slot_id = r.status_slot
      LEFT JOIN status_groups g ON g.group_id = s.group_id
      WHERE ${closedClause}${scope}
      ORDER BY r.opened_at DESC
    `, params);

    const assignments = await tq<Array<RowDataPacket & { ro_id: number; position_key: string; display_name: string | null }>>(
      ctx.company!.id,
      `SELECT a.ro_id, a.position_key, a.display_name FROM ro_assignments a
       JOIN repair_orders r ON r.id = a.ro_id
       WHERE ${wantClosed ? 'r.closed_at IS NOT NULL' : 'r.closed_at IS NULL'}`
    );

    const byRo = new Map<number, Record<string, string | null>>();
    for (const a of assignments) {
      const m = byRo.get(a.ro_id) ?? {};
      m[a.position_key] = a.display_name;
      byRo.set(a.ro_id, m);
    }

    const now = Date.now();
    const files = rows.map(r => {
      const sinceMs = r.status_since ? now - new Date(r.status_since).getTime() : 0;
      const hoursInStatus = Math.floor(sinceMs / 3_600_000);
      const daysInShop = Math.floor((now - new Date(r.opened_at).getTime()) / 86_400_000);

      let age: 'ok' | 'yellow' | 'red' = 'ok';
      if (r.age_red_hours && hoursInStatus >= r.age_red_hours) age = 'red';
      else if (r.age_yellow_hours && hoursInStatus >= r.age_yellow_hours) age = 'yellow';

      return scrubMoney({
        id: r.id,
        ro: r.ro_number,
        statusSlot: r.status_slot,
        status: r.status_label,
        customerStatus: r.customer_label,
        group: r.group_id,
        groupLabel: r.group_label,
        lane: r.lane_key,
        kind: r.kind,
        onHold: r.on_hold === 1,
        holdReason: r.hold_reason,
        holdOwner: r.hold_owner,
        repairPath: r.repair_path,
        customer: r.customer_name,
        insurer: r.insurer_name,
        vehicle: [r.year, r.make, r.model].filter(Boolean).join(' ') || null,
        color: r.color,
        vin: r.vin,
        openedAt: r.opened_at,
        promisedAt: r.promised_at,
        targetDays: r.target_days,
        daysInShop,
        hoursInStatus,
        age,
        partsWaiting: r.parts_waiting,
        supplementsOpen: r.supp_open,
        amount_cents: r.amount_cents,
        laborHours: Number(r.labor_hours),
        assigned: byRo.get(r.id) ?? {}
      }, ctx.caps);
    });

    const statuses = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT s.slot_id, s.label, s.customer_label, s.group_id, s.lane_key, s.kind,
             s.owner_role, s.age_yellow_hours, s.age_red_hours, s.sort_order, s.is_terminal,
             g.label AS group_label, g.sort_order AS group_order
      FROM statuses s JOIN status_groups g ON g.group_id = s.group_id
      WHERE s.visible = 1
      ORDER BY g.sort_order, s.sort_order
    `);

    return { files, statuses, caps: ctx.caps, count: files.length };
  });

  /** KPI strip. Computed server-side so every role sees the same numbers. */
  app.get('/api/board/summary', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const [row] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT
        COUNT(*) AS in_list,
        SUM(r.on_hold = 1) AS on_hold,
        SUM(r.labor_hours) AS labor_hours,
        AVG(DATEDIFF(NOW(), r.opened_at)) AS avg_days,
        SUM(r.promised_at IS NOT NULL AND r.promised_at < CURDATE()) AS past_target,
        SUM(TIMESTAMPDIFF(HOUR, r.status_since, NOW()) >= COALESCE(s.age_red_hours, 999999)) AS stalled
      FROM repair_orders r
      LEFT JOIN statuses s ON s.slot_id = r.status_slot
      WHERE r.closed_at IS NULL
    `);

    return {
      inList: Number(row.in_list ?? 0),
      onHold: Number(row.on_hold ?? 0),
      laborHours: Number(row.labor_hours ?? 0),
      avgDays: row.avg_days === null ? 0 : Math.round(Number(row.avg_days) * 10) / 10,
      pastTarget: Number(row.past_target ?? 0),
      stalled: Number(row.stalled ?? 0)
    };
  });
}
