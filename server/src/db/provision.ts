import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { adminConnection, mexec, mqOne } from './master';
import { buildTemplate, toHours, NOTIF_GROUPS, ShopType } from './status-template';
import { hashPassword } from '../auth/password';

const TENANT_SQL = path.join(__dirname, '..', '..', 'db', 'tenant.sql');

export interface ProvisionInput {
  name: string;
  slug: string;
  city?: string;
  state?: string;
  timezone?: string;
  shopType: ShopType;
  planCode?: string;
  seats?: number;
  ownerName: string;
  ownerEmail: string;
  ownerPassword?: string;
  actorUserId?: number | null;
}

export interface ProvisionResult {
  companyId: number;
  dbName: string;
  ownerUserId: number;
  statusCount: number;
  tempPassword: string | null;
}

const SLUG_OK = /^[a-z][a-z0-9]{1,30}$/;

/**
 * Create a company: master row, its own database, the tenant schema, the
 * status template for its shop type, and one owner login.
 *
 * Not transactional across both databases — MariaDB cannot roll back DDL.
 * On failure the tenant database is dropped and the master rows removed.
 */
export async function provisionCompany(input: ProvisionInput): Promise<ProvisionResult> {
  const slug = input.slug.toLowerCase().trim();
  if (!SLUG_OK.test(slug)) {
    throw new Error('Slug must be lowercase letters and digits, starting with a letter, 2-31 characters.');
  }

  const dbName = `es_${slug}`;
  const clash = await mqOne<RowDataPacket>('SELECT id FROM companies WHERE slug = ?', [slug]);
  if (clash) throw new Error(`A company with slug "${slug}" already exists.`);

  const schema = await fs.readFile(TENANT_SQL, 'utf8');

  let companyId = 0;
  const admin = await adminConnection();

  try {
    const res = await mexec(
      `INSERT INTO companies (slug, name, city, state, timezone, shop_type, plan_code, status, seats, owner_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [slug, input.name, input.city ?? null, input.state ?? null, input.timezone ?? 'America/Chicago',
       input.shopType, input.planCode ?? 'trial',
       (input.planCode ?? 'trial') === 'trial' ? 'trial' : 'active',
       input.seats ?? 5, input.ownerEmail]
    );
    companyId = res.insertId;

    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE \`${dbName}\``);
    await admin.query(schema);

    await mexec(
      `INSERT INTO company_databases (company_id, db_host, db_port, db_name, db_user, secret_ref, schema_version, migrated_at)
       VALUES (?, ?, ?, ?, ?, 'DEFAULT', 1, NOW())`,
      [companyId, config.db.host, config.db.port, dbName, config.db.user]
    );

    const statusCount = await seedTenant(admin, dbName, input.shopType);

    const tempPassword = input.ownerPassword ?? randomPassword();
    const ownerUserId = await createOwner(
      companyId, input.ownerName, input.ownerEmail, tempPassword, !input.ownerPassword
    );

    await admin.query(
      `INSERT INTO staff (user_id, display_name, position_key, active) VALUES (?, ?, 'office', 1)`,
      [ownerUserId, input.ownerName]
    );

    await mexec('UPDATE companies SET provisioned_at = NOW() WHERE id = ?', [companyId]);
    await mexec(
      `INSERT INTO platform_audit (actor_user_id, company_id, action, detail)
       VALUES (?, ?, 'company.provisioned', ?)`,
      [input.actorUserId ?? null, companyId,
       JSON.stringify({ slug, dbName, shopType: input.shopType, statusCount })]
    );

    return {
      companyId, dbName, ownerUserId, statusCount,
      tempPassword: input.ownerPassword ? null : tempPassword
    };
  } catch (err) {
    try { await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``); } catch { /* nothing to undo */ }
    if (companyId) {
      try { await mexec('DELETE FROM companies WHERE id = ?', [companyId]); } catch { /* cascade */ }
    }
    throw err;
  } finally {
    await admin.end().catch(() => {});
  }
}

