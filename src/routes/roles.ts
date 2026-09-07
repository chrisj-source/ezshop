import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mq, mexec } from '../db/master';
import { tq, texec, withTenantTx } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { CAP_DEFS, CapRow, RoleRow, byRank } from '../permissions';

/**
 * Roles and permissions the shop owns.
 *
 * A shop defines its own roles; we ship eight as a starting point. Two are
 * locked structurally — 'owner' (the platform, scheduler and calendar key off
 * it) and 'technician' (the lane rules hang off trades) — and neither can be
 * deleted, though both can be renamed and the Technician role can be given
 * anything on the list.
 *
 * Nothing here can reduce the owner: the capability rows for a locked-owner role
 * are ignored by `capsFromRows`, and this file refuses to write them.
 */

/** Roles a preset adds on top of what a shop already has. Never deletes. */
const PRESETS: Record<string, Array<{ key: string; label: string; rank: number; ownOnly?: boolean; caps: string[] }>> = {
  collision: [],
  hail: [
    { key: 'hail_adjuster', label: 'Hail adjuster', rank: 75,
      caps: ['ro_totals', 'sees_all', 'paperwork', 'imports', 'reports'] },
    { key: 'pdr_lead', label: 'PDR lead', rank: 45,
      caps: ['labour_money', 'sees_all', 'any_status', 'assign', 'reports'] },
    { key: 'canvasser', label: 'Canvasser', rank: 78, ownOnly: true, caps: ['leads'] }
  ],
  combination: [
    { key: 'hail_adjuster', label: 'Hail adjuster', rank: 75,
      caps: ['ro_totals', 'sees_all', 'paperwork', 'imports', 'reports'] },
    { key: 'pdr_lead', label: 'PDR lead', rank: 45,
      caps: ['labour_money', 'sees_all', 'any_status', 'assign', 'reports'] }
  ]
};

