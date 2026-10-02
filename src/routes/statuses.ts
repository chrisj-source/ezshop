import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mexec, mqOne } from '../db/master';
import { tq } from '../db/tenant';
import { capsAt, requireCompany, requirePlatformOwner } from '../middleware/context';
import { addStatus, NewStatus, reorderGroup } from '../lib/statuses';
import { groupOf, shopsInGroup } from '../lib/locations';

async function paudit(actor: number, companyId: number, action: string, detail: unknown): Promise<void> {
  await mexec('INSERT INTO platform_audit (actor_user_id, company_id, action, detail) VALUES (?, ?, ?, ?)',
    [actor, companyId, action, JSON.stringify(detail ?? null)]).catch(() => undefined);
}

/** The other shops in this one's group where this person is an admin. */
async function adminLocations(userId: number, companyId: number) {
  const g = await groupOf(companyId);
  if (!g) return [];
  const out: Array<{ id: number; name: string; city: string | null }> = [];
  for (const s of await shopsInGroup(g.id)) {
    if (Number(s.id) === companyId) continue;
    if ((await capsAt(userId, Number(s.id))).admin) out.push({ id: Number(s.id), name: String(s.name), city: s.city ?? null });
  }
  return out;
}

export async function registerStatuses(app: FastifyInstance): Promise<void> {

  /* ------------------------------------------------------------- the shop */

  /** Where else an added status can go, for the add form. */
  app.get('/api/config/statuses/locations', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    return { locations: await adminLocations(ctx.user.id, ctx.company!.id) };
  });

  app.post('/api/config/statuses', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const b = req.body as NewStatus & { alsoAt?: number[] };
    const actor = { id: ctx.user.id, name: ctx.user.name };

    let made;
    try { made = await addStatus(ctx.company!.id, b, actor); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }

    /* Each location is checked again here, not trusted from the form. A copy
       that does not fit there (no such group, lane not in it, a name already
       taken) is reported and skipped; the one here stands either way. */
    const allowed = new Map((await adminLocations(ctx.user.id, ctx.company!.id)).map(l => [l.id, l.name]));
    const elsewhere: Array<{ id: number; name: string; ok: boolean; note?: string }> = [];
    for (const id of (b.alsoAt ?? []).map(Number)) {
      const name = allowed.get(id);
      if (!name) { elsewhere.push({ id, name: 'That shop', ok: false, note: 'You are not an admin there.' }); continue; }
      try {
        await addStatus(id, b, actor, made.slotId);
        elsewhere.push({ id, name, ok: true });
      } catch (e) {
        elsewhere.push({ id, name, ok: false, note: (e as Error).message });
      }
    }
    return { ok: true, slotId: made.slotId, elsewhere };
  });

  app.put('/api/config/statuses/order', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const b = req.body as { groupId?: string; slots?: string[] };
    if (!b.groupId || !Array.isArray(b.slots)) return reply.code(400).send({ error: 'Nothing to order.' });
    await reorderGroup(ctx.company!.id, b.groupId, b.slots.map(String));
    return { ok: true };
  });

  /* ------------------------------------------------- platform, for one shop */

  app.get('/api/platform/companies/:id/statuses', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const [groups, lanes, statuses] = await Promise.all([
      tq<RowDataPacket[]>(id, 'SELECT group_id, label FROM status_groups ORDER BY sort_order'),
      tq<RowDataPacket[]>(id, 'SELECT lane_key, label, enabled FROM lanes ORDER BY sort_order'),
      tq<RowDataPacket[]>(id, `SELECT s.slot_id, s.group_id, s.lane_key, s.label, s.kind, s.visible, s.is_custom
                                 FROM statuses s JOIN status_groups g ON g.group_id = s.group_id
                                ORDER BY g.sort_order, s.sort_order`)
    ]);
    return { groups, lanes, statuses };
  });

  app.post('/api/platform/companies/:id/statuses', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const co = await mqOne<RowDataPacket>('SELECT id FROM companies WHERE id = ?', [id]);
    if (!co) return reply.code(404).send({ error: 'No such shop.' });
    const b = req.body as NewStatus;
    try {
      const made = await addStatus(id, b, { id: ctx.user.id, name: `${ctx.user.name} (Easy Shop support)` });
      await paudit(ctx.user.id, id, 'status.added', { slot: made.slotId, group: b.groupId, label: b.label });
      return { ok: true, slotId: made.slotId };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
