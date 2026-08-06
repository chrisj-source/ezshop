import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mq } from '../db/master';
import { tq, tqOne } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';

/**
 * Reports.
 *
 * Every report takes the same window so the numbers on two screens always
 * agree, and every one is gated: production reports need viewReports, anything
 * with money in it needs viewMoneyReports.
 */

type Window = 'in_shop' | 'mtd' | 'd30' | 'd60' | 'd90' | 'ytd' | 'custom';

interface Range { from: string; to: string; label: string; openOnly: boolean; }

function resolveWindow(q: { window?: string; from?: string; to?: string }): Range {
  const w = (q.window ?? 'mtd') as Window;
  const today = new Date();
  const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const back = (days: number) => { const d = new Date(); d.setDate(d.getDate() - days); return iso(d); };

  switch (w) {
    case 'in_shop':
      return { from: '1900-01-01', to: iso(today), label: 'Currently in the shop', openOnly: true };
    case 'd30': return { from: back(30), to: iso(today), label: 'Last 30 days', openOnly: false };
    case 'd60': return { from: back(60), to: iso(today), label: 'Last 60 days', openOnly: false };
    case 'd90': return { from: back(90), to: iso(today), label: 'Last 90 days', openOnly: false };
    case 'ytd':
      return { from: `${today.getFullYear()}-01-01`, to: iso(today), label: 'Year to date', openOnly: false };
    case 'custom': {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from! : back(30);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to! : iso(today);
      return { from, to, label: `${from} to ${to}`, openOnly: false };
    }
    default: {
      const first = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      return { from: first, to: iso(today), label: 'Month to date', openOnly: false };
    }
  }
}

/** The WHERE clause every report shares. */
function scope(r: Range): { sql: string; params: unknown[] } {
  if (r.openOnly) return { sql: 'r.closed_at IS NULL', params: [] };
  return {
    sql: '(r.opened_at >= ? AND r.opened_at < DATE_ADD(?, INTERVAL 1 DAY))',
    params: [r.from, r.to]
  };
}