function keyFrom(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28) || 'role';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now() % 1000}`;
}

export async function registerRoles(app: FastifyInstance): Promise<void> {

  /** Is this the person who opened the shop? Only they may touch owners. */
  async function isOriginalOwner(companyId: number, userId: number): Promise<boolean> {
    const first = await mq<Array<RowDataPacket & { user_id: number }>>(
      `SELECT m.user_id FROM memberships m
       JOIN membership_roles mr ON mr.user_id = m.user_id AND mr.company_id = m.company_id
       WHERE m.company_id = ? AND mr.role_key = 'owner'
       ORDER BY m.created_at, m.user_id LIMIT 1`, [companyId]).catch(() => []);
    return !first.length || first[0].user_id === userId;
  }

  /* --------------------------------------------------------------- the grid */

  app.get('/api/roles', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;

    const roles = await tq<Array<RowDataPacket & RoleRow>>(cid,
      `SELECT role_key, label, rank_order, locked, own_only, is_custom, note FROM roles`);
    const caps = await tq<Array<RowDataPacket & CapRow>>(cid,
      `SELECT role_key, cap_key, can_see, can_change FROM role_caps`);

    const held = await mq<Array<RowDataPacket & { role_key: string; n: number }>>(
      `SELECT role_key, COUNT(*) AS n FROM membership_roles WHERE company_id = ? GROUP BY role_key`,
      [cid]);
    const people = new Map(held.map(h => [h.role_key, Number(h.n)]));

    /* Off-plan capabilities are not shown at all: the plan decides what the shop
       has, permissions decide who inside it gets it. */
    const defs = CAP_DEFS.filter(d => !d.feature || ctx.features.has(d.feature));

    return {
      caps: defs.map(d => ({ key: d.key, label: d.label, section: d.section, splits: !!d.change })),
      roles: roles.sort(byRank).map(r => ({
        key: r.role_key,
        label: r.label,
        rank: r.rank_order,
        locked: r.locked,
        ownOnly: !!r.own_only,
        custom: !!r.is_custom,
        note: r.note,
        people: people.get(r.role_key) ?? 0,
        caps: Object.fromEntries(defs.map(d => {
          const row = caps.find(c => c.role_key === r.role_key && c.cap_key === d.key);
          const all = r.locked === 'owner';
          return [d.key, {
            see: all || !!(row && row.can_see),
            change: d.change ? (all || !!(row && row.can_change)) : null
          }];
        }))
      })),
      canEdit: ctx.caps.managePermissions,
      isOriginalOwner: await isOriginalOwner(cid, ctx.user.id),
      presets: Object.keys(PRESETS)
    };
  });

  /* ------------------------------------------------------------ add, rename */

  app.post('/api/roles', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.managePermissions) return reply.code(403).send({ error: 'Not permitted' });

    const b = req.body as { label?: string; rank?: number; copyFrom?: string };
    const label = (b.label ?? '').trim();
    if (!label) return reply.code(400).send({ error: 'A name is required.' });

    const cid = ctx.company!.id;
    const existing = await tq<Array<RowDataPacket & { role_key: string; label: string }>>(cid,
      'SELECT role_key, label FROM roles');
    if (existing.some(r => r.label.toLowerCase() === label.toLowerCase())) {
      return reply.code(409).send({ error: 'A role by that name already exists.' });
    }

    const key = keyFrom(label, new Set(existing.map(r => r.role_key)));
    const rank = Number.isFinite(b.rank) ? Number(b.rank) : 100;

    await withTenantTx(cid, async (c) => {
      await c.query(
        `INSERT INTO roles (role_key, label, rank_order, locked, own_only, is_custom)
         VALUES (?, ?, ?, 'none', 0, 1)`, [key, label, rank]);

      if (b.copyFrom) {
        await c.query(
          `INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
           SELECT ?, cap_key, can_see, can_change FROM role_caps WHERE role_key = ?`,
          [key, b.copyFrom]);
        const [src] = await c.query<RowDataPacket[]>(
          'SELECT own_only FROM roles WHERE role_key = ?', [b.copyFrom]);
        if (src.length) {
          await c.query('UPDATE roles SET own_only = ? WHERE role_key = ?', [src[0].own_only, key]);
        }
      }
    });

    await audit(cid, ctx, key, 'role.added', { label, copiedFrom: b.copyFrom ?? null });
    return { ok: true, key };
  });

  app.patch('/api/roles/:key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.managePermissions) return reply.code(403).send({ error: 'Not permitted' });

    const key = (req.params as { key: string }).key;
    const b = req.body as { label?: string; rank?: number; ownOnly?: boolean };
    const cid = ctx.company!.id;

    const role = (await tq<Array<RowDataPacket & RoleRow>>(cid,
      'SELECT role_key, label, locked FROM roles WHERE role_key = ?', [key]))[0];
    if (!role) return reply.code(404).send({ error: 'No such role' });

    if (role.locked === 'owner' && !await isOriginalOwner(cid, ctx.user.id)) {
      return reply.code(403).send({ error: 'Only the shop’s original owner can change the Owner role.' });
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    const said: string[] = [];

    if (b.label !== undefined) {
      const label = b.label.trim();
      if (!label) return reply.code(400).send({ error: 'A role needs a name.' });
      sets.push('label = ?'); vals.push(label);
      said.push(`renamed to “${label}”`);
    }
    if (b.rank !== undefined && Number.isFinite(b.rank)) {
      sets.push('rank_order = ?'); vals.push(Number(b.rank));
      said.push(`ranked ${Number(b.rank)}`);
    }
    if (b.ownOnly !== undefined) {
      /* The owner always sees the whole shop. */
      if (role.locked === 'owner' && b.ownOnly) {
        return reply.code(400).send({ error: 'The Owner role always sees the whole shop.' });
      }
      sets.push('own_only = ?'); vals.push(b.ownOnly ? 1 : 0);
      said.push(b.ownOnly ? 'own work only' : 'sees the whole shop');
    }
    if (!sets.length) return { ok: true };

    vals.push(key);
    await texec(cid, `UPDATE roles SET ${sets.join(', ')} WHERE role_key = ?`, vals);
    await audit(cid, ctx, key, 'role.changed', { was: role.label, said });
    return { ok: true, said };
  });

  /* ------------------------------------------------------------------ ticks */

  app.post('/api/roles/:key/caps', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.managePermissions) return reply.code(403).send({ error: 'Not permitted' });

    const key = (req.params as { key: string }).key;
    const b = req.body as { cap?: string; see?: boolean; change?: boolean };
    const def = CAP_DEFS.find(d => d.key === b.cap);
    if (!def) return reply.code(400).send({ error: 'Unknown capability' });

    const cid = ctx.company!.id;
    const role = (await tq<Array<RowDataPacket & RoleRow>>(cid,
      'SELECT role_key, label, locked FROM roles WHERE role_key = ?', [key]))[0];
    if (!role) return reply.code(404).send({ error: 'No such role' });
    if (role.locked === 'owner') {
      return reply.code(400).send({ error: 'Owner capabilities cannot be reduced.' });
    }

    const see = b.see === true;
    const change = def.change ? b.change === true : false;
    /* Change without see is not a state anyone means. */
    const finalSee = change ? true : see;

    if (!finalSee && !change) {
      await texec(cid, 'DELETE FROM role_caps WHERE role_key = ? AND cap_key = ?', [key, def.key]);
    } else {
      await texec(cid, `
        INSERT INTO role_caps (role_key, cap_key, can_see, can_change) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE can_see = VALUES(can_see), can_change = VALUES(can_change)`,
        [key, def.key, finalSee ? 1 : 0, change ? 1 : 0]);
    }

    const n = await mq<Array<RowDataPacket & { n: number }>>(
      'SELECT COUNT(*) AS n FROM membership_roles WHERE company_id = ? AND role_key = ?', [cid, key]);
    await audit(cid, ctx, key, 'role.cap', { cap: def.key, see: finalSee, change });

    return {
      ok: true,
      /* The screen says how many people this just moved. They pick it up on
         their next page load — no session is torn down. */
      affected: Number(n[0]?.n ?? 0)
    };
  });

  /* ----------------------------------------------------------------- delete */

  app.delete('/api/roles/:key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.managePermissions) return reply.code(403).send({ error: 'Not permitted' });

    const key = (req.params as { key: string }).key;
    const moveTo = (req.query as { moveTo?: string }).moveTo;
    const cid = ctx.company!.id;

    const roles = await tq<Array<RowDataPacket & RoleRow>>(cid,
      'SELECT role_key, label, locked FROM roles');
    const role = roles.find(r => r.role_key === key);
    if (!role) return reply.code(404).send({ error: 'No such role' });
    if (role.locked !== 'none') {
      return reply.code(400).send({
        error: role.locked === 'owner'
          ? 'The Owner role cannot be deleted.'
          : 'The Technician role cannot be deleted — the lane rules hang off it.'
      });
    }

    const holders = await mq<Array<RowDataPacket & { user_id: number }>>(
      'SELECT user_id FROM membership_roles WHERE company_id = ? AND role_key = ?', [cid, key]);

    if (holders.length) {
      if (!moveTo || !roles.some(r => r.role_key === moveTo)) {
        return reply.code(409).send({
          error: `${holders.length} ${holders.length === 1 ? 'person holds' : 'people hold'} this role. Pick a role to move them to.`,
          holders: holders.length,
          needsMoveTo: true
        });
      }
      for (const h of holders) {
        await mexec(
          `INSERT IGNORE INTO membership_roles (user_id, company_id, role_key) VALUES (?, ?, ?)`,
          [h.user_id, cid, moveTo]);
      }
      await mexec('DELETE FROM membership_roles WHERE company_id = ? AND role_key = ?', [cid, key]);
      /* memberships.role is an eight-value ENUM from before roles were the
         shop's own. Only write it back when the target is one of those; the
         truth is membership_roles either way. */
      await mexec(
        `UPDATE memberships SET role = ? WHERE company_id = ? AND role = ?`, [moveTo, cid, key]
      ).catch(() => undefined);
    }

    /* Statuses that named this role as their owner fall back to the role people
       were moved to, so notifications keep landing somewhere. */
    const orphaned = await texec(cid,
      'UPDATE statuses SET owner_role = ? WHERE owner_role = ?',
      [moveTo ?? 'owner', role.label]).catch(() => ({ affectedRows: 0 }));

    await texec(cid, 'DELETE FROM roles WHERE role_key = ?', [key]);
    await audit(cid, ctx, key, 'role.deleted', {
      label: role.label, movedTo: moveTo ?? null, holders: holders.length,
      statusesRepointed: orphaned.affectedRows ?? 0
    });

    return { ok: true, moved: holders.length, statusesRepointed: orphaned.affectedRows ?? 0 };
  });

  /* ---------------------------------------------------------------- presets */

  app.post('/api/roles/preset', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.managePermissions) return reply.code(403).send({ error: 'Not permitted' });

    const name = String((req.body as { preset?: string }).preset ?? '').toLowerCase();
    const add = PRESETS[name];
    if (!add) return reply.code(400).send({ error: 'Unknown preset' });

    const cid = ctx.company!.id;
    const have = new Set((await tq<Array<RowDataPacket & { role_key: string }>>(cid,
      'SELECT role_key FROM roles')).map(r => r.role_key));

    const added: string[] = [];
    for (const r of add) {
      if (have.has(r.key)) continue;
      await texec(cid,
        `INSERT INTO roles (role_key, label, rank_order, locked, own_only, is_custom, note)
         VALUES (?, ?, ?, 'none', ?, 0, 'Added by the ${name} preset')`,
        [r.key, r.label, r.rank, r.ownOnly ? 1 : 0]);
      for (const cap of r.caps) {
        await texec(cid,
          `INSERT IGNORE INTO role_caps (role_key, cap_key, can_see, can_change) VALUES (?, ?, 1, 0)`,
          [r.key, cap]);
      }
      added.push(r.label);
    }

    await audit(cid, ctx, name, 'roles.preset', { added });

    /* Only ever adds. A shop that has built its own board keeps it. */
    return {
      ok: true, added,
      note: added.length
        ? `Added ${added.join(', ')}. Nothing existing was changed.`
        : 'Everything in that preset is already here.'
    };
  });
}

async function audit(
  cid: number,
  ctx: { user: { id: number; name: string } },
  entityId: string,
  action: string,
  detail: unknown
): Promise<void> {
  await texec(cid,
    `INSERT INTO audit_log (user_id, user_name, entity, action, detail) VALUES (?, ?, 'role', ?, ?)`,
    [ctx.user.id, ctx.user.name, action, JSON.stringify({ role: entityId, ...(detail as object) })]
  ).catch(() => undefined);
}
