import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, tqOne, texec } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { audit } from '../lib/audit';
import { actorFrom } from './audit';
import {
  ROUTE_ROLES, ROUTE_ASSIGNED, allRoutes, saveRoutes, routingConfigured,
  defaultRoutesFor, RouteRow
} from '../lib/status-routes';

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

  /* ------------------------------------------------- who a status change messages */

  /**
   * The routing grid: every status on this shop's board against the ten
   * targets. Read by Admin › Notifications.
   *
   * Six targets are roles — everyone holding the role hears. Four are the
   * person assigned to a trade on the file, and they send to that person only;
   * an unassigned trade messages nobody rather than falling back to everyone
   * who could have done the work.
   */
  app.get('/api/status-routing', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.managePermissions) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;

    const [statuses, roles, routes, configured] = await Promise.all([
      tq<RowDataPacket[]>(cid, `
        SELECT s.slot_id, s.label, s.owner_role, s.module, s.is_terminal,
               g.id AS group_id, g.name AS group_name, g.lane_key, g.sort_order AS group_order,
               s.sort_order
        FROM statuses s
        JOIN status_groups g ON g.id = s.group_id
        WHERE s.enabled = 1
        ORDER BY g.sort_order, s.sort_order`),
      tq<RowDataPacket[]>(cid, 'SELECT role_key, label FROM roles ORDER BY rank_order, label'),
      allRoutes(cid),
      routingConfigured(cid)
    ]);

    const labelOf = new Map(roles.map(r => [String(r.role_key), String(r.label)]));

    return {
      configured,
      /* The grid's columns, in order, with the divider between the two kinds
         implied by the change of kind. Role labels are the shop's own — a shop
         that renamed Front office to "Service advisor" sees that here. */
      targets: [
        ...ROUTE_ROLES
          .filter(r => labelOf.has(r.key))
          .map(r => ({ kind: 'role', key: r.key, code: r.code, label: labelOf.get(r.key) })),
        ...ROUTE_ASSIGNED.map(a => ({ kind: 'assigned', key: a.key, code: a.code, label: a.label }))
      ],
      statuses,
      routes
    };
  });

  /**
   * Save the grid. One write: the table is replaced inside a transaction, so a
   * save cannot half-apply and leave a status routed to nobody by accident.
   * Zero rows for a status is a legitimate answer and is kept as one.
   */
  app.put('/api/status-routing', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.managePermissions) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;

    const b = req.body as { routes?: Array<{ slotId: string; kind: string; key: string }> };
    const incoming = b.routes ?? [];

    /* Only statuses this board carries and only targets that exist — a stale
       tab should not be able to write a route to a deleted role. */
    const [slots, roles] = await Promise.all([
      tq<Array<RowDataPacket & { slot_id: string }>>(cid, 'SELECT slot_id FROM statuses'),
      tq<Array<RowDataPacket & { role_key: string }>>(cid, 'SELECT role_key FROM roles')
    ]);
    const okSlot = new Set(slots.map(s => String(s.slot_id)));
    const okRole = new Set(roles.map(r => String(r.role_key)));
    const okAssigned = new Set(ROUTE_ASSIGNED.map(a => a.key));

    const rows: RouteRow[] = [];
    for (const r of incoming) {
      if (!okSlot.has(String(r.slotId))) continue;
      if (r.kind === 'role' && okRole.has(String(r.key))) {
        rows.push({ slot_id: String(r.slotId), target_kind: 'role', target_key: String(r.key) });
      } else if (r.kind === 'assigned' && okAssigned.has(String(r.key))) {
        rows.push({ slot_id: String(r.slotId), target_kind: 'assigned', target_key: String(r.key) });
      }
    }

    const before = await allRoutes(cid);
    const saved = await saveRoutes(cid, rows);

    const silent = [...okSlot].filter(s => !rows.some(r => r.slot_id === s)).length;

    await audit(cid, actorFrom(req), {
      entity: 'status_routing', action: 'routing_saved', area: 'Permissions',
      label: `Status messages — ${saved} route${saved === 1 ? '' : 's'} set, ` +
        `${silent} status${silent === 1 ? '' : 'es'} messaging nobody`,
      changes: [{ field: 'Routes', from: String(before.length), to: String(saved) }],
      sensitive: true
    });

    return { ok: true, routes: saved, silentStatuses: silent };
  });

  /**
   * Back to what ships. Only for the statuses this board carries — a shop that
   * has added its own statuses keeps them, routed to nobody, which is the
   * honest answer for a status we know nothing about.
   */
  app.post('/api/status-routing/defaults', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.managePermissions) return reply.code(403).send({ error: 'Not permitted' });
    const cid = ctx.company!.id;

    const [slots, roles] = await Promise.all([
      tq<Array<RowDataPacket & { slot_id: string }>>(cid, 'SELECT slot_id FROM statuses'),
      tq<Array<RowDataPacket & { role_key: string }>>(cid, 'SELECT role_key FROM roles')
    ]);
    const okRole = new Set(roles.map(r => String(r.role_key)));

    /* A shop that deleted or renamed a shipped role gets no route to it. */
    const rows = defaultRoutesFor(slots.map(s => String(s.slot_id)))
      .filter(r => r.target_kind !== 'role' || okRole.has(r.target_key));

    const saved = await saveRoutes(cid, rows);

    await audit(cid, actorFrom(req), {
      entity: 'status_routing', action: 'routing_reset', area: 'Permissions',
      label: `Status messages reset to the shipped default — ${saved} routes`,
      sensitive: true
    });

    return { ok: true, routes: saved };
  });
}
