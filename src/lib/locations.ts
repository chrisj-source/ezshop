import { RowDataPacket } from 'mysql2/promise';
import { adminConnection, mexec, mq, mqOne } from '../db/master';
import { provisionCompany } from '../db/provision';
import { forgetTenant } from '../db/tenant';
import { audit } from './audit';
import { activePlans, monthlyCentsOf } from './billing';

/**
 * Locations. A parent shop and the shops under it (QUEUE, "Locations",
 * 1 Oct 2026). Nothing is shared at run time: a new location gets COPIES of
 * the parent's setup when it is created, and is its own from then on.
 *
 * Copied: roles and permissions, the status notification grid and who hears
 * about a customer's text (roles carry notifications with them), labor and
 * shop settings including tax, and pay setup for any person brought across.
 * Not copied: files, clients, wholesale accounts, leads, vendors, statuses,
 * templates, wording, hours, the web form.
 */

/** Settings that describe the shop itself, not how it works — never copied. */
const NOT_COPIED_SETTINGS = ['shop_address', 'shop_phone'];

async function dbName(companyId: number): Promise<string> {
  const r = await mqOne<RowDataPacket & { db_name: string }>(
    'SELECT db_name FROM company_databases WHERE company_id = ?', [companyId]);
  if (!r) throw new Error('That shop has no database.');
  return r.db_name;
}

/** Columns present in both copies of a table — the two can drift. */
async function sharedColumns(admin: Awaited<ReturnType<typeof adminConnection>>,
  a: string, b: string, table: string): Promise<string[]> {
  const [rows] = await admin.query<RowDataPacket[]>(`
    SELECT x.COLUMN_NAME AS c FROM information_schema.COLUMNS x
      JOIN information_schema.COLUMNS y ON y.TABLE_SCHEMA = ? AND y.TABLE_NAME = x.TABLE_NAME AND y.COLUMN_NAME = x.COLUMN_NAME
     WHERE x.TABLE_SCHEMA = ? AND x.TABLE_NAME = ? ORDER BY x.ORDINAL_POSITION`, [b, a, table]);
  return rows.map(r => String(r.c));
}

async function copyTable(admin: Awaited<ReturnType<typeof adminConnection>>, from: string, to: string,
  table: string, opts: { where?: string; params?: unknown[]; wipe?: string | boolean } = {}): Promise<number> {
  const cols = await sharedColumns(admin, from, to, table);
  if (!cols.length) return 0;
  const list = cols.map(c => `\`${c}\``).join(', ');
  if (opts.wipe) {
    await admin.query(`DELETE FROM \`${to}\`.\`${table}\`${typeof opts.wipe === 'string' ? ` WHERE ${opts.wipe}` : ''}`, opts.params ?? []);
  }
  const [res] = await admin.query(
    `REPLACE INTO \`${to}\`.\`${table}\` (${list}) SELECT ${list} FROM \`${from}\`.\`${table}\`${opts.where ? ` WHERE ${opts.where}` : ''}`,
    opts.params ?? []);
  return Number((res as { affectedRows?: number }).affectedRows ?? 0);
}

export async function groupOf(companyId: number): Promise<{ id: number; name: string; parentId: number } | null> {
  const r = await mqOne<RowDataPacket & { id: number; name: string; parent_company_id: number }>(`
    SELECT g.id, g.name, g.parent_company_id FROM companies c JOIN company_groups g ON g.id = c.group_id
     WHERE c.id = ?`, [companyId]);
  return r ? { id: r.id, name: r.name, parentId: r.parent_company_id } : null;
}

export async function shopsInGroup(groupId: number) {
  return mq<RowDataPacket[]>(`
    SELECT c.id, c.name, c.city, c.state, c.plan_code, c.seats, c.extra_seat_blocks, c.status,
           g.parent_company_id = c.id AS is_parent,
           (SELECT COUNT(*) FROM memberships m WHERE m.company_id = c.id AND m.status = 'active') AS seats_used
      FROM companies c JOIN company_groups g ON g.id = c.group_id
     WHERE c.group_id = ? AND c.status <> 'closed'
     ORDER BY is_parent DESC, c.name`, [groupId]);
}

