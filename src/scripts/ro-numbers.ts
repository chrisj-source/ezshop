/**
 * RO numbers — put every open file back onto the last six of its VIN.
 *
 *   npm run ro-numbers                     what it would change, touching nothing
 *   npm run ro-numbers -- --go             change them
 *   npm run ro-numbers -- --go --shop 4    one shop first
 *   npm run ro-numbers -- --shop extreme   report one shop, by name
 *
 * Note the bare `--`: without it npm keeps the flag for itself and the script
 * runs in report mode regardless. Dry run is the default and the only way past
 * it is to type `--go`.
 *
 * What the number is supposed to be
 * ---------------------------------
 * The last six characters of the VIN. That is what the EMS import falls back to
 * when an estimate carries no RO number of its own (`routes/ems.ts`), and what
 * matching reads back off a file, so it is the shop's real convention rather
 * than a preference — a file numbered anything else cannot be found by an
 * estimate arriving for it.
 *
 * What this touches, and what it refuses to
 * -----------------------------------------
 * **Open files only**, on the canonical predicate:
 * `close_date IS NULL AND closed_at IS NULL AND voided_at IS NULL`.
 *
 *  - A **closed** file is the shop's business record. Its number is on printed
 *    paperwork, on an invoice, and in a payroll snapshot. It is not renamed.
 *  - A **voided** file parks on `VOID-<id>` so its real number goes straight
 *    back in the pool. Renaming one would quietly put a released number back in
 *    use, which is the bug, not the fix. Skipped by the predicate.
 *  - A file with **no VIN**, or fewer than six characters of one, is reported
 *    and left alone. There is nothing to derive from, and a made-up number is
 *    worse than a wrong one.
 *  - A **collision** — the target number already answers to another file — is
 *    reported with the other file named, and neither is touched. Two open files
 *    on the same VIN tail is a real thing (a comeback, a duplicate) and it
 *    needs a person, not a script. `uq_ro_number` would refuse it anyway; this
 *    refuses it first, by name, so the run does not stop on an exception.
 *
 * Every change writes both: an audit row with before and after, and an auto
 * note on the file, because the number on a file is the thing everybody quotes
 * at each other and a silent change to it is indefensible.
 *
 * Idempotent. Run it again and it reports everything ok.
 */

import { RowDataPacket } from 'mysql2/promise';
import { closeMaster, mq } from '../db/master';
import { tq, withTenantTx } from '../db/tenant';
import { auditIn, Actor } from '../lib/audit';

/** Nobody typed this, and the log says so rather than blaming a user. */
const SYSTEM: Actor = {
  user: { id: null as unknown as number, name: 'System — RO number repair' },
  source: 'system'
};

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}

interface FileRow extends RowDataPacket {
  id: number;
  ro_number: string;
  vin: string | null;
  customer: string | null;
  vehicle: string | null;
}

/**
 * The last six, from the VIN as it would be read off the car: upper case, and
 * with the spaces and dashes a desk sometimes types stripped out. A VIN with
 * punctuation in it is still the same VIN.
 */
