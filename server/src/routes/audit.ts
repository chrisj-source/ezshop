import { FastifyInstance, FastifyRequest } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { Actor, auditActors } from '../lib/audit';

/**
 * Reading the audit log. There is deliberately no write endpoint and no delete
 * endpoint: entries are written by the code that makes the change, and nothing
 * removes them.
 *
 * Owner and whoever else the shop ticks `audit` for. It is its own capability so
 * a manager can be given the log without the rest of Admin.
 */
export async function registerAudit(app: FastifyInstance): Promise<void> {

  const AREAS = ['Repair order', 'Lead', 'Parts', 'Money', 'Documents',
    'Void / delete', 'Permissions', 'Setup', 'Messages', 'Payroll'];

  /** Today, 7, 30, this year, everything — the reader opens on today. */
  function sinceFor(span: string): string | null {
    const now = new Date();
    const d = new Date(now);
    if (span === 'today') { d.setHours(0, 0, 0, 0); }
    else if (span === '7') { d.setDate(d.getDate() - 7); }
    else if (span === '30') { d.setDate(d.getDate() - 30); }
    else if (span === 'year') { d.setMonth(0, 1); d.setHours(0, 0, 0, 0); }
    else return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }

  /**
   * Old rows — and any writer that has not been moved onto the audit helper yet —
   * carry no area and no label. Both are derived in SQL so the screen reads as one
   * list rather than a new list on top of blank ones.
   */
  const AREA_SQL = `COALESCE(a.area, CASE a.entity
      WHEN 'repair_order' THEN 'Repair order'
      WHEN 'lead' THEN 'Lead'
      WHEN 'part' THEN 'Parts'
      WHEN 'part_order' THEN 'Parts'
      WHEN 'document' THEN 'Documents'
      WHEN 'pay_plan' THEN 'Money'
      WHEN 'commission_run' THEN 'Money'
      WHEN 'payroll' THEN 'Payroll'
      WHEN 'role' THEN 'Permissions'
      WHEN 'staff' THEN 'Permissions'
      WHEN 'notification' THEN 'Messages'
      ELSE 'Setup' END)`;

  const LABEL_SQL = `COALESCE(a.label, CONCAT(REPLACE(a.entity, '_', ' '), ' — ', REPLACE(a.action, '_', ' ')))`;

  app.get('/api/audit', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewAudit && !ctx.caps.admin) {
      return reply.code(403).send({ error: 'The audit log is the owner’s and whoever they give it to.' });
    }
    const cid = ctx.company!.id;
    const q = req.query as {
      span?: string; who?: string; area?: string; q?: string;
      sensitive?: string; ro?: string; before?: string; limit?: string;
    };

    const where: string[] = [];
    const args: unknown[] = [];

    const since = sinceFor(q.span ?? 'today');
    if (since) { where.push('a.created_at >= ?'); args.push(since); }

    if (q.who) { where.push('a.user_name = ?'); args.push(q.who); }
    if (q.area && AREAS.includes(q.area)) { where.push(`${AREA_SQL} = ?`); args.push(q.area); }
    if (q.sensitive === '1') where.push('a.sensitive = 1');
    if (q.ro) { where.push('a.ro_id = ?'); args.push(Number(q.ro)); }
    if (q.q && q.q.trim()) {
      const like = '%' + q.q.trim() + '%';
      where.push(`(${LABEL_SQL} LIKE ? OR a.user_name LIKE ? OR a.note LIKE ?
                   OR a.action LIKE ? OR a.changes LIKE ? OR a.detail LIKE ? OR r.ro_number LIKE ?)`);
      args.push(like, like, like, like, like, like, like);
    }

    const limit = Math.min(300, Math.max(20, Number(q.limit) || 120));

    /* The filters as the tally sees them, before paging. Paging is by id rather
       than offset: the log only grows at the head, so a cursor cannot skip or
       repeat a row the way an offset can. */
    const baseWhere = where.slice(), baseArgs = args.slice();
    if (q.before) { where.push('a.id < ?'); args.push(Number(q.before)); }

    const rows = await tq<RowDataPacket[]>(cid, `
      SELECT a.id, a.user_id, a.user_name, a.actor_role, a.entity, a.entity_id,
             COALESCE(a.ro_id, CASE WHEN a.entity = 'repair_order' THEN a.entity_id END) AS ro_id,
             a.action, ${AREA_SQL} AS area, ${LABEL_SQL} AS label,
             a.changes, a.note, a.detail, a.sensitive,
             a.source, a.client, a.created_at,
             r.ro_number, l.lead_number
      FROM audit_log a
      LEFT JOIN repair_orders r
             ON r.id = COALESCE(a.ro_id, CASE WHEN a.entity = 'repair_order' THEN a.entity_id END)
      LEFT JOIN leads l ON l.id = a.entity_id AND a.entity = 'lead'
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.id DESC
      LIMIT ${limit}`, args);

    /* Two counts the header needs and the rows cannot give: how much is in this
       span at all, and how much of it nobody wrote a note about. */
    const [tally] = await tq<RowDataPacket[]>(cid, `
      SELECT COUNT(*) AS total,
             SUM(a.sensitive = 1) AS sensitive,
             SUM(a.note IS NULL OR a.note = '') AS silent
      FROM audit_log a
      LEFT JOIN repair_orders r
             ON r.id = COALESCE(a.ro_id, CASE WHEN a.entity = 'repair_order' THEN a.entity_id END)
      ${baseWhere.length ? 'WHERE ' + baseWhere.join(' AND ') : ''}`, baseArgs);

    return {
      items: rows.map(r => ({
        id: r.id,
        when: r.created_at,
        who: r.user_name ?? 'System',
        role: r.actor_role,
        area: r.area,
        action: r.action,
        label: r.label,
        note: r.note,
        sensitive: !!r.sensitive,
        source: r.source,
        client: r.client,
        entity: r.entity,
        entityId: r.entity_id,
        roId: r.ro_id,
        file: r.ro_number ? 'RO ' + r.ro_number : (r.lead_number ? 'Lead ' + r.lead_number : null),
        changes: parseJson(r.changes) ?? [],
        detail: parseJson(r.detail)
      })),
      total: Number(tally?.total ?? 0),
      sensitiveCount: Number(tally?.sensitive ?? 0),
      silentCount: Number(tally?.silent ?? 0),
      areas: AREAS,
      people: await auditActors(cid),
      /* The oldest id in the page, so "load more" can carry on from it. */
      nextBefore: rows.length === limit ? rows[rows.length - 1].id : null
    };
  });

  /** Everything that ever happened to one file, for the drawer. */
  app.get('/api/ro/:id/audit', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewAudit && !ctx.caps.admin) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, user_name, actor_role, area, action, label, note, sensitive, source, created_at, changes
      FROM audit_log WHERE ro_id = ? OR (entity = 'repair_order' AND entity_id = ?)
      ORDER BY id DESC LIMIT 200`, [id, id]);

    return {
      items: rows.map(r => ({
        id: r.id, when: r.created_at, who: r.user_name ?? 'System', role: r.actor_role,
        area: r.area, action: r.action, label: r.label, note: r.note,
        sensitive: !!r.sensitive, source: r.source, changes: parseJson(r.changes) ?? []
      }))
    };
  });
}

function parseJson(v: unknown): any {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

/** The actor as the audit helper wants it, including how they got here. */
export function actorFrom(req: FastifyRequest): Actor {
  const ctx = req.ctx!;
  const ua = String(req.headers['user-agent'] ?? '');
  const mobile = /iPhone|Android|iPad/i.test(ua);
  return {
    user: { id: ctx.user.id, name: ctx.user.name },
    roleLabel: ctx.roleLabel,
    source: mobile ? 'mobile' : 'web',
    client: (mobile ? 'Mobile' : 'Web') + ' · ' + (req.ip ?? '')
  };
}
