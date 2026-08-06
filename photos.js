/**
 * Migration runner.
 *
 *   npm run build && npm run migrate
 *
 * Applies every numbered .sql in db/migrations/master to the control-plane
 * database, and every one in db/migrations/tenant to each shop database,
 * skipping what a database already has. Safe to run repeatedly.
 *
 * Tenant version lives in company_databases.schema_version — the schema shipped
 * with the app is version 1, so a tenant migration numbered 002 runs on any
 * database still at 1.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { RowDataPacket } from 'mysql2/promise';
import { adminConnection, closeMaster, master, mexec, mq } from '../db/master';

const DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

interface Step { version: number; name: string; sql: string; }

async function stepsIn(sub: string): Promise<Step[]> {
  const dir = path.join(DIR, sub);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const steps: Step[] = [];
  for (const n of names.filter(n => n.endsWith('.sql')).sort()) {
    const m = /^(\d+)[_-](.+)\.sql$/.exec(n);
    if (!m) continue;
    steps.push({
      version: Number(m[1]),
      name: m[2].replace(/_/g, ' '),
      sql: await fs.readFile(path.join(dir, n), 'utf8')
    });
  }
  return steps;
}

/** Split on semicolons that end a statement, ignoring those inside strings. */
function statements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(s => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(s => s.length > 0);
}

async function runMaster(): Promise<void> {
  const steps = await stepsIn('master');
  if (!steps.length) return;

  // The bookkeeping table is itself migration 001, so create it first.
  const conn = await adminConnection();
  try {
    await conn.query(`USE \`${process.env.MASTER_DB ?? 'easyshop_master'}\``);
    for (const s of statements(steps[0].sql)) await conn.query(s);
  } finally {
    await conn.end().catch(() => {});
  }

  const [meta] = await mq<Array<RowDataPacket & { version: number }>>(
    'SELECT version FROM schema_meta WHERE id = 1');
  let at = Number(meta?.version ?? 1);

  for (const s of steps) {
    if (s.version <= at) continue;
    console.log(`master  ${String(s.version).padStart(3, '0')}  ${s.name}`);
    for (const stmt of statements(s.sql)) await mexec(stmt);
    await mexec('UPDATE schema_meta SET version = ? WHERE id = 1', [s.version]);
    at = s.version;
  }

  console.log(`master at version ${at}`);
}

async function runTenants(): Promise<void> {
  const steps = await stepsIn('tenant');
  if (!steps.length) { console.log('no tenant migrations'); return; }

  const dbs = await mq<Array<RowDataPacket & {
    company_id: number; db_name: string; schema_version: number;
  }>>(`SELECT cd.company_id, cd.db_name, cd.schema_version, c.name
       FROM company_databases cd JOIN companies c ON c.id = cd.company_id
       ORDER BY cd.company_id`);

  if (!dbs.length) { console.log('no tenant databases yet'); return; }

  for (const db of dbs) {
    const pending = steps.filter(s => s.version > Number(db.schema_version ?? 1));
    if (!pending.length) {
      console.log(`${db.db_name} already at ${db.schema_version}`);
      continue;
    }

    const conn = await adminConnection();
    try {
      await conn.query(`USE \`${db.db_name}\``);
      for (const s of pending) {
        console.log(`${db.db_name}  ${String(s.version).padStart(3, '0')}  ${s.name}`);
        for (const stmt of statements(s.sql)) {
          try {
            await conn.query(stmt);
          } catch (e) {
            const msg = (e as Error).message;
            // Re-running a partially applied migration should not stop the world.
            if (/Duplicate column|Duplicate key name|already exists/i.test(msg)) {
              console.log(`  (skipped: ${msg})`);
              continue;
            }
            throw e;
          }
        }
        await mexec('UPDATE company_databases SET schema_version = ?, migrated_at = NOW() WHERE company_id = ?',
          [s.version, db.company_id]);
      }
    } finally {
      await conn.end().catch(() => {});
    }
  }
}

async function main(): Promise<void> {
  await runMaster();
  await runTenants();
  await closeMaster();
  console.log('\ndone');
}

main().catch(async err => {
  console.error('\nmigration failed:', err.message);
  await closeMaster().catch(() => {});
  process.exit(1);
});
