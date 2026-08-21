import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { notify } from '../notify';
import { scrubMoney } from '../permissions';
import { audit, diff } from '../lib/audit';
import { actorFrom } from './audit';

/**
 * Parts profit is margin on list — what the shop keeps of the list price.
 * A line under this reads thin on the parts screen. Shop setting eventually.
 */
const THIN_MARGIN_PCT = 20;

/** What a vendor is to the shop. Sublet vendors sit in the same list. */
const VENDOR_KINDS = ['OEM dealer', 'Aftermarket', 'Recycled / LKQ', 'Glass', 'Paint / materials', 'Sublet'];

function marginPct(listCents: number, costCents: number): number | null {
  if (!listCents) return null;
  return Math.round(((listCents - costCents) / listCents) * 100);
}

/** Keeps the file's sublet figure equal to the sublet lines on it. */
async function recomputeSubletCost(cid: number, roId: number): Promise<void> {
  await texec(cid, `
    UPDATE repair_orders r SET r.sublet_cost_cents = (
      SELECT COALESCE(SUM(s.cost_cents), 0) FROM sublets s WHERE s.ro_id = r.id
    ) WHERE r.id = ?`, [roId]);
}

/** Keeps the file's parts cost equal to what was actually ordered. */
async function recomputePartsCost(cid: number, roId: number): Promise<void> {
  await texec(cid, `
    UPDATE repair_orders r SET r.parts_cost_cents = (
      SELECT COALESCE(SUM(IF(p.cost_cents > 0, p.cost_cents, p.price_cents) * p.qty), 0)
      FROM parts_lines p
      WHERE p.ro_id = r.id AND p.state <> 'not_needed'
    ) WHERE r.id = ?`, [roId]);
}

