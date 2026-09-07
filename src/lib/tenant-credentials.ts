import crypto from 'node:crypto';
import { Connection } from 'mysql2/promise';
import { config } from '../config';
import { TenantLocation } from '../db/tenant';

/**
 * One database login per shop.
 *
 * Until a0.2.7 every tenant row carried `db_user = <the app's own account>` and
 * `secret_ref = 'DEFAULT'`, so a single MySQL login opened every shop's
 * database. The per-shop credential the master schema clearly anticipated had
 * simply never been built.
 *
 * What this buys, precisely: a query that ends up pointed at the wrong database
 * is refused by MySQL rather than returning another shop's cars, and an
 * injected statement can neither read `es_someoneelse` nor DROP a table. What
 * it does not buy: protection from the app process itself being taken over —
 * one process serves every shop, so it must be able to reach every shop. This
 * is a containment boundary, not a wall.
 *
 * Passwords are **derived, never stored**: HMAC-SHA256 over a string naming the
 * shop, keyed by TENANT_MASTER_SECRET. Nothing new to keep in sync, and
 * provisioning needs no secret-writing step. The master secret is not an
 * encryption key — losing it costs an hour of resetting logins, not any data.
 * Leaking it is worth exactly what the old shared credential was worth.
 *
 * The company's numeric id is the input, not its slug: a shop can be renamed
 * and its password should not move when it is. The version prefix is what makes
 * rotation possible later without redesigning any of this — bump it, re-derive,
 * ALTER USER, drop the pool.
 */

/** Bump to rotate every shop's password. Nothing reads this but the derivation. */
const DERIVATION_VERSION = 1;

/** The value in `company_databases.secret_ref` that means "derive it". */
export const DERIVED_REF = 'DERIVED';

/** The MySQL login for a shop. Stable across renames, inside MySQL's 32 chars. */
export function tenantDbUser(companyId: number): string {
  return `es_t${companyId}`;
}

/**
 * The password for a shop's login.
 *
 * base64url of the MAC, truncated to 40 characters — comfortably inside
 * MySQL's limit, and no quoting surprises in a GRANT statement or a .env file.
 */
export function deriveTenantPassword(companyId: number): string {
  const secret = config.tenantMasterSecret;
  if (!secret) {
    throw new Error(
      'TENANT_MASTER_SECRET is not set, so per-shop database passwords cannot be ' +
      'computed. Set it in .env (see DEPLOY.md) or put the shop back on the ' +
      'shared login with: UPDATE company_databases SET secret_ref = \'DEFAULT\' WHERE company_id = ?'
    );
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`es-tenant:v${DERIVATION_VERSION}:${companyId}`)
    .digest('base64url')
    .slice(0, 40);
}

/**
 * The password to open one tenant's pool.
 *
 * Deliberately loud: a row that says DERIVED with no master secret takes that
 * shop's screens down with a sentence naming the shop and the fix, rather than
 * quietly reaching for the shared login. A silent fallback is how a half-done
 * migration looks finished for six months.
 */
export function tenantPassword(loc: TenantLocation): string {
  if (loc.secret_ref === DERIVED_REF) {
    try {
      return deriveTenantPassword(loc.company_id);
    } catch (err) {
      throw new Error(
        `Shop #${loc.company_id} (${loc.db_name}) uses its own database login and ` +
        `the server cannot compute its password. ${(err as Error).message}`
      );
    }
  }
  return config.tenantSecret(loc.secret_ref);
}

/* ------------------------------------------------------------------- MySQL */

/**
 * Which hosts the login may connect from.
 *
 * Loopback databases get 'localhost' — the tightest thing that works. Anything
 * off-box has to accept the app's address, and we do not reliably know it from
 * here, so '%' with a strong derived password and TLS (forced for off-box
 * tenants since a0.2.5) is the honest answer. Narrow it by hand if the app has
 * a fixed address.
 */
