import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { notify } from '../notify';
import { scrubMoney } from '../permissions';

export async function registerParts(app: FastifyInstance): Promise<void> {

  /** Every gating part across the shop — the parts desk's working list. */
  app.get('/api/parts', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'parts', reply)) return;

    const q = req.query as { state?: string; roId?: string };
    const where: string[] = ['r.closed_at IS NULL'];
    const params: unknown[] = [];

    if (q.state) { where.push('p.state = ?'); params.push(q.state); }
    if (q.roId) { where.push('p.ro_id = ?'); params.push(Number(q.roId)); }

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT p.*, v.name AS vendor_name, r.ro_number,
             c.name AS customer_name,
             CONCAT_WS(' ', veh.year, veh.make, veh.model) AS vehicle,
             s.label AS status_label,
             DATEDIFF(CURDATE(), p.eta) AS days_late
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
        SUM(p.state = 'need') AS needed,
        SUM(p.state = 'ordered') AS ordered,
        SUM(p.state = 'backordered') AS backordered,
        SUM(p.state IN ('ordered','partial') AND p.eta < CURDATE()) AS late,
        COUNT(DISTINCT IF(p.gating = 1 AND p.state IN ('need','ordered','partial','backordered'), p.ro_id, NULL)) AS files_waiting
      FROM parts_lines p JOIN repair_orders r ON r.id = p.ro_id
      WHERE r.closed_at IS NULL
    `);

    return {
      parts: rows.map(r => scrubMoney(r as Record<string, unknown>, ctx.caps)),
      vendors,
      summary: {
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
      priceCents?: number; vendorId?: number; eta?: string; gating?: boolean; note?: string;
    };
    if (!b.description) return reply.code(400).send({ error: 'Description is required' });

    const res = await texec(ctx.company!.id, `
      INSERT INTO parts_lines
        (ro_id, vendor_id, description, part_number, part_type, qty, price_cents, state, gating, eta, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'need', ?, ?, ?)`,
      [roId, b.vendorId ?? null, b.description.slice(0, 255), b.partNumber ?? null,
       b.partType ?? null, b.qty ?? 1, b.priceCents ?? 0,
       b.gating === false ? 0 : 1, b.eta ?? null, b.note ?? null]
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
    await texec(cid, `
      UPDATE repair_orders r SET r.parts_cost_cents = (
        SELECT COALESCE(SUM(p.price_cents * p.qty), 0) FROM parts_lines p
        WHERE p.ro_id = r.id AND p.state <> 'not_needed'
      ) WHERE r.id = ?`, [before.ro_id]);

    return { ok: true };
  });

  app.delete('/api/parts/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });
    await texec(ctx.company!.id, 'DELETE FROM parts_lines WHERE id = ?', [Number((req.params as { id: string }).id)]);
    return { ok: true };
  });

  /** Order several lines at once — the normal way a desk works. */
  app.post('/api/parts/bulk-order', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });

    const { ids, vendorId, eta } = req.body as { ids: number[]; vendorId?: number; eta?: string };
    if (!ids?.length) return reply.code(400).send({ error: 'Nothing selected' });

    await texec(ctx.company!.id, `
      UPDATE parts_lines
      SET state = 'ordered', ordered_at = CURDATE(),
          vendor_id = COALESCE(?, vendor_id), eta = COALESCE(?, eta)
      WHERE id IN (?)`,
      [vendorId ?? null, eta ?? null, ids]
    );

    return { ok: true, count: ids.length };
  });

  app.post('/api/vendors', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageParts) return reply.code(403).send({ error: 'Not permitted' });
    const b = req.body as { name: string; kind?: string; phone?: string; email?: string };
    if (!b.name) return reply.code(400).send({ error: 'Name is required' });

    const res = await texec(ctx.company!.id,
      'INSERT INTO vendors (name, kind, phone, email) VALUES (?, ?, ?, ?)',
      [b.name, b.kind ?? null, b.phone ?? null, b.email ?? null]
    );
    return { ok: true, id: res.insertId };
  });

  /* ------------------------------------------------------- sublet + supplements */

  app.post('/api/ro/:id/sublets', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'supp', reply)) return;

    const roId = Number((req.params as { id: string }).id);
    const b = req.body as {
      service: string; vendor?: string; outAt?: string; backAt?: string;
      costCents?: number; poNumber?: string; state?: string;
    };
    if (!b.service) return reply.code(400).send({ error: 'Service is required' });

    const res = await texec(ctx.company!.id, `
      INSERT INTO sublets (ro_id, service, vendor, state, out_at, back_at, cost_cents, po_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [roId, b.service, b.vendor ?? null, b.state ?? 'scheduled',
       b.outAt ?? null, b.backAt ?? null, b.costCents ?? 0, b.poNumber ?? null]
    );

    await texec(ctx.company!.id,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [roId, `Sublet added: ${b.service}${b.vendor ? ' — ' + b.vendor : ''}.`, ctx.user.id, ctx.user.name]
    );

    return { ok: true, id: res.insertId };
  });

  app.patch('/api/sublets/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as Record<string, unknown>;

    const map: Record<string, string> = {
      service: 'service', vendor: 'vendor', state: 'state',
      outAt: 'out_at', backAt: 'back_at', costCents: 'cost_cents', poNumber: 'po_number'
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(b[k]); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await texec(ctx.company!.id, `UPDATE sublets SET ${sets.join(', ')} WHERE id = ?`, vals);
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