/** The parent's group, made on first use. */
async function ensureGroup(parentId: number): Promise<number> {
  const p = await mqOne<RowDataPacket & { name: string; group_id: number | null }>(
    'SELECT name, group_id FROM companies WHERE id = ?', [parentId]);
  if (!p) throw new Error('No such shop.');
  if (p.group_id) {
    const g = await mqOne<RowDataPacket & { parent_company_id: number }>(
      'SELECT parent_company_id FROM company_groups WHERE id = ?', [p.group_id]);
    if (g && Number(g.parent_company_id) !== parentId) throw new Error('That shop is a location of another shop, so it cannot be a parent.');
    return Number(p.group_id);
  }
  const r = await mexec('INSERT INTO company_groups (name, parent_company_id) VALUES (?, ?)', [p.name, parentId]);
  await mexec('UPDATE companies SET group_id = ? WHERE id = ?', [r.insertId, parentId]);
  return r.insertId;
}

/** The setup a location starts from. Idempotent: re-running overwrites the copies. */
async function cloneSetup(parentId: number, childId: number): Promise<Record<string, number>> {
  const from = await dbName(parentId), to = await dbName(childId);
  const admin = await adminConnection();
  const out: Record<string, number> = {};
  try {
    out.roles = await copyTable(admin, from, to, 'roles', { wipe: true });
    out.role_caps = await copyTable(admin, from, to, 'role_caps', { wipe: true });
    /* The status grid, only for statuses the location also has. */
    out.status_routes = await copyTable(admin, from, to, 'status_routes', {
      wipe: true, where: `slot_id IN (SELECT slot_id FROM \`${to}\`.statuses)` });
    out.sms_reply_routing = await copyTable(admin, from, to, 'sms_reply_routing', { wipe: true });
    out.shop_settings = await copyTable(admin, from, to, 'shop_settings', {
      where: 'setting_key NOT IN (?)', params: [NOT_COPIED_SETTINGS] });
  } finally {
    await admin.end();
  }
  forgetTenant(childId);
  return out;
}

/**
 * Bring people from one shop in the group to another: a membership with the
 * same roles, their profile and trades, and their pay setup. Each takes a seat
 * at the shop they join (seats warn, never refuse).
 */
export async function bringPeople(fromId: number, toId: number, userIds: number[]): Promise<number> {
  if (!userIds.length) return 0;
  const g1 = await groupOf(fromId), g2 = await groupOf(toId);
  if (!g1 || !g2 || g1.id !== g2.id) throw new Error('Both shops have to be in the same group.');
  const members = await mq<RowDataPacket[]>(`
    SELECT user_id, role, position_key FROM memberships
     WHERE company_id = ? AND status = 'active' AND user_id IN (?)`, [fromId, userIds]);
  for (const m of members) {
    await mexec(`INSERT INTO memberships (user_id, company_id, role, position_key) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE status = 'active'`, [m.user_id, toId, m.role, m.position_key]);
    await mexec(`INSERT IGNORE INTO membership_roles (user_id, company_id, role_key)
      SELECT user_id, ?, role_key FROM membership_roles WHERE company_id = ? AND user_id = ?`,
      [toId, fromId, m.user_id]).catch(() => undefined);
  }
  const ids = members.map(m => Number(m.user_id));
  if (!ids.length) return 0;
  const from = await dbName(fromId), to = await dbName(toId);
  const admin = await adminConnection();
  try {
    for (const t of ['staff', 'staff_positions', 'staff_pay_plans', 'pay_plans', 'pay_plan_deductions']) {
      await copyTable(admin, from, to, t, { where: 'user_id IN (?)', params: [ids] }).catch(() => 0);
    }
  } finally { await admin.end(); }
  forgetTenant(toId);
  return ids.length;
}