function tailOf(vin: string | null): string | null {
  const v = String(vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return v.length >= 6 ? v.slice(-6) : null;
}

async function main(): Promise<void> {
  const go = process.argv.includes('--go');
  const shop = arg('--shop');

  console.log('RO numbers — the last six of the VIN, open files only');
  console.log(go ? 'mode: REPAIR (--go)\n'
                 : 'mode: report only — to apply, run:  npm run ro-numbers -- --go\n');

  const shops = await mq<Array<RowDataPacket & { id: number; name: string }>>(
    `SELECT c.id, c.name
       FROM companies c JOIN company_databases cd ON cd.company_id = c.id
      WHERE c.status <> 'closed'
      ORDER BY c.id`);

  const picked = shop
    ? shops.filter(s => String(s.id) === shop.trim() ||
        s.name.toLowerCase().includes(shop.trim().toLowerCase()))
    : shops;

  if (shop && !picked.length) {
    console.log(`No shop matches "${shop}". Shops: ` +
      shops.map(s => `${s.id} ${s.name}`).join(', '));
    await closeMaster();
    process.exit(1);
  }

  let totalWrong = 0, totalFixed = 0, totalNoVin = 0, totalClash = 0, totalOk = 0;

  for (const s of picked) {
    const files = await tq<FileRow[]>(s.id, `
      SELECT r.id, r.ro_number, v.vin, c.name AS customer,
             TRIM(CONCAT_WS(' ', v.year, v.make, v.model)) AS vehicle
        FROM repair_orders r
        LEFT JOIN vehicles v ON v.id = r.vehicle_id
        LEFT JOIN clients c ON c.id = r.client_id
       WHERE r.close_date IS NULL AND r.closed_at IS NULL AND r.voided_at IS NULL
       ORDER BY r.id`).catch(e => {
      console.log(`  SKIPPED ${s.name} (${s.id}) — ${(e as Error).message}`);
      return [] as FileRow[];
    });

    if (!files.length) { console.log(`  ${s.name} (${s.id}): no open files`); continue; }

    /* Every number in the shop, open or not, so a target that belongs to a
       closed or voided file is caught as a collision too. Read once rather than
       a query per file. */
    const taken = new Map<string, { id: number; state: string }>();
    const all = await tq<Array<RowDataPacket & {
      id: number; ro_number: string; close_date: string | null;
      closed_at: Date | null; voided_at: Date | null;
    }>>(s.id, 'SELECT id, ro_number, close_date, closed_at, voided_at FROM repair_orders');
    for (const r of all) {
      taken.set(String(r.ro_number), {
        id: r.id,
        state: r.voided_at ? 'voided' : (r.close_date || r.closed_at) ? 'closed' : 'open'
      });
    }

    const wrong: Array<{ f: FileRow; want: string }> = [];
    const noVin: FileRow[] = [];
    const clash: Array<{ f: FileRow; want: string; other: { id: number; state: string } }> = [];
    let ok = 0;

    for (const f of files) {
      const want = tailOf(f.vin);
      if (!want) { noVin.push(f); continue; }
      if (String(f.ro_number) === want) { ok++; continue; }

      const other = taken.get(want);
      if (other && other.id !== f.id) { clash.push({ f, want, other }); continue; }
      wrong.push({ f, want });
    }

    totalOk += ok; totalWrong += wrong.length;
    totalNoVin += noVin.length; totalClash += clash.length;

    const head = `  ${s.name} (${s.id}): ${files.length} open · ${ok} already right` +
      (wrong.length ? ` · ${wrong.length} to change` : '') +
      (clash.length ? ` · ${clash.length} collision(s)` : '') +
      (noVin.length ? ` · ${noVin.length} with no VIN` : '');
    console.log(head);

    for (const { f, want } of wrong) {
      const who = [f.vehicle, f.customer].filter(Boolean).join(' · ') || 'no vehicle on file';
      /* Say what shape the old number was, so a run over a shop that was on a
         sequence looks different from one that was on the last eight. */
      const vinClean = String(f.vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const shapeNote = vinClean.endsWith(String(f.ro_number)) ? ' (was a longer VIN tail)'
        : /^\d+$/.test(String(f.ro_number)) ? ' (was a plain sequence)'
        : '';
      console.log(`          ${f.ro_number} → ${want}   ${who}${shapeNote}`);

      if (!go) continue;

      try {
        await withTenantTx(s.id, async (c) => {
          /* Re-read under the lock: a desk editing the number while this runs
             must not be overwritten by what was true a moment ago. */
          const [rows] = await c.query<RowDataPacket[]>(
            `SELECT ro_number, close_date, closed_at, voided_at
               FROM repair_orders WHERE id = ? FOR UPDATE`, [f.id]);
          const now = rows[0];
          if (!now) throw new Error('file disappeared');
          if (now.voided_at || now.close_date || now.closed_at) throw new Error('no longer open');
          if (String(now.ro_number) !== String(f.ro_number)) {
            throw new Error(`changed underneath us — now ${now.ro_number}`);
          }

          await c.query('UPDATE repair_orders SET ro_number = ? WHERE id = ?', [want, f.id]);

          await auditIn(c, SYSTEM, {
            entity: 'repair_order', entityId: f.id, roId: f.id,
            action: 'ro_number_repair', area: 'Repair order',
            label: `RO number corrected — ${f.ro_number} → ${want}`,
            changes: [{ field: 'ro_number', from: String(f.ro_number), to: want }],
            note: null,
            detail: { vin: f.vin, script: 'ro-numbers' }
          });

          await c.query(
            `INSERT INTO ro_notes (ro_id, kind, body, user_name)
             VALUES (?, 'auto', ?, 'System')`,
            [f.id,
             `RO number corrected from ${f.ro_number} to ${want} — the last six of the VIN.`]);
        });
        totalFixed++;
      } catch (e) {
        console.log(`          FAILED ${f.ro_number} → ${want}: ${(e as Error).message}`);
      }
    }

    for (const { f, want, other } of clash) {
      console.log(`          COLLISION ${f.ro_number} wants ${want}, ` +
        `which belongs to file ${other.id} (${other.state}). Neither touched.`);
    }

    for (const f of noVin) {
      const who = [f.vehicle, f.customer].filter(Boolean).join(' · ') || 'nothing on file';
      console.log(`          NO VIN ${f.ro_number} — ${who}. Nothing to derive from.`);
    }
  }

  console.log(`\n${picked.length} shop(s). ${totalOk} already right, ` +
    `${totalWrong} to change, ${totalClash} collision(s), ${totalNoVin} with no VIN.`);
  if (go) console.log(`${totalFixed} changed.`);
  else if (totalWrong) console.log('To change them:  npm run ro-numbers -- --go');

  if (totalClash || totalNoVin) {
    console.log('Collisions and missing VINs need a person — nothing above was guessed at.');
  }

  await closeMaster();
}

main().catch(e => { console.error(e); process.exit(1); });
