/**
 * Move shops onto their own database logins — one at a time, verified, reversible.
 *
 *   npm run tenant-creds                    what it would do, touching nothing
 *   npm run tenant-creds -- --go            every shop still on the shared login
 *   npm run tenant-creds -- --go --shop 4   one shop
 *   npm run tenant-creds -- --revert --shop 4
 *   npm run tenant-creds -- --audit         who is on what, and does it hold
 *
 * Dry run is the default and there is no way to make it not the default except
 * by typing --go. It stops at the first failure rather than carrying on, since
 * a run that half worked across nine shops is worse than one that stopped at
 * the second.
 *
 * Each shop, in order: create the login, grant it its own database, prove it
 * can read that database and CANNOT read another or change the schema, and only
 * then repoint the row. Verification runs before the switch, so a shop is never
 * pointed at a login that has not been tested.
 */

import mysql from 'mysql2/promise';
import { RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { adminConnection, mexec, mq } from '../db/master';
import { forgetTenant } from '../db/tenant';
import {
  DERIVED_REF, deriveTenantPassword, dropTenantLogin, grantTenantLogin,
  tenantDbHostPattern, tenantDbUser, verifyTenantLogin
} from '../lib/tenant-credentials';

interface Row extends RowDataPacket {
  company_id: number;
  db_host: string;
  db_port: number;
  db_name: string;
  db_user: string;
  secret_ref: string;
  name: string;
  status: string;
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}
const has = (flag: string) => process.argv.includes(flag);

const GO = has('--go');
const REVERT = has('--revert');
const AUDIT = has('--audit');
const ONE = arg('--shop');

async function shops(): Promise<Row[]> {
  const only = ONE ? ' AND cd.company_id = ?' : '';
  return mq<Row[]>(
    `SELECT cd.company_id, cd.db_host, cd.db_port, cd.db_name, cd.db_user, cd.secret_ref,
            c.name, c.status
       FROM company_databases cd
       JOIN companies c ON c.id = cd.company_id
      WHERE c.status <> 'closed'${only}
      ORDER BY cd.company_id`,
    ONE ? [Number(ONE)] : []
  );
}

/** A connection as one shop's own login, for the verification step. */
function asTenant(row: Row) {
  return (user: string, password: string) => mysql.createConnection({
    host: row.db_host,
    port: row.db_port,
    user,
    password,
    ssl: config.db.ssl ?? (row.db_host === '127.0.0.1' || row.db_host === 'localhost'
      ? undefined : { rejectUnauthorized: true })
  });
}

async function main(): Promise<void> {
  const rows = await shops();
  if (!rows.length) {
    console.log(ONE ? `No open shop with id ${ONE}.` : 'No open shops.');
    return;
  }

  if (AUDIT) {
    console.log('\nshop  secret_ref  db_user                 login  reads  fenced  no-DDL  name');
    for (const r of rows) {
      const own = r.secret_ref === DERIVED_REF;
      let state = ['—', '—', '—', '—'];
      if (own) {
        const other = rows.find(x => x.company_id !== r.company_id)?.db_name ?? null;
        try {
          const v = await verifyTenantLogin(asTenant(r), r, other);
          state = ['yes', v.reads ? 'yes' : 'NO', v.blockedFromOthers ? 'yes' : 'NO',
                   v.blockedFromDdl ? 'yes' : 'NO'];
        } catch (err) {
          state = ['NO', '—', '—', '—'];
          console.log(`      #${r.company_id}: ${(err as Error).message}`);
        }
      }
      console.log(
        String(r.company_id).padEnd(6) + r.secret_ref.padEnd(12) + r.db_user.padEnd(24) +
        state[0].padEnd(7) + state[1].padEnd(7) + state[2].padEnd(8) + state[3].padEnd(8) + r.name
      );
    }
    console.log('');
    return;
  }

  if (REVERT) {
    if (!ONE) throw new Error('--revert needs --shop <id>. Reverting everything at once is not a thing you want by accident.');
    const r = rows[0];
    console.log(`Reverting shop #${r.company_id} (${r.name}) to the shared login…`);
    if (!GO) { console.log('Dry run. Add --go to do it.'); return; }
    await mexec(
      `UPDATE company_databases SET secret_ref = 'DEFAULT', db_user = ? WHERE company_id = ?`,
      [config.db.user, r.company_id]
    );
    forgetTenant(r.company_id);
    console.log(`Done. Its own login (${tenantDbUser(r.company_id)}) is left in place and unused — ` +
                'drop it by hand once you are sure.');
    return;
  }

  if (!config.tenantMasterSecret) {
    throw new Error(
      'TENANT_MASTER_SECRET is not set. Generate one and put it in .env first:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"\n" +
      'Keep a copy in a password manager — see Per-Tenant Credentials Plan.'
    );
  }

  const todo = rows.filter(r => r.secret_ref !== DERIVED_REF);
  const already = rows.length - todo.length;

  console.log(`\n${rows.length} open shop(s); ${already} already on their own login.`);
  if (!todo.length) { console.log('Nothing to do.\n'); return; }

  console.log(GO ? 'Running for real.\n' : 'DRY RUN — nothing will be changed. Add --go to act.\n');

  for (const r of todo) {
    const user = tenantDbUser(r.company_id);
    const host = tenantDbHostPattern(r.db_host);
    const other = rows.find(x => x.company_id !== r.company_id)?.db_name ?? null;

    console.log(`#${r.company_id} ${r.name}`);
    console.log(`   database ${r.db_name}  →  login ${user}@${host}`);
    console.log(`   grants   SELECT, INSERT, UPDATE, DELETE, EXECUTE on ${r.db_name}.* only`);

    if (!GO) {
      console.log(`   would set secret_ref = ${DERIVED_REF}, db_user = ${user}\n`);
      continue;
    }

    const admin = await adminConnection();
    try {
      await grantTenantLogin(admin, r);
      console.log('   login created and granted');

      const v = await verifyTenantLogin(asTenant(r), r, other);
      if (!v.ok) {
        throw new Error(
          `verification failed — reads own database: ${v.reads}, ` +
          `blocked from other databases: ${v.blockedFromOthers}, ` +
          `blocked from schema changes: ${v.blockedFromDdl}. ` +
          'The row has NOT been repointed; this shop is untouched and still working.'
        );
      }
      console.log('   verified: reads its own database, refused on another, refused on DDL');

      await mexec(
        `UPDATE company_databases SET secret_ref = ?, db_user = ? WHERE company_id = ?`,
        [DERIVED_REF, user, r.company_id]
      );
      forgetTenant(r.company_id);          // next request opens a pool as the new login
      console.log('   repointed. Open its board to confirm, then move on.\n');
    } catch (err) {
      console.error(`   FAILED: ${(err as Error).message}`);
      console.error(`   Stopping here. Shops before this one are done; #${r.company_id} and after are untouched.`);
      console.error(`   To undo this one: npm run tenant-creds -- --revert --shop ${r.company_id} --go\n`);
      process.exitCode = 1;
      await admin.end().catch(() => {});
      return;
    } finally {
      await admin.end().catch(() => {});
    }
  }

  console.log('All done. Next: npm run tenant-creds -- --audit\n');
  console.log('Once every shop reads DERIVED, strip the app account back to the master database:');
  console.log(`  REVOKE ALL PRIVILEGES ON \`es_%\`.* FROM '${config.db.user}'@'localhost';`);
  console.log('  FLUSH PRIVILEGES;');
  console.log('That last step is the one that actually closes the finding.\n');
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(err => { console.error(String(err instanceof Error ? err.message : err)); process.exit(1); });