export interface NewLocation {
  name: string; slug: string; city?: string; state?: string; timezone?: string;
  extraSeatBlocks?: number; bringUserIds?: number[];
}

export async function createLocation(parentId: number, input: NewLocation, actorUserId: number) {
  const parent = await mqOne<RowDataPacket & { shop_type: string; owner_email: string | null; timezone: string; state: string | null }>(
    'SELECT shop_type, owner_email, timezone, state FROM companies WHERE id = ?', [parentId]);
  if (!parent) throw new Error('No such shop.');
  const owner = await mqOne<RowDataPacket & { name: string; email: string }>(`
    SELECT u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.company_id = ? AND m.role = 'owner' AND m.status = 'active' AND u.email IS NOT NULL
     ORDER BY u.email = ? DESC, m.id LIMIT 1`, [parentId, parent.owner_email ?? '']);
  if (!owner) throw new Error('The parent shop has no owner with an email to carry across.');

  const groupId = await ensureGroup(parentId);
  const res = await provisionCompany({
    name: input.name, slug: input.slug, city: input.city, state: input.state ?? parent.state ?? undefined,
    timezone: input.timezone ?? parent.timezone, shopType: parent.shop_type as never,
    planCode: 'location', extraSeatBlocks: input.extraSeatBlocks ?? 0,
    ownerName: owner.name, ownerEmail: owner.email, actorUserId
  } as never);
  await mexec('UPDATE companies SET group_id = ? WHERE id = ?', [groupId, res.companyId]);
  const copied = await cloneSetup(parentId, res.companyId);
  const brought = await bringPeople(parentId, res.companyId, (input.bringUserIds ?? []).map(Number));
  return { companyId: res.companyId, groupId, copied, brought, owner: owner.email };
}

/** For the parent owner: what the group costs, read-only. */
export async function groupBill(groupId: number) {
  const shops = await shopsInGroup(groupId);
  const plans = await activePlans();
  const byCode = new Map(plans.map(p => [p.code, p]));
  const rows = shops.map(s => ({
    id: s.id, name: s.name, isParent: !!Number(s.is_parent), plan: byCode.get(s.plan_code)?.label ?? s.plan_code,
    seats: Number(s.seats), seatsUsed: Number(s.seats_used), blocks: Number(s.extra_seat_blocks ?? 0),
    monthlyCents: monthlyCentsOf(byCode.get(s.plan_code) ?? null, Number(s.extra_seat_blocks ?? 0))
  }));
  return { shops: rows, totalCents: rows.reduce((a, r) => a + r.monthlyCents, 0) };
}

/** Is this person allowed to read reports for that shop from outside it? */
export async function mayReadReports(userId: number, fromCompanyId: number, targetId: number): Promise<boolean> {
  if (fromCompanyId === targetId) return true;
  const g = await groupOf(targetId);
  if (!g) return false;
  const here = await groupOf(fromCompanyId);
  if (!here || here.id !== g.id) return false;
  const r = await mqOne<RowDataPacket>('SELECT 1 AS x FROM group_report_grants WHERE group_id = ? AND user_id = ?', [g.id, userId]);
  return !!r;
}

export async function setGrant(groupId: number, userId: number, on: boolean, by: number): Promise<void> {
  if (on) await mexec('INSERT IGNORE INTO group_report_grants (group_id, user_id, granted_by) VALUES (?, ?, ?)', [groupId, userId, by]);
  else await mexec('DELETE FROM group_report_grants WHERE group_id = ? AND user_id = ?', [groupId, userId]);
}

/** Written in the shop that was read, so its own log shows who looked from outside. */
export async function auditOutsideRead(targetId: number, user: { id: number; name: string }, report: string): Promise<void> {
  await audit(targetId, { user, source: 'group' }, {
    entity: 'report', action: 'group_read', area: 'Access', sensitive: true,
    label: `${report} report read from another location` });
}