export async function registerParts(app: FastifyInstance): Promise<void> {

  /** Every gating part across the shop — the parts desk's working list. */
  app.get('/api/parts', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'parts', reply)) return;

    const q = req.query as { state?: string; roId?: string };
    const where: string[] = ['r.closed_at IS NULL', 'r.voided_at IS NULL'];
    const params: unknown[] = [];

    if (q.state) { where.push('p.state = ?'); params.push(q.state); }
    if (q.roId) { where.push('p.ro_id = ?'); params.push(Number(q.roId)); }

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT p.*, v.name AS vendor_name, r.ro_number, r.id AS ro_id,
             r.opened_at, r.target_days,
             DATEDIFF(NOW(), r.opened_at) AS days_in_shop,
             c.name AS customer_name,
             CONCAT_WS(' ', veh.year, veh.make, veh.model) AS vehicle,
             veh.color, veh.vin,
             RIGHT(veh.vin, 8) AS vin_last8,
             s.label AS status_label, s.lane_key,
             DATEDIFF(CURDATE(), p.eta) AS days_late,
             DATEDIFF(NOW(), p.ordered_at) AS days_since_ordered
      FROM parts_lines p
      JOIN repair_orders r ON r.id = p.ro_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN clients c ON c.id = r.client_id
      LEFT JOIN vehicles veh ON veh.id = r.vehicle_id
      LEFT JOIN statuses s ON s.slot_id = r.status_slot
      WHERE ${where.join(' AND ')}
      ORDER BY (p.eta IS NULL), p.eta, p.id
    `, params);

    const vendors = await tq<RowDataPacket[]>(ctx.company!.id,
      'SELECT id, name, kind, phone FROM vendors WHERE active = 1 ORDER BY name');

    const [summary] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT
        COALESCE(SUM(p.price_cents * p.qty), 0) AS list_cents,
        COALESCE(SUM(p.cost_cents * p.qty), 0) AS cost_cents,
        SUM(p.state = 'need') AS needed,
        SUM(p.state = 'ordered') AS ordered,
        SUM(p.state = 'backordered') AS backordered,
        SUM(p.state IN ('ordered','partial') AND p.eta < CURDATE()) AS late,
        COUNT(DISTINCT IF(p.gating = 1 AND p.state IN ('need','ordered','partial','backordered'), p.ro_id, NULL)) AS files_waiting
      FROM parts_lines p JOIN repair_orders r ON r.id = p.ro_id
      WHERE r.closed_at IS NULL AND r.voided_at IS NULL
    `);

    /* Parts profit: margin on list, over the open lines of each file. Derived,
       never stored. Money capabilities cover the parts desk. */
    const perRo = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT p.ro_id,
             COALESCE(SUM(p.price_cents * p.qty), 0) AS list_cents,
             COALESCE(SUM(p.cost_cents  * p.qty), 0) AS cost_cents,
             SUM(p.price_cents > 0 AND (p.price_cents - p.cost_cents) * 100 < p.price_cents * ?) AS thin_lines
      FROM parts_lines p JOIN repair_orders r ON r.id = p.ro_id
      WHERE r.closed_at IS NULL AND r.voided_at IS NULL
        AND p.state IN ('need','ordered','partial','backordered')
      GROUP BY p.ro_id`, [THIN_MARGIN_PCT]);

    const listC = Number(summary.list_cents ?? 0);
    const costC = Number(summary.cost_cents ?? 0);

    return {
      parts: rows.map(r => scrubMoney(r as Record<string, unknown>, ctx.caps)),
      vendors,
      thinMarginPct: THIN_MARGIN_PCT,
      byRo: ctx.caps.money
        ? perRo.map(r => ({
          roId: Number(r.ro_id),
          listCents: Number(r.list_cents ?? 0),
          costCents: Number(r.cost_cents ?? 0),
          marginPct: marginPct(Number(r.list_cents ?? 0), Number(r.cost_cents ?? 0)),
          thinLines: Number(r.thin_lines ?? 0)
        }))
        : [],
      summary: {
        listCents: ctx.caps.money ? listC : null,
        costCents: ctx.caps.money ? costC : null,
        marginPct: ctx.caps.money ? marginPct(listC, costC) : null,
        needed: Number(summary.needed ?? 0),
        ordered: Number(summary.ordered ?? 0),
        backordered: Number(summary.backordered ?? 0),
        late: Number(summary.late ?? 0),
        filesWaiting: Number(summary.files_waiting ?? 0)
      }
    };
  });

  app.post('/api/ro/:id/parts', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'parts', reply)) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const roId = Number((req.params as { id: string }).id);
    const b = req.body as {
      description: string; partNumber?: string; partType?: string; qty?: number;
      priceCents?: number; costCents?: number; vendorId?: number; eta?: string;
      gating?: boolean; note?: string; poNumber?: string;
    };
    if (!b.description) return reply.code(400).send({ error: 'Description is required' });

    const res = await texec(ctx.company!.id, `
      INSERT INTO parts_lines
        (ro_id, vendor_id, description, part_number, part_type, qty,
         price_cents, cost_cents, po_number, state, gating, eta, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'need', ?, ?, ?)`,
      [roId, b.vendorId ?? null, b.description.slice(0, 255), b.partNumber ?? null,
       b.partType ?? null, b.qty ?? 1, b.priceCents ?? 0, b.costCents ?? 0,
       b.poNumber ?? null, b.gating === false ? 0 : 1, b.eta ?? null, b.note ?? null]
    );

    return { ok: true, id: res.insertId };
  });

  /**
   * Update a part line. Receiving the last gating part on a file is what
   * clears the parts gate, so that transition raises a notification.
   */
  app.patch('/api/parts/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'parts', reply)) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as Record<string, unknown>;

    const before = await tqOne<RowDataPacket & {
      ro_id: number; description: string; state: string; qty: number; qty_received: number;
    }>(cid, 'SELECT ro_id, description, state, qty, qty_received FROM parts_lines WHERE id = ?', [id]);
    if (!before) return reply.code(404).send({ error: 'No such part line' });

    const map: Record<string, string> = {
      description: 'description', partNumber: 'part_number', partType: 'part_type',
      qty: 'qty', qtyReceived: 'qty_received', priceCents: 'price_cents',
      costCents: 'cost_cents', poNumber: 'po_number', invoiceNo: 'invoice_no',
      vendorId: 'vendor_id', state: 'state', gating: 'gating',
      orderedAt: 'ordered_at', eta: 'eta', receivedAt: 'received_at', note: 'note'
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'gating' ? (b[k] ? 1 : 0) : b[k]);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    // Receiving sets the date and the quantity if the caller did not.
    if (b.state === 'received') {
      if (b.receivedAt === undefined) { sets.push('received_at = CURDATE()'); }
      if (b.qtyReceived === undefined) { sets.push('qty_received = qty'); }
    }
    if (b.state === 'ordered' && b.orderedAt === undefined) {
      sets.push('ordered_at = COALESCE(ordered_at, CURDATE())');
    }

    vals.push(id);
    await texec(cid, `UPDATE parts_lines SET ${sets.join(', ')} WHERE id = ?`, vals);

    const ro = await tqOne<RowDataPacket & { ro_number: string }>(
      cid, 'SELECT ro_number FROM repair_orders WHERE id = ?', [before.ro_id]
    );

    /* The audit row is written from what actually moved, not from the request:
       a body that sends a field back unchanged should not read as a change. */
    const after = await tqOne<RowDataPacket>(cid,
      `SELECT description, state, qty, qty_received, cost_cents, price_cents, vendor_id, po_number
         FROM parts_lines WHERE id = ?`, [id]);
    const moved = diff(
      { state: before.state, qty: before.qty, qty_received: before.qty_received },
      { state: after?.state, qty: after?.qty, qty_received: after?.qty_received },
      { state: 'State', qty: 'Quantity', qty_received: 'Received' }
    );
    await audit(cid, actorFrom(req), {
      entity: 'part', entityId: id, roId: before.ro_id, action: 'part_edit', area: 'Parts',
      label: `${before.description} — ${b.state && b.state !== before.state
        ? String(b.state).replace('_', ' ')
        : 'line edited'}${ro ? ' on ' + ro.ro_number : ''}`,
      changes: moved,
      note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null
    });

    if (b.state && b.state !== before.state) {
      await texec(cid,
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [before.ro_id, `Part “${before.description}” ${String(b.state).replace('_', ' ')}.`,
         ctx.user.id, ctx.user.name]
      );

      if (b.state === 'received' && ro) {
        await notify({
          companyId: cid, event: 'parts.arrived', roId: before.ro_id,
          title: `Parts in — RO ${ro.ro_number}`,
          body: `${before.description} received on ${ro.ro_number}.`,
          actorUserId: ctx.user.id,
          dedupeKey: `parts:${before.ro_id}:${id}:received`
        }).catch(e => req.log.error(e));
      }
    }

    // Recompute the file's parts cost so the board's totals stay honest.
    await recomputePartsCost(cid, before.ro_id);

    return { ok: true };
  });

  app.delete('/api/parts/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const line = await tqOne<RowDataPacket & { ro_id: number; description: string; state: string }>(
      cid, 'SELECT ro_id, description, state FROM parts_lines WHERE id = ?', [id]);

    await texec(cid, 'DELETE FROM parts_lines WHERE id = ?', [id]);

    if (line) {
      await audit(cid, actorFrom(req), {
        entity: 'part', entityId: id, roId: line.ro_id, action: 'part_deleted', area: 'Parts',
        label: `Part line removed — ${line.description}`,
        changes: [{ field: 'Line', from: line.description + ' (' + line.state + ')', to: null }]
      });
      await recomputePartsCost(cid, line.ro_id);
    }
    return { ok: true };
  });

  /**
   * Order several lines at once — the normal way a desk works: one order, one
   * supplier, one order number, one ETA. Prices come from the lines, which the
   * modal has already corrected.
   */
  app.post('/api/parts/bulk-order', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const { ids, vendorId, eta, poNumber } = req.body as
      { ids: number[]; vendorId?: number; eta?: string; poNumber?: string };
    if (!ids?.length) return reply.code(400).send({ error: 'Nothing selected' });

    await texec(cid, `
      UPDATE parts_lines
      SET state = 'ordered', ordered_at = CURDATE(),
          vendor_id = COALESCE(?, vendor_id), eta = COALESCE(?, eta),
          po_number = COALESCE(NULLIF(?, ''), po_number)
      WHERE id IN (?)`,
      [vendorId ?? null, eta ?? null, poNumber ?? null, ids]
    );

    /* One note per file, naming the vendor and what it is against — the parts
       list should read as what is coming, from whom, when. */
    const touched = await tq<Array<RowDataPacket & { ro_id: number; n: number; vendor_name: string | null }>>(
      cid, `SELECT p.ro_id, COUNT(*) AS n, MAX(v.name) AS vendor_name
            FROM parts_lines p LEFT JOIN vendors v ON v.id = p.vendor_id
            WHERE p.id IN (?) GROUP BY p.ro_id`, [ids]);

    for (const t of touched) {
      await texec(cid,
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [t.ro_id,
         `${t.n} part ${t.n === 1 ? 'line' : 'lines'} ordered` +
         (t.vendor_name ? ` from ${t.vendor_name}` : '') +
         (poNumber ? ` on order ${poNumber}` : '') +
         (eta ? `, ETA ${eta}` : '') + '.',
         ctx.user.id, ctx.user.name]
      );
      await recomputePartsCost(cid, t.ro_id);
    }

    return { ok: true, count: ids.length, files: touched.length };
  });

  /**
   * Receive several lines at once. Receiving is quick — a tick — but it records
   * the date and what came short: a line with anything owed stays on order for
   * the remainder, because partial arrivals are the normal case.
   */
  app.post('/api/parts/bulk-receive', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const b = req.body as {
      lines: Array<{ id: number; short?: number; received?: number }>;
      receivedAt?: string; invoiceNo?: string;
    };
    if (!b.lines?.length) return reply.code(400).send({ error: 'Nothing selected' });

    const ids = b.lines.map(l => Number(l.id)).filter(Boolean);
    const rows = await tq<Array<RowDataPacket & {
      id: number; ro_id: number; description: string; qty: number; state: string;
    }>>(cid, 'SELECT id, ro_id, description, qty, state FROM parts_lines WHERE id IN (?)', [ids]);

    const files = new Set<number>();
    const shorted: string[] = [];

    for (const row of rows) {
      const ask = b.lines.find(l => Number(l.id) === row.id)!;
      const short = Math.max(0, Number(ask.short ?? 0) || 0);
      const received = ask.received !== undefined
        ? Math.max(0, Math.min(row.qty, Number(ask.received)))
        : Math.max(0, row.qty - short);
      const state = received >= row.qty ? 'received' : received > 0 ? 'partial' : 'backordered';

      await texec(cid, `
        UPDATE parts_lines
        SET qty_received = ?, state = ?, received_at = COALESCE(?, CURDATE()),
            invoice_no = COALESCE(NULLIF(?, ''), invoice_no)
        WHERE id = ?`,
        [received, state, b.receivedAt ?? null, b.invoiceNo ?? null, row.id]);

      await texec(cid,
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [row.ro_id,
         state === 'received'
           ? `Part “${row.description}” received.`
           : `Part “${row.description}” received ${received} of ${row.qty} — ${row.qty - received} short, still on order.`,
         ctx.user.id, ctx.user.name]);

      if (state !== 'received') shorted.push(row.description);
      files.add(row.ro_id);
    }

    for (const roId of files) {
      await recomputePartsCost(cid, roId);

      /* The last gating line clearing is what opens the file up. */
      const owed = await tqOne<RowDataPacket & { n: number }>(cid,
        `SELECT COUNT(*) AS n FROM parts_lines
         WHERE ro_id = ? AND gating = 1 AND state IN ('need','ordered','partial','backordered')`,
        [roId]);
      if (Number(owed?.n ?? 0) === 0) {
        const ro = await tqOne<RowDataPacket & { ro_number: string }>(
          cid, 'SELECT ro_number FROM repair_orders WHERE id = ?', [roId]);
        if (ro) {
          await notify({
            companyId: cid, event: 'parts.arrived', roId,
            title: `Parts in — RO ${ro.ro_number}`,
            body: `Every gating part is in on ${ro.ro_number}.`,
            actorUserId: ctx.user.id,
            dedupeKey: `parts:${roId}:gate-clear`
          }).catch(e => req.log.error(e));
        }
      }
    }

    return { ok: true, count: rows.length, files: files.size, short: shorted.length };
  });

  /**
   * The shop's vendor list. Admin gets everything including retired ones;
   * everywhere else only asks for what is still in use.
   */
  app.get('/api/vendors', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const all = (req.query as { all?: string }).all === '1' && ctx.caps.admin;

    const vendors = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT v.id, v.name, v.kind, v.phone, v.email, v.active,
             (SELECT COUNT(*) FROM parts_lines p WHERE p.vendor_id = v.id) AS parts_lines,
             (SELECT COUNT(*) FROM parts_lines p
               WHERE p.vendor_id = v.id
                 AND p.state IN ('ordered','partial','backordered')) AS on_order,
             (SELECT MAX(p.ordered_at) FROM parts_lines p WHERE p.vendor_id = v.id) AS last_ordered
      FROM vendors v
      ${all ? '' : 'WHERE v.active = 1'}
      ORDER BY v.active DESC, v.name`);

    /* Sublet vendors are typed as free text on the file rather than picked, so
       the admin screen shows what has actually been used — a name that keeps
       appearing there is one worth adding to the list properly. */
    const subletNames = await tq<Array<RowDataPacket & { vendor: string; n: number }>>(
      ctx.company!.id,
      `SELECT vendor, COUNT(*) AS n FROM sublets
       WHERE vendor IS NOT NULL AND vendor <> '' GROUP BY vendor ORDER BY n DESC, vendor`
    );

    return { vendors, subletVendors: subletNames, kinds: VENDOR_KINDS };
  });

  app.post('/api/vendors', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });
    const b = req.body as { name: string; kind?: string; phone?: string; email?: string };
    if (!b.name) return reply.code(400).send({ error: 'Name is required' });

    const res = await texec(ctx.company!.id,
      'INSERT INTO vendors (name, kind, phone, email) VALUES (?, ?, ?, ?)',
      [b.name.trim().slice(0, 160), b.kind ?? null, b.phone ?? null, b.email ?? null]
    );
    return { ok: true, id: res.insertId };
  });

  /**
   * Edit a vendor, or retire one. Retiring keeps every order that already names
   * it — the vendor simply stops being offered.
   */
  app.patch('/api/vendors/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const b = req.body as {
      name?: string; kind?: string | null; phone?: string | null;
      email?: string | null; active?: boolean;
    };

    const map: Array<[keyof typeof b, string]> = [
      ['name', 'name'], ['kind', 'kind'], ['phone', 'phone'], ['email', 'email']
    ];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of map) {
      if (b[k] === undefined) continue;
      const v = b[k];
      sets.push(`${col} = ?`);
      vals.push(typeof v === 'string' ? (v.trim() || null) : v);
    }
    if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await texec(ctx.company!.id, `UPDATE vendors SET ${sets.join(', ')} WHERE id = ?`, vals);
    return { ok: true };
  });

  /* ------------------------------------------------------- sublet + supplements */

  /**
   * Sublet: a vehicle out for calibration, glass or mechanical. It is still on
   * the board — the sublet line is what explains the day.
   *
   * Parts, estimators and managers move sublets; a technician does not.
   */
  app.post('/api/ro/:id/sublets', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'supp', reply)) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const roId = Number((req.params as { id: string }).id);
    const b = req.body as {
      service: string; vendor?: string; outAt?: string; backAt?: string;
      costCents?: number; poNumber?: string; state?: string;
    };
    if (!b.service) return reply.code(400).send({ error: 'Service is required' });

    const res = await texec(ctx.company!.id, `
      INSERT INTO sublets (ro_id, service, vendor, state, out_at, back_at, cost_cents, po_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [roId, b.service.slice(0, 64), b.vendor?.trim() || null, b.state ?? 'scheduled',
       b.outAt || null, b.backAt || null, b.costCents ?? 0, b.poNumber?.trim() || null]
    );

    await texec(ctx.company!.id,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [roId, `Sublet added: ${b.service}${b.vendor ? ' — ' + b.vendor : ''}.`, ctx.user.id, ctx.user.name]
    );

    await recomputeSubletCost(ctx.company!.id, roId);
    return { ok: true, id: res.insertId };
  });

  /**
   * Parts bought against a file that was later voided. They stay here until
   * somebody says what happened to each one — the list is the only durable
   * record that money is sitting on a shelf.
   */
  app.get('/api/parts/returns', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'parts', reply)) return;

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT p.id, p.ro_id, p.description, p.part_number, p.part_type, p.qty, p.state,
             p.price_cents, p.cost_cents, p.po_number, p.invoice_no, p.ordered_at,
             p.return_flagged_at, p.note,
             v.name AS vendor_name,
             COALESCE(vd.ro_number, r.ro_number) AS ro_number,
             r.voided_at, vd.reason AS void_reason
      FROM parts_lines p
      JOIN repair_orders r ON r.id = p.ro_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN ro_voids vd ON vd.id = (
        SELECT MAX(x.id) FROM ro_voids x WHERE x.ro_id = p.ro_id)
      WHERE p.return_flagged_at IS NOT NULL AND p.return_cleared_at IS NULL
      ORDER BY p.return_flagged_at DESC, p.id`);

    return {
      returns: rows.map(r => scrubMoney(r as Record<string, unknown>, ctx.caps)),
      count: rows.length
    };
  });

  /**
   * Clear one off the list: returned to the vendor, or kept on the shelf.
   * Either way it stops asking.
   */
  app.post('/api/parts/:id/return-cleared', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'parts', reply)) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    const b = req.body as { outcome?: 'returned' | 'kept'; note?: string };
    const outcome = b.outcome === 'kept' ? 'kept' : 'returned';

    const line = await tqOne<RowDataPacket & { ro_id: number; description: string }>(
      cid, `SELECT ro_id, description, return_flagged_at FROM parts_lines WHERE id = ?`, [id]);
    if (!line) return reply.code(404).send({ error: 'No such part line' });
    if (!line.return_flagged_at) return reply.code(409).send({ error: 'That line is not flagged for return.' });

    await texec(cid, `
      UPDATE parts_lines
      SET return_cleared_at = NOW(),
          state = ?,
          note = COALESCE(NULLIF(?, ''), note)
      WHERE id = ?`,
      [outcome === 'returned' ? 'returned' : 'not_needed', (b.note ?? '').trim().slice(0, 255), id]);

    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [line.ro_id,
       outcome === 'returned'
         ? `“${line.description}” returned to the vendor.`
         : `“${line.description}” kept on the shelf.`,
       ctx.user.id, ctx.user.name]);

    return { ok: true, outcome };
  });

  app.patch('/api/sublets/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as Record<string, unknown>;

    const before = await tqOne<RowDataPacket & {
      ro_id: number; service: string; vendor: string | null; state: string;
    }>(cid, 'SELECT ro_id, service, vendor, state FROM sublets WHERE id = ?', [id]);
    if (!before) return reply.code(404).send({ error: 'No such sublet' });

    const map: Record<string, string> = {
      service: 'service', vendor: 'vendor', state: 'state',
      outAt: 'out_at', backAt: 'back_at', costCents: 'cost_cents', poNumber: 'po_number'
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      const v = b[k];
      sets.push(`${col} = ?`);
      vals.push(typeof v === 'string' ? (v.trim() || null) : v);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    /* Moving it out or back stamps the date if nobody typed one — the dates are
       what the day is explained by, so they should not need remembering. */
    if (b.state === 'out' && b.outAt === undefined) sets.push('out_at = COALESCE(out_at, CURDATE())');
    if (b.state === 'returned' && b.backAt === undefined) sets.push('back_at = COALESCE(back_at, CURDATE())');

    vals.push(id);
    await texec(cid, `UPDATE sublets SET ${sets.join(', ')} WHERE id = ?`, vals);

    if (b.state !== undefined && b.state !== before.state) {
      await texec(cid,
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [before.ro_id,
         `Sublet — ${before.service} (${before.vendor || 'no vendor'}) marked ${b.state}.`,
         ctx.user.id, ctx.user.name]);
    }
    if (b.costCents !== undefined) await recomputeSubletCost(cid, before.ro_id);

    return { ok: true };
  });

  app.delete('/api/sublets/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const row = await tqOne<RowDataPacket & { ro_id: number; service: string }>(
      cid, 'SELECT ro_id, service FROM sublets WHERE id = ?', [id]);
    if (!row) return reply.code(404).send({ error: 'No such sublet' });

    await texec(cid, 'DELETE FROM sublets WHERE id = ?', [id]);
    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [row.ro_id, `Sublet removed: ${row.service}.`, ctx.user.id, ctx.user.name]);
    await recomputeSubletCost(cid, row.ro_id);
    return { ok: true };
  });

  /** Sublet services a shop can pick from. Stripes and wrap included. */
  app.get('/api/sublet-services', async () => ({
    services: [
      'ADAS calibration', 'Windshield / glass', 'Alignment', 'Mechanical',
      'Suspension', 'A/C service', 'Diagnostic scan', 'Upholstery / trim',
      'Wheel repair', 'Tyres', 'Stripes', 'Wrap', 'Vinyl / decals',
      'Headlight restoration', 'Paintless dent (outsourced)', 'Towing', 'Other'
    ]
  }));
}
