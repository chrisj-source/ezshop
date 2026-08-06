import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, texec, tqOne } from '../db/tenant';
import { requireCompany } from '../middleware/context';

/**
 * Clients: wholesale accounts (dealers, hail companies, auctions, fleets),
 * retail customers, and insurance carriers. Wholesale is the one the shop
 * sets up in advance — a car arrives billed to an account that must exist.
 */

const WHOLESALE_TYPES = ['dealer', 'hail', 'auction', 'fleet'] as const;
const KINDS = ['retail', 'wholesale', 'insurance'] as const;

export async function registerClients(app: FastifyInstance): Promise<void> {

  app.get('/api/client-types', async () => ({
    kinds: [
      { key: 'wholesale', label: 'Wholesale account' },
      { key: 'insurance', label: 'Insurance carrier' },
      { key: 'retail', label: 'Retail customer' }
    ],
    wholesaleTypes: [
      { key: 'dealer', label: 'Dealership' },
      { key: 'hail', label: 'Hail company' },
      { key: 'auction', label: 'Auction' },
      { key: 'fleet', label: 'Fleet' }
    ],
    terms: ['On delivery', 'Per event', 'Net 15', 'Net 30', 'Net 45', 'Net 60']
  }));

  /** List clients. `kind` filters; `active=all` includes switched-off accounts. */
  app.get('/api/clients', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const q = req.query as { kind?: string; active?: string };
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.kind && (KINDS as readonly string[]).includes(q.kind)) {
      where.push('c.kind = ?');
      params.push(q.kind);
    }
    if (q.active !== 'all') where.push('c.active = 1');

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT c.id, c.kind, c.wholesale_type, c.name, c.contact_name, c.phone, c.email,
             c.address, c.city, c.state, c.zip, c.terms, c.is_drp, c.adjuster_desk,
             c.platform_locked, c.active, c.created_at,
             (SELECT COUNT(*) FROM repair_orders r
               WHERE r.client_id = c.id AND r.closed_at IS NULL) AS open_files,
             (SELECT COUNT(*) FROM repair_orders r
               WHERE r.client_id = c.id AND YEAR(r.opened_at) = YEAR(CURDATE())) AS ytd_files
      FROM clients c
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.kind, c.name`,
      params
    );

    return { clients: rows };
  });

  app.post('/api/clients', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editRepairOrders && !ctx.caps.admin) {
      return reply.code(403).send({ error: 'Not permitted' });
    }

    const b = req.body as {
      kind: string; wholesaleType?: string; name: string; contactName?: string;
      phone?: string; email?: string; address?: string; city?: string; state?: string;
      zip?: string; terms?: string; isDrp?: boolean; adjusterDesk?: string;
    };

    if (!b.name || !b.name.trim()) return reply.code(400).send({ error: 'A name is required.' });
    if (!(KINDS as readonly string[]).includes(b.kind)) {
      return reply.code(400).send({ error: 'Unknown client type.' });
    }
    if (b.kind === 'wholesale' && !(WHOLESALE_TYPES as readonly string[]).includes(b.wholesaleType ?? '')) {
      return reply.code(400).send({ error: 'Pick what kind of wholesale account this is.' });
    }

    const dup = await tqOne<RowDataPacket>(ctx.company!.id,
      'SELECT id FROM clients WHERE kind = ? AND name = ?', [b.kind, b.name.trim()]);
    if (dup) return reply.code(409).send({ error: `“${b.name.trim()}” already exists.` });

    const res = await texec(ctx.company!.id, `
      INSERT INTO clients
        (kind, wholesale_type, name, contact_name, phone, email, address, city, state, zip,
         terms, is_drp, adjuster_desk)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.kind, b.kind === 'wholesale' ? b.wholesaleType : null, b.name.trim(),
       b.contactName ?? null, b.phone ?? null, b.email ?? null, b.address ?? null,
       b.city ?? null, b.state ?? null, b.zip ?? null, b.terms ?? null,
       b.isDrp ? 1 : 0, b.adjusterDesk ?? null]
    );

    return { ok: true, id: res.insertId };
  });

  app.patch('/api/clients/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.editRepairOrders && !ctx.caps.admin) {
      return reply.code(403).send({ error: 'Not permitted' });
    }

    const id = Number((req.params as { id: string }).id);
    const b = req.body as Record<string, unknown>;

    const existing = await tqOne<RowDataPacket & { platform_locked: number }>(
      ctx.company!.id, 'SELECT platform_locked FROM clients WHERE id = ?', [id]);
    if (!existing) return reply.code(404).send({ error: 'No such client' });
    if (existing.platform_locked === 1 && !ctx.isPlatformOwner) {
      return reply.code(403).send({ error: 'That account is managed by the platform.' });
    }

    const map: Record<string, string> = {
      name: 'name', wholesaleType: 'wholesale_type', contactName: 'contact_name',
      phone: 'phone', email: 'email', address: 'address', city: 'city', state: 'state',
      zip: 'zip', terms: 'terms', adjusterDesk: 'adjuster_desk'
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(b[k]); }
    }
    if (b.isDrp !== undefined) { sets.push('is_drp = ?'); vals.push(b.isDrp ? 1 : 0); }
    if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await texec(ctx.company!.id, `UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, vals);
    return { ok: true };
  });

  /** Switching an account off hides it from pickers; open files keep working. */
  app.delete('/api/clients/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const id = Number((req.params as { id: string }).id);
    const open = await tqOne<RowDataPacket & { n: number }>(ctx.company!.id,
      'SELECT COUNT(*) AS n FROM repair_orders WHERE client_id = ? AND closed_at IS NULL', [id]);

    await texec(ctx.company!.id, 'UPDATE clients SET active = 0 WHERE id = ?', [id]);
    return { ok: true, openFiles: Number(open?.n ?? 0) };
  });
}