export async function registerReports(app: FastifyInstance): Promise<void> {

  app.get('/api/reports/meta', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    return {
      windows: [
        { key: 'in_shop', label: 'In the shop now' },
        { key: 'mtd', label: 'Month to date' },
        { key: 'd30', label: 'Last 30 days' },
        { key: 'd60', label: 'Last 60 days' },
        { key: 'd90', label: 'Last 90 days' },
        { key: 'ytd', label: 'Year to date' },
        { key: 'custom', label: 'Custom range' }
      ],
      reports: [
        { key: 'production', label: 'Production', money: false, note: 'Where every file sits, and what is stuck.' },
        { key: 'cycle', label: 'Cycle time', money: false, note: 'Days in shop and touch time, by lane.' },
        { key: 'technician', label: 'By technician', money: false, note: 'Files, flagged hours, efficiency.' },
        { key: 'status', label: 'By status', money: false, note: 'Counts and average age per status.' },
        { key: 'salesperson', label: 'By salesperson', money: true, note: 'Files written and value.' },
        { key: 'approval', label: 'By approval date', money: true, note: 'What was approved when.' },
        { key: 'revenue', label: 'Revenue', money: true, note: 'Labour, parts, sublet, materials.' },
        { key: 'leads', label: 'Leads', money: false, note: 'Sources, close rate, response time.' },
        { key: 'clients', label: 'By client', money: true, note: 'Volume and value per wholesale account.' }
      ],
      caps: ctx.caps
    };
  });

  /* ------------------------------------------------------------ production */

  app.get('/api/reports/production', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'reports', reply)) return;
    if (!ctx.caps.viewReports) return reply.code(403).send({ error: 'Not permitted' });

    const r = resolveWindow(req.query as never);
    const s = scope(r);

    const byLane = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COALESCE(l.label, 'Not in a lane') AS lane,
             COUNT(*) AS files,
             SUM(r.on_hold = 1) AS on_hold,
             AVG(DATEDIFF(COALESCE(r.delivered_at, NOW()), r.opened_at)) AS avg_days,
             SUM(TIMESTAMPDIFF(HOUR, r.status_since, NOW()) >= COALESCE(st.age_red_hours, 999999)) AS stalled,
             SUM(r.labor_hours) AS hours
      FROM repair_orders r
      LEFT JOIN statuses st ON st.slot_id = r.status_slot
      LEFT JOIN lanes l ON l.lane_key = st.lane_key
      WHERE ${s.sql}
      GROUP BY COALESCE(l.label, 'Not in a lane'), l.sort_order
      ORDER BY l.sort_order`, s.params);

    const blocked = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT r.id, r.ro_number, st.label AS status_label,
             DATEDIFF(NOW(), r.opened_at) AS days_in_shop,
             TIMESTAMPDIFF(HOUR, r.status_since, NOW()) AS hours_in_status,
             r.hold_reason, r.on_hold,
             c.name AS customer_name,
             CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle,
             (SELECT COUNT(*) FROM parts_lines p WHERE p.ro_id = r.id AND p.gating = 1
                AND p.state IN ('need','ordered','partial','backordered')) AS parts_waiting
      FROM repair_orders r
      LEFT JOIN statuses st ON st.slot_id = r.status_slot
      LEFT JOIN clients c ON c.id = r.client_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.closed_at IS NULL
        AND (r.on_hold = 1
             OR TIMESTAMPDIFF(HOUR, r.status_since, NOW()) >= COALESCE(st.age_red_hours, 999999))
      ORDER BY hours_in_status DESC
      LIMIT 40`);

    const [totals] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COUNT(*) AS files,
             SUM(r.closed_at IS NULL) AS open_files,
             SUM(r.delivered_at IS NOT NULL) AS delivered,
             SUM(r.labor_hours) AS hours,
             AVG(DATEDIFF(COALESCE(r.delivered_at, NOW()), r.opened_at)) AS avg_days
      FROM repair_orders r WHERE ${s.sql}`, s.params);

    return {
      window: r,
      totals: {
        files: Number(totals.files ?? 0),
        openFiles: Number(totals.open_files ?? 0),
        delivered: Number(totals.delivered ?? 0),
        hours: Number(totals.hours ?? 0),
        avgDays: totals.avg_days === null ? null : Math.round(Number(totals.avg_days) * 10) / 10
      },
      byLane, blocked
    };
  });

  /* ----------------------------------------------------------- cycle time */

  app.get('/api/reports/cycle', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewReports) return reply.code(403).send({ error: 'Not permitted' });

    const r = resolveWindow(req.query as never);
    const s = scope(r);

    // Keys to cycle: total days in shop, and touch time = hours in statuses
    // flagged as counting toward cycle. The gap between them is the wait.
    const files = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT r.id, r.ro_number, r.opened_at, r.delivered_at, r.approved_at,
             DATEDIFF(COALESCE(r.delivered_at, NOW()), r.opened_at) AS days_in_shop,
             DATEDIFF(COALESCE(r.delivered_at, NOW()), COALESCE(r.approved_at, r.opened_at)) AS days_since_approval,
             r.labor_hours,
             c.name AS customer_name,
             CONCAT_WS(' ', v.year, v.make, v.model) AS vehicle,
             r.repair_path
      FROM repair_orders r
      LEFT JOIN clients c ON c.id = r.client_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE ${s.sql}
      ORDER BY days_in_shop DESC
      LIMIT 300`, s.params);

    const byStatus = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT st.label AS status_label, st.counts_toward_cycle,
             COUNT(*) AS visits,
             AVG(TIMESTAMPDIFF(HOUR, h.created_at, COALESCE(nxt.created_at, NOW()))) AS avg_hours,
             MAX(TIMESTAMPDIFF(HOUR, h.created_at, COALESCE(nxt.created_at, NOW()))) AS worst_hours
      FROM ro_status_history h
      JOIN repair_orders r ON r.id = h.ro_id
      LEFT JOIN statuses st ON st.slot_id = h.to_slot
      LEFT JOIN ro_status_history nxt
        ON nxt.ro_id = h.ro_id AND nxt.id = (
          SELECT MIN(x.id) FROM ro_status_history x WHERE x.ro_id = h.ro_id AND x.id > h.id)
      WHERE ${s.sql}
      GROUP BY st.label, st.counts_toward_cycle, st.sort_order
      HAVING visits > 0
      ORDER BY avg_hours DESC
      LIMIT 40`, s.params);

    const byPath = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT r.repair_path,
             COUNT(*) AS files,
             AVG(DATEDIFF(COALESCE(r.delivered_at, NOW()), r.opened_at)) AS avg_days,
             AVG(r.labor_hours) AS avg_hours
      FROM repair_orders r WHERE ${s.sql}
      GROUP BY r.repair_path`, s.params);

    const touch = files.reduce((a, f) => a + Number(f.labor_hours ?? 0), 0);
    const days = files.reduce((a, f) => a + Number(f.days_in_shop ?? 0), 0);

    return {
      window: r,
      totals: {
        files: files.length,
        avgDays: files.length ? Math.round((days / files.length) * 10) / 10 : null,
        avgTouchHours: files.length ? Math.round((touch / files.length) * 10) / 10 : null,
        // Days in shop for every flagged hour of work — the number that shows
        // how much of the cycle is waiting rather than working.
        daysPerHour: touch ? Math.round((days / touch) * 100) / 100 : null
      },
      files, byStatus, byPath
    };
  });

  /* ----------------------------------------------------------- technician */

  app.get('/api/reports/technician', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewReports) return reply.code(403).send({ error: 'Not permitted' });

    const r = resolveWindow(req.query as never);
    const s = scope(r);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT a.user_id, a.position_key,
             COALESCE(sf.display_name, a.display_name, 'Unassigned') AS name,
             p.label AS position_label,
             sf.efficiency,
             COUNT(DISTINCT a.ro_id) AS files,
             SUM(r.labor_hours) AS flagged_hours,
             AVG(DATEDIFF(COALESCE(r.delivered_at, NOW()), r.opened_at)) AS avg_days,
             SUM(r.closed_at IS NULL) AS open_files
      FROM ro_assignments a
      JOIN repair_orders r ON r.id = a.ro_id
      LEFT JOIN staff sf ON sf.user_id = a.user_id
      LEFT JOIN positions p ON p.position_key = a.position_key
      WHERE ${s.sql} AND a.position_key <> 'sales'
      GROUP BY a.user_id, a.position_key, name, p.label, sf.efficiency, p.sort_order
      ORDER BY p.sort_order, flagged_hours DESC`, s.params);

    const rework = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COALESCE(sf.display_name, h.user_name, 'unknown') AS name,
             COUNT(*) AS rework_moves
      FROM ro_status_history h
      JOIN repair_orders r ON r.id = h.ro_id
      LEFT JOIN staff sf ON sf.user_id = h.user_id
      WHERE ${s.sql} AND h.is_rework = 1
      GROUP BY name ORDER BY rework_moves DESC LIMIT 20`, s.params);

    return {
      window: r,
      technicians: rows.map(t => ({
        ...t,
        flagged_hours: Number(t.flagged_hours ?? 0),
        avg_days: t.avg_days === null ? null : Math.round(Number(t.avg_days) * 10) / 10,
        // Flagged hours produced per file — a rough read on throughput until
        // clocked hours arrive from a time clock.
        hours_per_file: Number(t.files) ? Math.round((Number(t.flagged_hours ?? 0) / Number(t.files)) * 10) / 10 : null
      })),
      rework
    };
  });

  /* --------------------------------------------------------------- status */

  app.get('/api/reports/status', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewReports) return reply.code(403).send({ error: 'Not permitted' });

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT st.slot_id, st.label, st.owner_role, g.label AS group_label,
             st.age_yellow_hours, st.age_red_hours,
             COUNT(r.id) AS files,
             AVG(TIMESTAMPDIFF(HOUR, r.status_since, NOW())) AS avg_hours,
             MAX(TIMESTAMPDIFF(HOUR, r.status_since, NOW())) AS worst_hours,
             SUM(TIMESTAMPDIFF(HOUR, r.status_since, NOW()) >= COALESCE(st.age_red_hours, 999999)) AS over_red
      FROM statuses st
      JOIN status_groups g ON g.group_id = st.group_id
      LEFT JOIN repair_orders r ON r.status_slot = st.slot_id AND r.closed_at IS NULL
      GROUP BY st.slot_id, st.label, st.owner_role, g.label, st.age_yellow_hours,
               st.age_red_hours, g.sort_order, st.sort_order
      HAVING files > 0
      ORDER BY g.sort_order, st.sort_order`);

    const byOwner = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT st.owner_role, COUNT(r.id) AS files,
             SUM(TIMESTAMPDIFF(HOUR, r.status_since, NOW()) >= COALESCE(st.age_red_hours, 999999)) AS over_red
      FROM statuses st
      JOIN repair_orders r ON r.status_slot = st.slot_id AND r.closed_at IS NULL
      GROUP BY st.owner_role ORDER BY files DESC`);

    return { statuses: rows, byOwner };
  });

  /* ---------------------------------------------------------------- money */

  app.get('/api/reports/revenue', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewMoneyReports) return reply.code(403).send({ error: 'Not permitted' });

    const r = resolveWindow(req.query as never);
    const s = scope(r);

    const [tot] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COUNT(*) AS files,
             COALESCE(SUM(r.amount_cents), 0) AS gross_cents,
             COALESCE(SUM(r.parts_cost_cents), 0) AS parts_cents,
             COALESCE(SUM(r.sublet_cost_cents), 0) AS sublet_cents,
             COALESCE(SUM(r.deductible_cents), 0) AS deductible_cents,
             COALESCE(SUM(r.labor_hours), 0) AS hours,
             AVG(r.amount_cents) AS avg_ticket
      FROM repair_orders r WHERE ${s.sql}`, s.params);

    const byType = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT r.ro_type, COUNT(*) AS files,
             COALESCE(SUM(r.amount_cents), 0) AS gross_cents,
             AVG(r.amount_cents) AS avg_ticket
      FROM repair_orders r WHERE ${s.sql}
      GROUP BY r.ro_type ORDER BY gross_cents DESC`, s.params);

    const byMonth = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT DATE_FORMAT(r.opened_at, '%Y-%m') AS month,
             COUNT(*) AS files,
             COALESCE(SUM(r.amount_cents), 0) AS gross_cents,
             COALESCE(SUM(r.labor_hours), 0) AS hours
      FROM repair_orders r
      WHERE r.opened_at > DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
      GROUP BY month ORDER BY month`);

    const supplements = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COUNT(*) AS n,
             COALESCE(SUM(sp.requested_cents), 0) AS requested_cents,
             COALESCE(SUM(sp.approved_cents), 0) AS approved_cents,
             AVG(DATEDIFF(sp.decided_at, sp.sent_at)) AS avg_days_to_decide
      FROM supplements sp JOIN repair_orders r ON r.id = sp.ro_id
      WHERE ${s.sql} AND sp.seq > 0`, s.params);

    const gross = Number(tot.gross_cents ?? 0);
    const cost = Number(tot.parts_cents ?? 0) + Number(tot.sublet_cents ?? 0);

    // Parts margin from real vendor cost, not inferred from the estimate.
    const [pm] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COALESCE(SUM(p.price_cents * p.qty), 0) AS list_cents,
             COALESCE(SUM(p.cost_cents * p.qty), 0) AS cost_cents
      FROM parts_lines p JOIN repair_orders r ON r.id = p.ro_id
      WHERE ${s.sql} AND p.state <> 'not_needed'`, s.params);

    return {
      window: r,
      totals: {
        files: Number(tot.files ?? 0),
        grossCents: gross,
        partsCents: Number(tot.parts_cents ?? 0),
        subletCents: Number(tot.sublet_cents ?? 0),
        deductibleCents: Number(tot.deductible_cents ?? 0),
        hours: Number(tot.hours ?? 0),
        avgTicketCents: tot.avg_ticket === null ? 0 : Math.round(Number(tot.avg_ticket)),
        grossProfitCents: gross - cost,
        effectiveRateCents: Number(tot.hours) ? Math.round((gross - cost) / Number(tot.hours)) : null,
        partsListCents: Number(pm.list_cents ?? 0),
        partsCostCents: Number(pm.cost_cents ?? 0),
        partsMarginPct: Number(pm.list_cents)
          ? Math.round(((Number(pm.list_cents) - Number(pm.cost_cents)) / Number(pm.list_cents)) * 100)
          : null
      },
      byType, byMonth,
      supplements: {
        n: Number(supplements[0]?.n ?? 0),
        requestedCents: Number(supplements[0]?.requested_cents ?? 0),
        approvedCents: Number(supplements[0]?.approved_cents ?? 0),
        avgDaysToDecide: supplements[0]?.avg_days_to_decide === null
          ? null : Math.round(Number(supplements[0]?.avg_days_to_decide) * 10) / 10
      }
    };
  });

  app.get('/api/reports/salesperson', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewMoneyReports) return reply.code(403).send({ error: 'Not permitted' });

    const r = resolveWindow(req.query as never);
    const s = scope(r);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COALESCE(sf.display_name, a.display_name, 'Unassigned') AS name,
             sf.commission_rate,
             COUNT(DISTINCT r.id) AS files,
             COALESCE(SUM(r.amount_cents), 0) AS gross_cents,
             AVG(r.amount_cents) AS avg_ticket,
             SUM(r.closed_at IS NULL) AS open_files,
             SUM(r.ro_type = 'wholesale') AS wholesale_files
      FROM repair_orders r
      JOIN ro_assignments a ON a.ro_id = r.id AND a.position_key = 'sales'
      LEFT JOIN staff sf ON sf.user_id = a.user_id
      WHERE ${s.sql}
      GROUP BY name, sf.commission_rate
      ORDER BY gross_cents DESC`, s.params);

    const leads = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT l.owner_user_id, COALESCE(sf.display_name, 'Unassigned') AS name,
             COUNT(*) AS leads,
             SUM(l.state = 'won') AS won,
             SUM(l.state = 'lost') AS lost
      FROM leads l LEFT JOIN staff sf ON sf.user_id = l.owner_user_id
      WHERE l.received_at >= ? AND l.received_at < DATE_ADD(?, INTERVAL 1 DAY)
      GROUP BY l.owner_user_id, name ORDER BY leads DESC`,
      [r.from, r.to]);

    return { window: r, salespeople: rows, leads };
  });

  app.get('/api/reports/approval', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewMoneyReports) return reply.code(403).send({ error: 'Not permitted' });

    const r = resolveWindow(req.query as never);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT DATE(r.approved_at) AS day,
             COUNT(*) AS files,
             COALESCE(SUM(r.amount_cents), 0) AS gross_cents,
             COALESCE(SUM(r.labor_hours), 0) AS hours
      FROM repair_orders r
      WHERE r.approved_at IS NOT NULL
        AND r.approved_at >= ? AND r.approved_at < DATE_ADD(?, INTERVAL 1 DAY)
      GROUP BY DATE(r.approved_at) ORDER BY day DESC`, [r.from, r.to]);

    const waiting = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT r.id, r.ro_number, r.amount_cents, st.label AS status_label,
             DATEDIFF(NOW(), r.opened_at) AS days_in_shop,
             ins.name AS insurer_name,
             c.name AS customer_name
      FROM repair_orders r
      LEFT JOIN statuses st ON st.slot_id = r.status_slot
      LEFT JOIN clients ins ON ins.id = r.insurer_client_id
      LEFT JOIN clients c ON c.id = r.client_id
      WHERE r.closed_at IS NULL AND r.approved_at IS NULL
      ORDER BY days_in_shop DESC LIMIT 50`);

    return { window: r, days: rows, waiting };
  });

  app.get('/api/reports/clients', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewMoneyReports) return reply.code(403).send({ error: 'Not permitted' });

    const r = resolveWindow(req.query as never);
    const s = scope(r);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT c.id, c.name, c.kind, c.wholesale_type, c.terms,
             COUNT(r.id) AS files,
             COALESCE(SUM(r.amount_cents), 0) AS gross_cents,
             AVG(r.amount_cents) AS avg_ticket,
             AVG(DATEDIFF(COALESCE(r.delivered_at, NOW()), r.opened_at)) AS avg_days,
             SUM(r.closed_at IS NULL) AS open_files
      FROM clients c
      JOIN repair_orders r ON r.client_id = c.id
      WHERE ${s.sql}
      GROUP BY c.id, c.name, c.kind, c.wholesale_type, c.terms
      ORDER BY gross_cents DESC`, s.params);

    return { window: r, clients: rows };
  });

  app.get('/api/reports/leads', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewReports) return reply.code(403).send({ error: 'Not permitted' });

    const r = resolveWindow(req.query as never);

    const bySource = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT source, COUNT(*) AS leads,
             SUM(state = 'won') AS won, SUM(state = 'lost') AS lost,
             AVG(TIMESTAMPDIFF(HOUR, received_at, first_reply_at)) AS avg_reply_hours
      FROM leads
      WHERE received_at >= ? AND received_at < DATE_ADD(?, INTERVAL 1 DAY)
      GROUP BY source ORDER BY leads DESC`, [r.from, r.to]);

    const lost = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COALESCE(lost_reason, 'Not recorded') AS reason, COUNT(*) AS n
      FROM leads
      WHERE state = 'lost' AND received_at >= ? AND received_at < DATE_ADD(?, INTERVAL 1 DAY)
      GROUP BY reason ORDER BY n DESC`, [r.from, r.to]);

    return { window: r, bySource, lostReasons: lost };
  });
}