export function tenantDbHostPattern(dbHost: string): string {
  return dbHost === '127.0.0.1' || dbHost === '::1' || dbHost === 'localhost' ? 'localhost' : '%';
}

/**
 * Create (or reset) a shop's login and scope it to that one database.
 *
 * Read and write only: no CREATE, ALTER or DROP. Migrations keep running on the
 * admin connection, which means an injected statement cannot rewrite the schema
 * it is running against. EXECUTE is there for stored routines the schema may
 * grow; it grants nothing on its own.
 *
 * Runs on an admin connection. Idempotent — safe to re-run for a shop that
 * already has a login, which is what makes the migration script re-runnable.
 */
export async function grantTenantLogin(
  admin: Connection,
  loc: { company_id: number; db_name: string; db_host: string }
): Promise<{ user: string; host: string }> {
  const user = tenantDbUser(loc.company_id);
  const host = tenantDbHostPattern(loc.db_host);
  const password = deriveTenantPassword(loc.company_id);

  /* Identifiers cannot be parameterised, so the database name is interpolated —
     it comes from our own provisioner, never from user input. The user, host and
     password go through the driver's placeholders, which for `query` (as opposed
     to `execute`) is client-side escaping: GRANT and CREATE USER are not
     preparable statements on MySQL, so a server-side bind is not available. */
  await admin.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [user, host, password]);
  /* CREATE USER IF NOT EXISTS leaves an existing password alone, so set it
     explicitly — otherwise a re-run against a shop whose login exists with a
     different password silently does nothing and the app cannot connect. */
  await admin.query(`ALTER USER ?@? IDENTIFIED BY ?`, [user, host, password]);

  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON \`${loc.db_name}\`.* TO ?@?`,
    [user, host]
  );
  await admin.query('FLUSH PRIVILEGES');

  return { user, host };
}

/** Remove a shop's login. Used by provisioning's rollback and by teardown. */
export async function dropTenantLogin(
  admin: Connection,
  loc: { company_id: number; db_host: string }
): Promise<void> {
  const user = tenantDbUser(loc.company_id);
  const host = tenantDbHostPattern(loc.db_host);
  await admin.query(`DROP USER IF EXISTS ?@?`, [user, host]);
  await admin.query('FLUSH PRIVILEGES');
}

/**
 * Prove the login works and is properly fenced in, before anything is repointed
 * at it. Three questions: can it read its own database, can it reach another
 * one, can it change the schema. The second and third must fail.
 */
export async function verifyTenantLogin(
  makeConnection: (user: string, password: string) => Promise<Connection>,
  loc: { company_id: number; db_name: string; db_host: string },
  someOtherDb: string | null
): Promise<{ ok: boolean; reads: boolean; blockedFromOthers: boolean; blockedFromDdl: boolean }> {
  const user = tenantDbUser(loc.company_id);
  const conn = await makeConnection(user, deriveTenantPassword(loc.company_id));

  let reads = false, blockedFromOthers = true, blockedFromDdl = true;
  try {
    await conn.query(`SELECT COUNT(*) AS n FROM \`${loc.db_name}\`.repair_orders`);
    reads = true;

    if (someOtherDb) {
      try {
        await conn.query(`SELECT 1 FROM \`${someOtherDb}\`.repair_orders LIMIT 1`);
        blockedFromOthers = false;   // it answered — the grant is too wide
      } catch { /* refused, which is the point */ }
    }

    try {
      await conn.query(`CREATE TABLE \`${loc.db_name}\`.__perm_check (a INT)`);
      blockedFromDdl = false;
      await conn.query(`DROP TABLE IF EXISTS \`${loc.db_name}\`.__perm_check`).catch(() => {});
    } catch { /* refused, which is the point */ }
  } finally {
    await conn.end().catch(() => {});
  }

  return { ok: reads && blockedFromOthers && blockedFromDdl, reads, blockedFromOthers, blockedFromDdl };
}
