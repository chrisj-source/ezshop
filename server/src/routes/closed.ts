import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { scrubMoney } from '../permissions';

/**
 * Closing a file.
 *
 * `closed_at` already took a file off the board and the dates block calls it
 * "date picked up". Closing is a separate act: it puts the approval amount on
 * the books, and the date it books to is set by hand — `close_date`. A car
 * finished in April and paid in May can be booked to either, and the date can be
 * changed afterwards from the closed board, which re-books it into that month,
 * week and day. Everything on this screen and in the closed report reads
 * `close_date`, never a production date.
 *
 * The approval amount is a hard check. Parts still on order and a sublet not yet
 * returned block the close too rather than warning past it — a file closed with
 * money still going out the door is the thing this is meant to prevent.
 */

const LOOSE_ENDS = `
  (SELECT COUNT(*) FROM parts_lines p
    WHERE p.ro_id = r.id AND p.state IN ('ordered','partial','backordered')) AS parts_open,
  (SELECT COUNT(*) FROM sublets sb
    WHERE sb.ro_id = r.id AND sb.state IN ('scheduled','out')) AS sublets_open`;

interface ClosedRow extends RowDataPacket {
  id: number;
  ro_number: string;
  amount_cents: number;
  paid: number;
  close_date: string;
  opened_at: string;
  days_in_shop: number;
  customer: string | null;
  vehicle: string | null;
  colour: string | null;
  salesperson: string | null;
  insurer: string | null;
  pay_type: string;
}

function isDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Cash-pay is the absence of an insurer, which is how the rest of the app reads it. */
const PAY_TYPE = `IF(r.insurer_client_id IS NULL, 'cash', 'insurance')`;

