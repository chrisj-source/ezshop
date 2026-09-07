import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { audit } from '../lib/audit';
import { actorFrom } from './audit';

/**
 * Messages.
 *
 * One row per recipient, which is what `notifications` has always been: a parts
 * arrival with three subscribers is three rows. Read, deleted and every send
 * attempt hang off the recipient's own row, so email and SMS become extra
 * deliveries on a message that already exists rather than a parallel system.
 *
 * Deleting is per person and destroys nothing. The row keeps `deleted_at`, the
 * list stops showing it, and the audit log keeps the fact that it was sent.
 */
export async function registerNotifications(app: FastifyInstance): Promise<void> {

  const LIST = `
    SELECT n.id, n.event_key, n.ro_id, n.lead_id, n.title, n.body, n.read_at, n.created_at,
           n.dispatch_state, r.ro_number, l.lead_number
    FROM notifications n
    LEFT JOIN repair_orders r ON r.id = n.ro_id
    LEFT JOIN leads l ON l.id = n.lead_id
    WHERE n.user_id = ? AND n.deleted_at IS NULL`;

  /**
   * The list, filtered. `new` is unread, `old` is read — the two words the shop
   * actually uses; nothing is aged out by date.
   */
  app.get('/api/inbox', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const q = req.query as { filter?: string; limit?: string; q?: string };

    const filter = q.filter === 'new' ? 'new' : q.filter === 'old' ? 'old' : 'all';
    const limit = Math.min(400, Math.max(20, Number(q.limit) || 150));

    const where: string[] = [];
    const args: unknown[] = [ctx.user.id];
    if (filter === 'new') where.push('n.read_at IS NULL');
    if (filter === 'old') where.push('n.read_at IS NOT NULL');
    if (q.q && q.q.trim()) {
      const like = '%' + q.q.trim() + '%';
      where.push('(n.title LIKE ? OR n.body LIKE ? OR r.ro_number LIKE ?)');
      args.push(like, like, like);
    }

    const rows = await tq<RowDataPacket[]>(cid,
      `${LIST} ${where.length ? 'AND ' + where.join(' AND ') : ''}
       ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit}`, args);

    const [tally] = await tq<RowDataPacket[]>(cid, `
      SELECT SUM(read_at IS NULL) AS unread, SUM(read_at IS NOT NULL) AS read_count, COUNT(*) AS total
      FROM notifications WHERE user_id = ? AND deleted_at IS NULL`, [ctx.user.id]);

    return {
      items: rows,
      filter,
      unread: Number(tally?.unread ?? 0),
      old: Number(tally?.read_count ?? 0),
      total: Number(tally?.total ?? 0)
    };
  });

  app.get('/api/inbox/count', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const [row] = await tq<RowDataPacket[]>(ctx.company!.id,
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL',
      [ctx.user.id]
    );
    return { unread: Number(row.n ?? 0) };
  });

  /** One message and its delivery record — in-app now, email and SMS later. */
  app.get('/api/inbox/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);

    const row = await tqOne<RowDataPacket>(cid, `
      SELECT n.*, r.ro_number, l.lead_number
      FROM notifications n
      LEFT JOIN repair_orders r ON r.id = n.ro_id
      LEFT JOIN leads l ON l.id = n.lead_id
      WHERE n.id = ? AND n.user_id = ?`, [id, ctx.user.id]);
    if (!row) return reply.code(404).send({ error: 'No such message.' });

    const deliveries = await tq<RowDataPacket[]>(cid, `
      SELECT channel, address, state, provider_ref, error, created_at, sent_at
      FROM notification_deliveries WHERE notification_id = ? ORDER BY id`, [id]);

    return {
      message: row,
      /* The in-app row always exists; the other two are off until a shop turns
         them on, and "off" is a real answer rather than a missing one. */
      deliveries: ['app', 'email', 'sms'].map(ch => {
        const d = deliveries.find(x => x.channel === ch);
        return d
          ? { channel: ch, address: d.address, state: d.state, at: d.sent_at ?? d.created_at, error: d.error }
          : { channel: ch, address: null, state: 'off', at: null, error: null };
      })
    };
  });

  /** Flip one message either way — unread matters as much as read. */
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
    const { read, filter } = req.body as { read?: boolean; filter?: string };
    /* Marking all read from the New tab means the ones on screen, not the lot. */
    const only = filter === 'new' ? ' AND read_at IS NULL'
      : filter === 'old' ? ' AND read_at IS NOT NULL' : '';
    await texec(ctx.company!.id,
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND deleted_at IS NULL${only}`,
      [read === false ? null : new Date(), ctx.user.id]
    );
    return { ok: true };
  });

  /**
   * Delete, for this person only. Nothing is removed: the row is marked, the
   * other recipients' copies are untouched, and the audit log keeps the send.
   */
  app.post('/api/inbox/delete', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const b = req.body as { ids?: number[]; all?: 'old' | 'read' };

    let ids = (b.ids ?? []).map(Number).filter(n => Number.isFinite(n));

    /* "Delete everything I have already read" — the one bulk action worth
       having, and the only one that does not need a selection. */
    if (b.all === 'old' || b.all === 'read') {
      const rows = await tq<RowDataPacket[]>(cid,
        'SELECT id FROM notifications WHERE user_id = ? AND read_at IS NOT NULL AND deleted_at IS NULL',
        [ctx.user.id]);
      ids = rows.map(r => Number(r.id));
    }
    if (!ids.length) return { ok: true, deleted: 0 };

    const marks = ids.map(() => '?').join(',');
    const { affectedRows } = await texec(cid,
      `UPDATE notifications SET deleted_at = NOW()
        WHERE user_id = ? AND deleted_at IS NULL AND id IN (${marks})`,
      [ctx.user.id, ...ids]);

    await audit(cid, actorFrom(req), {
      entity: 'notification', action: 'deleted', area: 'Messages',
      label: `${affectedRows} message${affectedRows === 1 ? '' : 's'} deleted from ${ctx.user.name}’s list`,
      detail: { ids },
      /* Their own inbox, not the record — a delete here is housekeeping. */
      sensitive: false
    });

    return { ok: true, deleted: affectedRows };
  });
}
