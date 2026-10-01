import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mexec, mq, mqOne } from '../db/master';
import { requireCompany, requirePlatformOwner } from '../middleware/context';
import { bringPeople, createLocation, groupBill, groupOf, setGrant, shopsInGroup } from '../lib/locations';
import { saveTaxRule, STATE_PRESETS, TAX_PARTS, TaxPart, taxRule } from '../lib/tax';
import { seatUse, seatWarning } from '../lib/billing';

async function paudit(actor: number, companyId: number, action: string, detail: unknown): Promise<void> {
  await mexec('INSERT INTO platform_audit (actor_user_id, company_id, action, detail) VALUES (?, ?, ?, ?)',
    [actor, companyId, action, JSON.stringify(detail ?? null)]).catch(() => undefined);
}

async function people(companyId: number) {
  return mq<RowDataPacket[]>(`
    SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.company_id = ? AND m.status = 'active' ORDER BY u.name`, [companyId]);
}

export async function registerLocations(app: FastifyInstance): Promise<void> {

  /* ------------------------------------------------------ platform admin */

  app.get('/api/platform/companies/:id/group', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const g = await groupOf(id);
    const isLocation = !!g && g.parentId !== id;
    const here = await people(id);
    /* At a location: the parent's people who are not here yet, owners included,
       so anybody missed at creation can be pulled over afterwards. */
    let parentPeople: RowDataPacket[] = [];
    if (isLocation) {
      const ids = new Set(here.map(p => Number(p.id)));
      parentPeople = (await people(g!.parentId)).filter(p => !ids.has(Number(p.id)));
    }
    return { group: g, shops: g ? await shopsInGroup(g.id) : [], isLocation, people: here, parentPeople };
  });

  /** Pull people from the parent into this location after it was created. */
  app.post('/api/platform/companies/:id/bring', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const g = await groupOf(id);
    if (!g || g.parentId === id) return reply.code(400).send({ error: 'This shop is not a location.' });
    const { userIds } = req.body as { userIds?: number[] };
    try {
      const n = await bringPeople(g.parentId, id, (userIds ?? []).map(Number));
      await paudit(ctx.user.id, id, 'location.people_added', { from: g.parentId, userIds });
      return { ok: true, added: n, seatWarning: seatWarning(await seatUse(id)) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** A new location under this shop: provisioned, joined to the group, set up from the parent. */
  app.post('/api/platform/companies/:id/locations', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as { name?: string; slug?: string; city?: string; state?: string;
      extraSeatBlocks?: number; bringUserIds?: number[] };
    if (!b.name || !b.slug) return reply.code(400).send({ error: 'Name and slug are required.' });
    try {
      const out = await createLocation(id, {
        name: b.name, slug: b.slug, city: b.city, state: b.state,
        extraSeatBlocks: b.extraSeatBlocks, bringUserIds: b.bringUserIds
      }, ctx.user.id);
      await paudit(ctx.user.id, out.companyId, 'location.created', { parent: id, ...out });
      return out;
    } catch (e) {
      req.log.error(e);
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /* ------------------------------------------------- inside a shop */

  /**
   * The group as this shop sees it. The parent's admins see the bill and the
   * combined-reports grants; a location's admins see the shops they can bring
   * people from.
   */
  app.get('/api/locations', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const g = await groupOf(cid);
    if (!g) return { group: null };
    const isParent = g.parentId === cid;
    const shops = (await shopsInGroup(g.id)).map(s => ({ id: s.id, name: s.name, city: s.city, isParent: !!Number(s.is_parent) }));
    const out: Record<string, unknown> = { group: g, isParent, shops };
    if (ctx.caps.admin && isParent) {
      out.bill = await groupBill(g.id);
      const granted = await mq<RowDataPacket[]>('SELECT user_id FROM group_report_grants WHERE group_id = ?', [g.id]);
      const set = new Set(granted.map(r => Number(r.user_id)));
      out.grants = (await people(cid)).map(p => ({ id: p.id, name: p.name, role: p.role, granted: set.has(Number(p.id)) }));
    }
    return out;
  });

  app.put('/api/locations/grants', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id;
    const g = await groupOf(cid);
    if (!g || g.parentId !== cid) return reply.code(403).send({ error: 'Combined reports are granted at the parent shop.' });
    const { userId, on } = req.body as { userId: number; on: boolean };
    const mem = await mqOne<RowDataPacket>("SELECT 1 AS x FROM memberships WHERE user_id = ? AND company_id = ? AND status = 'active'", [userId, cid]);
    if (!mem) return reply.code(400).send({ error: 'Not on this shop.' });
    await setGrant(g.id, Number(userId), !!on, ctx.user.id);
    return { ok: true };
  });

  /** People at another shop in the group who are not here yet. */
  app.get('/api/locations/people', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id;
    const from = Number((req.query as { from?: string }).from);
    const a = await groupOf(cid), b = await groupOf(from);
    if (!a || !b || a.id !== b.id || from === cid) return reply.code(400).send({ error: 'Pick another shop in the group.' });
    const here = new Set((await people(cid)).map(p => Number(p.id)));
    return { people: (await people(from)).filter(p => !here.has(Number(p.id))) };
  });

  app.post('/api/locations/bring', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id;
    const { fromId, userIds } = req.body as { fromId: number; userIds: number[] };
    try {
      const n = await bringPeople(Number(fromId), cid, (userIds ?? []).map(Number));
      return { ok: true, added: n, seatWarning: seatWarning(await seatUse(cid)) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /* ------------------------------------------------------------- tax */

  app.get('/api/admin/tax', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    return { rule: await taxRule(ctx.company!.id), parts: TAX_PARTS, presets: STATE_PRESETS };
  });

  app.put('/api/admin/tax', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const b = req.body as { rate?: number; applies?: string[] };
    const rate = Number(b.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 20) return reply.code(400).send({ error: 'The rate is a percentage between 0 and 20.' });
    await saveTaxRule(ctx.company!.id, Math.round(rate * 1000) / 1000,
      (b.applies ?? []).filter((p): p is TaxPart => TAX_PARTS.includes(p as TaxPart)));
    return { ok: true, rule: await taxRule(ctx.company!.id) };
  });
}
