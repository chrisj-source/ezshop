import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, texec } from '../db/tenant';
import { requireCompany } from '../middleware/context';

/**
 * The in-app inbox. Group management lives in routes/admin.ts; this file is
 * only what the bell in the header reads and writes.
 */
export async function registerNotifications(app: FastifyInstance): Promise<void> {

  app.get('/api/inbox', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT n.id, n.event_key, n.ro_id, n.lead_id, n.title, n.body, n.read_at, n.created_at,
             r.ro_number
      FROM notifications n
      LEFT JOIN repair_orders r ON r.id = n.ro_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 120`,
      [ctx.user.id]
    );

    return { items: rows, unread: rows.filter(r => !r.read_at).length };
  });

  app.get('/api/inbox/count', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const [row] = await tq<RowDataPacket[]>(ctx.company!.id,
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [ctx.user.id]
    );
    return { unread: Number(row.n ?? 0) };
  });

  /** Flip one notification either way — unread matters as much as read. */
  app.post('/api/inbox/:id/read', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const { read } = req.body as { read?: boolean };
    await texec(ctx.company!.id,
      'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?',
      [read === false ? null : new Date(), Number((req.params as { id: string }).id), ctx.user.id]
    );
    return { ok: true };
  });

  app.post('/api/inbox/mark-all', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const { read } = req.body as { read?: boolean };
    await texec(ctx.company!.id,
      'UPDATE notifications SET read_at = ? WHERE user_id = ?',
      [read === false ? null : new Date(), ctx.user.id]
    );
    return { ok: true };
  });
}
