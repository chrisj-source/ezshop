/**
 * Schema audit — does each shop database actually have what tenant.sql declares?
 *
 *   npm run schema-audit            report only
 *   npm run schema-audit -- --go    add what is missing
 *
 * Note the bare `--`: without it npm keeps the flag for itself and the script
 * runs in report mode regardless.
 *
 * Why this exists
 * ---------------
 * `db/tenant.sql` is the base schema a new shop is created from; the numbered
 * migrations are the schema as it actually grew. The two drift, and the
 * provisioner replays the migrations over the base file to cover that.
 *
 * On 15 Sep 2026 that cover was found to have a hole. A multi-clause
 * `ALTER TABLE` is atomic, so migration 002 — which adds `thumb_key`, `width`,
 * `height` and `is_image` in one statement — was rejected whole on any database
 * whose base file already had three of those four. `thumb_key` never landed,
 * the "already there" tolerance swallowed the error, and migration 008 then
 * failed on `AFTER thumb_key`. New shops could not be created.
 *
 * `db/alter.ts` fixes the cause: tolerance is now per clause, so the missing
 * column would have landed. But a shop provisioned BEFORE that fix is recorded
 * at the latest schema version while quietly missing a column, and
 * `npm run migrate` will never revisit it — it only runs migrations newer than
 * the version on record. There is no migration to write, because every other
 * database already has the column.
 *
 * So the repair is a comparison rather than a migration: read what tenant.sql
 * declares, read what the database has, and add the difference. It is
 * idempotent, it only ever ADDs, and it never drops or retypes anything —
 * a column the database has and the base file does not is reported and left
 * alone, because that is far more likely to be a migration this file has not
 * caught up with than something to delete.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { RowDataPacket } from 'mysql2/promise';
import { adminConnection, closeMaster, mq } from '../db/master';

const TENANT_SQL = path.join(__dirname, '..', '..', 'db', 'tenant.sql');

interface Declared { table: string; column: string; definition: string; after: string | null }

/**
 * A column definition has to begin with a type. This is the backstop that keeps
 * a misread line out of the generated DDL: on 15 Sep 2026 the first version of
 * this script read the second line of a block comment inside `repair_orders`
 * as a column named `declared` and reported it missing on every shop. Stripping
 * block comments fixed that instance; this makes the whole class impossible,
 * because prose does not start with BIGINT.
 */
const TYPE_START = new RegExp('^(' + [
  'BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'TINYINT', 'MEDIUMINT',
  'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'BIT',
  'VARCHAR', 'CHAR', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT',
  'BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB', 'BINARY', 'VARBINARY',
  'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR',
  'ENUM', 'SET', 'JSON', 'BOOLEAN', 'BOOL'
].join('|') + ')\\b', 'i');

/**
 * Columns declared in tenant.sql, per table, with enough of the definition to
 * recreate one. Deliberately a text scan of our own file rather than a general
 * SQL parser: we control the formatting, and a parser would be more to go wrong
 * than the thing it replaces.
 */
async function declaredColumns(): Promise<Declared[]> {
  const raw = await fs.readFile(TENANT_SQL, 'utf8');
  /* Block comments first, and across lines. tenant.sql carries a few of these
     INSIDE a CREATE TABLE body, and a line-by-line scan reads their second
     line as a column: the audit duly reported a missing column called
     `declared` on every shop. Strip them before anything else looks at the
     text. Line comments are handled per line below. */
  const sql = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Declared[] = [];

  for (const t of sql.matchAll(/CREATE TABLE\s+`?(\w+)`?\s*\(([\s\S]*?)\n\)\s*ENGINE/gi)) {
    const table = t[1];
    const lines = t[2].split('\n');
    let previous: string | null = null;

    for (const lineRaw of lines) {
      const line = lineRaw.trim().replace(/,\s*$/, '');
      if (!line || line.startsWith('--')) continue;
      if (/^(KEY|UNIQUE|PRIMARY|CONSTRAINT|FOREIGN|INDEX|FULLTEXT|CHECK)\b/i.test(line)) continue;
      /* And skip continuation lines. Several column definitions in tenant.sql
         wrap — a trailing `COMMENT '...'`, a `NOT NULL DEFAULT ...`, the tail of
         a generated column. Without this, `COMMENT` reads as a column name and
         the audit tries to add a column called COMMENT to every database. */
      if (/^(COMMENT|DEFAULT|AFTER|NOT\s+NULL|NULL|STORED|VIRTUAL|GENERATED|AS)\b/i.test(line)) continue;
      if (/^\)/.test(line)) continue;

      const m = /^`?(\w+)`?\s+(.+)$/.exec(line);
      if (!m) continue;
      /* A column line whose "definition" is itself a key word is a constraint
         we failed to spot; leave it. */
      if (/^(PRIMARY|KEY|UNIQUE)\b/i.test(m[2])) continue;

      /* Last gate, and the important one: this script writes DDL, so a line it
         has misread must not become an ALTER. The definition has to START with
         a real column type. Prose cannot pass this — which is what a stray
         comment line looks like. */
      if (!TYPE_START.test(m[2])) continue;

      out.push({ table, column: m[1], definition: m[2], after: previous });
      previous = m[1];
    }
  }
  return out;
}