/** Seeds lanes, status groups, statuses and the notification groups. */
async function seedTenant(admin: Connection, dbName: string, shopType: ShopType): Promise<number> {
  const { groups, lanes } = buildTemplate(shopType);
  await admin.query(`USE \`${dbName}\``);

  let laneOrder = 0;
  for (const l of lanes) {
    await admin.query(
      `INSERT INTO lanes (lane_key, label, enabled, parts_gate, owner_role, module_tag, sort_order)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      [l.key, l.name, l.gate, l.owner, l.mod, ++laneOrder]
    );
  }

  let groupOrder = 0;
  let count = 0;
  for (const g of groups) {
    await admin.query(
      'INSERT INTO status_groups (group_id, label, sort_order, note) VALUES (?, ?, ?, ?)',
      [g.id, g.name, ++groupOrder, g.note || null]
    );
    let sub = 0;
    for (const s of g.slots) {
      await admin.query(
        `INSERT INTO statuses
           (slot_id, group_id, lane_key, label, customer_label, kind, owner_role,
            age_yellow_hours, age_red_hours, follow_up_hours, module_tags, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s[0], g.id, laneKeyForSlot(s[0]), s[1], s[2] || null, s[3], s[4],
         toHours(s[5]), toHours(s[6]), toHours(s[7]), s[8] || null, ++sub]
      );
      count++;
    }
  }

  for (const ng of NOTIF_GROUPS) {
    const [r] = await admin.query<ResultSetHeader>(
      'INSERT INTO notification_groups (name, description) VALUES (?, ?)', [ng.name, ng.note]
    );
    const gid = r.insertId;
    for (const p of ng.positions) {
      await admin.query(
        `INSERT INTO notification_group_members (group_id, member_type, position_key, user_id)
         VALUES (?, 'position', ?, 0)`, [gid, p]
      );
    }
    for (const e of ng.events) {
      await admin.query(
        `INSERT INTO notification_subscriptions (group_id, event_key, enabled, scope, channel_app)
         VALUES (?, ?, 1, 'owned', 1)`, [gid, e]
      );
    }
  }

  return count;
}

function laneKeyForSlot(slot: string): string | null {
  const m = /^lane\.([a-z]+)\./.exec(slot);
  return m ? m[1] : null;
}

async function createOwner(
  companyId: number, name: string, email: string, password: string, mustChange: boolean
): Promise<number> {
  const existing = await mqOne<RowDataPacket & { id: number }>('SELECT id FROM users WHERE email = ?', [email]);
  let userId: number;

  if (existing) {
    userId = existing.id;
  } else {
    const res = await mexec(
      'INSERT INTO users (email, password_hash, name, must_change_pw) VALUES (?, ?, ?, ?)',
      [email, await hashPassword(password), name, mustChange ? 1 : 0]
    );
    userId = res.insertId;
  }

  await mexec(
    `INSERT INTO memberships (user_id, company_id, role) VALUES (?, ?, 'owner')
     ON DUPLICATE KEY UPDATE role = 'owner', status = 'active'`,
    [userId, companyId]
  );
  return userId;
}

function randomPassword(len = 18): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len)).map(b => alphabet[b % alphabet.length]).join('');
}

/** Drop a tenant database. Deliberately not wired to any HTTP route. */
export async function destroyCompany(companyId: number): Promise<void> {
  const loc = await mqOne<RowDataPacket & { db_name: string }>(
    'SELECT db_name FROM company_databases WHERE company_id = ?', [companyId]
  );
  const admin = await adminConnection();
  try {
    if (loc) await admin.query(`DROP DATABASE IF EXISTS \`${loc.db_name}\``);
    await mexec('DELETE FROM companies WHERE id = ?', [companyId]);
  } finally {
    await admin.end().catch(() => {});
  }
}