export async function registerClosed(app: FastifyInstance): Promise<void> {

  /**
   * What the close modal needs before it opens: the amount it will book, and
   * anything that stops the close. The screen shows the blockers rather than
   * finding out on submit.
   */
  app.get('/api/ro/:id/close-check', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.closeRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const row = await tqOne<RowDataPacket>(ctx.company!.id, `
      SELECT r.id, r.ro_number, r.amount_cents, r.close_date, r.voided_at,
             r.delivered_at, r.insurer_client_id, ${PAY_TYPE} AS pay_type,
             ${LOOSE_ENDS}
      FROM repair_orders r WHERE r.id = ?`, [id]);
    if (!row) return reply.code(404).send({ error: 'No such repair order' });

    return {
      roNumber: row.ro_number,
      amountCents: ctx.caps.money ? Number(row.amount_cents) : null,
      payType: row.pay_type,
      alreadyClosed: row.close_date !== null,
      voided: row.voided_at !== null,
      blockers: blockersFor(row),
      suggestedDate: suggestDate(row)
    };
  });

  /**
   * Close it. Marks paid or not — taking payments properly comes later, this is
   * the flag — takes the file off the production schedule and books the amount
   * to the close date.
   */
  app.post('/api/ro/:id/close', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'board', reply)) return;
    if (!ctx.caps.closeRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const b = req.body as { paid?: boolean; closeDate?: string; note?: string };
    const cid = ctx.company!.id;

    if (b.closeDate !== undefined && !isDate(b.closeDate)) {
      return reply.code(400).send({ error: 'The close date is not a date.' });
    }

    interface CloseResult {
      code: 200 | 400 | 404;
      error?: string;
      blockers?: Array<{ what: string; where: string }>;
      closeDate?: string;
      paid?: boolean;
    }

    const result = await withTenantTx<CloseResult>(cid, async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(`
        SELECT r.id, r.ro_number, r.amount_cents, r.close_date, r.voided_at,
               r.delivered_at, r.status_slot, ${LOOSE_ENDS}
        FROM repair_orders r WHERE r.id = ? FOR UPDATE`, [id]);
      const ro = rows[0];
      if (!ro) return { code: 404, error: 'No such repair order' };
      if (ro.voided_at) return { code: 400, error: 'This file is voided.' };
      if (ro.close_date) return { code: 400, error: `RO ${ro.ro_number} is already closed.` };

      const blockers = blockersFor(ro);
      if (blockers.length) {
        return {
          code: 400,
          error: blockers.length === 1 ? blockers[0].what : 'Three things first: ' + blockers.map(x => x.what).join(' '),
          blockers
        };
      }

      const paid = b.paid === true;
      const date = isDate(b.closeDate) ? b.closeDate : suggestDate(ro);

      await c.query(`
        UPDATE repair_orders
        SET close_date = ?, closed_by = ?, paid = ?, paid_at = IF(? = 1, NOW(), NULL),
            closed_at = COALESCE(closed_at, NOW())
        WHERE id = ?`,
        [date, ctx.user.id, paid ? 1 : 0, paid ? 1 : 0, id]);

      await c.query(
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [id, `File closed, booked to ${date}. Marked ${paid ? 'paid' : 'not paid'}.` +
             (b.note && b.note.trim() ? ` ${b.note.trim()}` : ''),
         ctx.user.id, ctx.user.name]);

      await c.query(
        `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
         VALUES (?, ?, 'repair_order', ?, 'close', ?)`,
        [ctx.user.id, ctx.user.name, id, JSON.stringify({ closeDate: date, paid })]);

      return { code: 200, closeDate: date, paid };
    });

    if (result.code !== 200) {
      return reply.code(result.code).send({ error: result.error, blockers: result.blockers });
    }
    return { ok: true, closeDate: result.closeDate, paid: result.paid };
  });

  /**
   * Adjust a closed file: move its close date, or change whether it is paid.
   * Moving the date is the whole point of the date being manual, so it is a
   * first-class edit rather than a correction.
   */
  app.patch('/api/ro/:id/close', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.closeRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const b = req.body as { closeDate?: string; paid?: boolean };
    const cid = ctx.company!.id;

    const before = await tqOne<RowDataPacket>(cid,
      `SELECT ro_number, close_date, paid FROM repair_orders WHERE id = ?`, [id]);
    if (!before) return reply.code(404).send({ error: 'No such repair order' });
    if (!before.close_date) return reply.code(400).send({ error: 'This file is not closed.' });

    const sets: string[] = [];
    const vals: unknown[] = [];
    const said: string[] = [];

    if (b.closeDate !== undefined) {
      if (!isDate(b.closeDate)) return reply.code(400).send({ error: 'The close date is not a date.' });
      const was = String(before.close_date).slice(0, 10);
      if (was !== b.closeDate) {
        sets.push('close_date = ?');
        vals.push(b.closeDate);
        said.push(`Close date moved from ${was} to ${b.closeDate}`);
      }
    }

    if (b.paid !== undefined && (before.paid === 1) !== b.paid) {
      sets.push('paid = ?', 'paid_at = IF(? = 1, NOW(), NULL)');
      vals.push(b.paid ? 1 : 0, b.paid ? 1 : 0);
      said.push(b.paid ? 'Marked paid' : 'Marked not paid');
    }

    if (!sets.length) return { ok: true, changed: false };

    vals.push(id);
    await texec(cid, `UPDATE repair_orders SET ${sets.join(', ')} WHERE id = ?`, vals);
    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, said.join('. ') + '.', ctx.user.id, ctx.user.name]);
    await texec(cid,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (?, ?, 'repair_order', ?, 'close_edit', ?)`,
      [ctx.user.id, ctx.user.name, id, JSON.stringify({ changes: said })]);

    return { ok: true, changed: true };
  });

  /**
   * Un-close. Owner only, because it takes money back off the books and puts the
   * car back on the production schedule.
   */
  app.delete('/api/ro/:id/close', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.roles.includes('owner')) return reply.code(403).send({ error: 'Owner only' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const before = await tqOne<RowDataPacket>(cid,
      `SELECT ro_number, close_date FROM repair_orders WHERE id = ?`, [id]);
    if (!before) return reply.code(404).send({ error: 'No such repair order' });
    if (!before.close_date) return reply.code(400).send({ error: 'This file is not closed.' });

    await texec(cid, `
      UPDATE repair_orders
      SET close_date = NULL, closed_by = NULL, paid = 0, paid_at = NULL, closed_at = NULL
      WHERE id = ?`, [id]);
    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, `File reopened — was closed to ${String(before.close_date).slice(0, 10)}. Back on the production schedule.`,
       ctx.user.id, ctx.user.name]);
    await texec(cid,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (?, ?, 'repair_order', ?, 'close_undo', ?)`,
      [ctx.user.id, ctx.user.name, id, JSON.stringify({ was: before.close_date })]);

    return { ok: true };
  });

  /**
   * The closed board. Sorts like the production board; a flat list by default
   * with grouping by payment as a toggle on the screen, so the sort and the
   * grouping do not fight — sorting inside a group is the client's business.
   */
  app.get('/api/closed', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'board', reply)) return;
    if (!ctx.caps.closeRepairOrders && !ctx.caps.viewReports) {
      return reply.code(403).send({ error: 'Not permitted' });
    }

    const q = req.query as { from?: string; to?: string; paid?: string; sort?: string };
    const to = isDate(q.to) ? q.to : new Date().toISOString().slice(0, 10);
    const from = isDate(q.from) ? q.from : to.slice(0, 8) + '01';

    const paidClause = q.paid === 'paid' ? ' AND r.paid = 1'
      : q.paid === 'unpaid' ? ' AND r.paid = 0' : '';

    const SORTS: Record<string, string> = {
      close_date: 'r.close_date DESC, r.ro_number DESC',
      ro: 'r.ro_number DESC',
      amount: 'r.amount_cents DESC',
      days: 'days_in_shop DESC',
      opened: 'r.opened_at DESC',
      customer: 'customer ASC',
      salesperson: 'salesperson ASC'
    };
    const order = SORTS[q.sort ?? 'close_date'] ?? SORTS.close_date;

    const rows = await tq<ClosedRow[]>(ctx.company!.id, `
      SELECT r.id, r.ro_number, r.amount_cents, r.paid, r.paid_at, r.close_date,
             r.opened_at, ${PAY_TYPE} AS pay_type,
             GREATEST(DATEDIFF(COALESCE(r.delivered_at, r.close_date), DATE(r.opened_at)) - r.voided_days, 0) AS days_in_shop,
             c.name AS customer,
             TRIM(CONCAT(COALESCE(v.year,''), ' ', COALESCE(v.make,''), ' ', COALESCE(v.model,''))) AS vehicle,
             v.color AS colour,
             ic.name AS insurer,
             (SELECT a.display_name FROM ro_assignments a
               WHERE a.ro_id = r.id AND a.position_key = 'sales' LIMIT 1) AS salesperson
      FROM repair_orders r
      LEFT JOIN clients c   ON c.id = r.client_id
      LEFT JOIN clients ic  ON ic.id = r.insurer_client_id
      LEFT JOIN vehicles v  ON v.id = r.vehicle_id
      WHERE r.close_date IS NOT NULL AND r.voided_at IS NULL
        AND r.close_date >= ? AND r.close_date <= ?${paidClause}
      ORDER BY ${order}
    `, [from, to]);

    const total = rows.reduce((n, r) => n + Number(r.amount_cents), 0);
    const unpaid = rows.filter(r => r.paid === 0);

    return {
      from, to,
      rows: rows.map(r => scrubMoney({ ...r, paid: r.paid === 1 }, ctx.caps)),
      totals: ctx.caps.money ? {
        files: rows.length,
        totalCents: total,
        unpaidFiles: unpaid.length,
        unpaidCents: unpaid.reduce((n, r) => n + Number(r.amount_cents), 0),
        paidCents: total - unpaid.reduce((n, r) => n + Number(r.amount_cents), 0)
      } : { files: rows.length }
    };
  });

  /**
   * Closed is its own report, keyed on close date. Four cuts: month, week,
   * salesperson, and insurance against cash-pay. Unpaid is a column rather than
   * a subtraction, so the books and the chase list read off one figure.
   */
  app.get('/api/reports/closed', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewMoneyReports) return reply.code(403).send({ error: 'Not permitted' });

    const q = req.query as { cut?: string; from?: string; to?: string };
    const to = isDate(q.to) ? q.to : new Date().toISOString().slice(0, 10);
    const from = isDate(q.from) ? q.from : `${to.slice(0, 4)}-01-01`;

    const CUTS: Record<string, { key: string; label: string; order: string }> = {
      month: { key: `DATE_FORMAT(r.close_date, '%Y-%m')`, label: 'Month', order: 'k ASC' },
      week: { key: `DATE_FORMAT(DATE_SUB(r.close_date, INTERVAL WEEKDAY(r.close_date) DAY), '%Y-%m-%d')`, label: 'Week beginning', order: 'k ASC' },
      sales: {
        key: `COALESCE((SELECT a.display_name FROM ro_assignments a
                WHERE a.ro_id = r.id AND a.position_key = 'sales' LIMIT 1), 'Unassigned')`,
        label: 'Salesperson', order: 'total_cents DESC'
      },
      type: { key: PAY_TYPE, label: 'Pay type', order: 'total_cents DESC' }
    };
    const cut = CUTS[q.cut ?? 'month'] ?? CUTS.month;

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT ${cut.key} AS k,
             COUNT(*) AS files,
             SUM(r.amount_cents) AS total_cents,
             SUM(IF(r.insurer_client_id IS NULL, 0, r.amount_cents)) AS insurance_cents,
             SUM(IF(r.insurer_client_id IS NULL, r.amount_cents, 0)) AS cash_cents,
             SUM(IF(r.paid = 0, r.amount_cents, 0)) AS unpaid_cents,
             SUM(IF(r.paid = 0, 1, 0)) AS unpaid_files,
             ROUND(AVG(GREATEST(DATEDIFF(COALESCE(r.delivered_at, r.close_date), DATE(r.opened_at)) - r.voided_days, 0))) AS avg_days
      FROM repair_orders r
      WHERE r.close_date IS NOT NULL AND r.voided_at IS NULL
        AND r.close_date >= ? AND r.close_date <= ?
      GROUP BY k
      ORDER BY ${cut.order}
    `, [from, to]);

    const sum = (f: string) => rows.reduce((n, r) => n + Number(r[f] ?? 0), 0);

    return {
      cut: q.cut ?? 'month',
      cutLabel: cut.label,
      from, to,
      rows,
      total: {
        files: sum('files'),
        totalCents: sum('total_cents'),
        insuranceCents: sum('insurance_cents'),
        cashCents: sum('cash_cents'),
        unpaidCents: sum('unpaid_cents'),
        unpaidFiles: sum('unpaid_files')
      },
      cuts: [
        { key: 'month', label: 'By month' },
        { key: 'week', label: 'By week' },
        { key: 'sales', label: 'By salesperson' },
        { key: 'type', label: 'Insurance vs cash-pay' }
      ]
    };
  });

  /**
   * Every live sublet line in the shop, for the list under the board. The lane
   * says where the car is; this says what is owed and to whom. Invoiced lines
   * drop off — they are the accounting side's business, not the chase list's.
   */
  app.get('/api/sublets', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'board', reply)) return;

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT sb.id, sb.ro_id, sb.service, sb.vendor, sb.state, sb.out_at, sb.back_at,
             sb.cost_cents, sb.po_number,
             r.ro_number, s.label AS status_label, s.lane_key,
             TRIM(CONCAT(COALESCE(v.year,''), ' ', COALESCE(v.make,''), ' ', COALESCE(v.model,''))) AS vehicle,
             v.color AS colour
      FROM sublets sb
      JOIN repair_orders r ON r.id = sb.ro_id
      LEFT JOIN statuses s ON s.slot_id = r.status_slot
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      WHERE sb.state <> 'invoiced'
        AND r.voided_at IS NULL AND r.close_date IS NULL
      ORDER BY FIELD(sb.state, 'scheduled', 'out', 'returned'), sb.out_at IS NULL DESC, sb.out_at ASC
    `);

    return {
      rows: rows.map(r => scrubMoney(r, ctx.caps)),
      needed: rows.filter(r => r.state === 'scheduled').length,
      noVendor: rows.filter(r => !r.vendor).length,
      out: rows.filter(r => r.state === 'out').length
    };
  });
}

/** What stops a close. The approval amount is the hard one; the other two catch a file being closed while money is still going out. */
function blockersFor(ro: RowDataPacket): Array<{ what: string; where: string }> {
  const out: Array<{ what: string; where: string }> = [];
  if (!Number(ro.amount_cents)) {
    out.push({ what: 'No approval amount on the file.', where: 'Money block' });
  }
  const parts = Number(ro.parts_open ?? 0);
  if (parts) {
    out.push({
      what: `${parts} parts line${parts === 1 ? '' : 's'} still on order.`,
      where: 'Parts screen'
    });
  }
  const sub = Number(ro.sublets_open ?? 0);
  if (sub) {
    out.push({
      what: `${sub} sublet${sub === 1 ? '' : 's'} not returned.`,
      where: 'Sublet block on the file'
    });
  }
  return out;
}

/** Default the modal to the delivery date if there is one, otherwise today. */
function suggestDate(ro: RowDataPacket): string {
  if (ro.delivered_at) return String(ro.delivered_at).slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}