async function main(): Promise<void> {
  const go = process.argv.includes('--go');
  const declared = await declaredColumns();

  const byTable = new Map<string, Declared[]>();
  for (const d of declared) {
    const list = byTable.get(d.table) ?? [];
    list.push(d);
    byTable.set(d.table, list);
  }
  console.log(`tenant.sql declares ${declared.length} columns across ${byTable.size} tables`);
  console.log(go ? 'mode: REPAIR (--go)\n'
                 : 'mode: report only — to apply, run:  npm run schema-audit -- --go\n');

  const dbs = await mq<Array<RowDataPacket & {
    company_id: number; db_name: string; name: string; schema_version: number;
  }>>(`SELECT cd.company_id, cd.db_name, cd.schema_version, c.name
       FROM company_databases cd JOIN companies c ON c.id = cd.company_id
       WHERE c.status <> 'closed'
       ORDER BY cd.company_id`);

  let totalMissing = 0;
  let totalAdded = 0;

  for (const db of dbs) {
    const conn = await adminConnection();
    try {
      const have = await conn.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`, [db.db_name]
      ).then(([rows]) => rows);

      const present = new Set(have.map(r => `${String(r.t).toLowerCase()}.${String(r.c).toLowerCase()}`));
      const tablesPresent = new Set(have.map(r => String(r.t).toLowerCase()));

      /* Missing TABLES, not just columns. The column check skips any table the
         database does not have, so a whole table absent from a shop was
         invisible to this script — which is exactly the shape of the bug it
         exists to catch. Reported, not created: a missing table usually means
         a migration did not run, and `npm run migrate` is the right fix. */
      const wantedTables = [...byTable.keys()];
      const missingTables = wantedTables.filter(t => !tablesPresent.has(t.toLowerCase()));
      if (missingTables.length) {
        console.log(`  TABLES MISSING  ${db.db_name}  (${db.name}): ${missingTables.join(', ')}`);
        console.log('          run: npm run migrate');
      }

      const missing = declared.filter(d =>
        tablesPresent.has(d.table.toLowerCase()) &&
        !present.has(`${d.table.toLowerCase()}.${d.column.toLowerCase()}`));

      if (!missing.length && !missingTables.length) {
        console.log(`  ok    ${db.db_name}  (${db.name}, v${db.schema_version})`);
        continue;
      }

      totalMissing += missing.length;
      console.log(`  DRIFT ${db.db_name}  (${db.name}, v${db.schema_version}) — ` +
        `${missing.length} column(s) missing`);

      for (const d of missing) {
        console.log(`          ${d.table}.${d.column}  ${d.definition}`);
        if (!go) continue;
        await conn.query(`USE \`${db.db_name}\``);
        const after = d.after ? ` AFTER \`${d.after}\`` : '';
        try {
          await conn.query(
            `ALTER TABLE \`${d.table}\` ADD COLUMN \`${d.column}\` ${d.definition}${after}`);
          console.log(`          added`);
          totalAdded++;
        } catch (e) {
          /* An AFTER naming a column this database also lacks: add it at the
             end instead. Position is cosmetic; presence is not. */
          try {
            await conn.query(
              `ALTER TABLE \`${d.table}\` ADD COLUMN \`${d.column}\` ${d.definition}`);
            console.log(`          added (at end — ${d.after} not present here)`);
            totalAdded++;
          } catch (e2) {
            console.log(`          FAILED: ${(e2 as Error).message}`);
          }
        }
      }
    } finally {
      await conn.end().catch(() => {});
    }
  }

  console.log(`\n${dbs.length} database(s). ${totalMissing} missing column(s) found.`);
  if (go) console.log(`${totalAdded} added.`);
  else if (totalMissing) console.log('To add them:  npm run schema-audit -- --go');

  await closeMaster();
}

main().catch(e => { console.error(e); process.exit(1); });
