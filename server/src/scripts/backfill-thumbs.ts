/**
 * Backfill thumbnails for everything already uploaded.
 *
 *   npm run build && npm run backfill-thumbs
 *
 * Walks every shop, queues (or makes) a thumbnail for every photo and PDF that
 * does not have one, and reports what it could not do. Safe to run repeatedly —
 * it only touches rows still waiting.
 */
import { RowDataPacket } from 'mysql2/promise';
import { mq, closeMaster } from '../db/master';
import { closeAllTenants, tq } from '../db/tenant';
import { makeDerivatives } from '../jobs/derivatives';
import { mediaTools } from '../lib/media';
import { closeQueue, enqueueDerivative, queueHealthy } from '../queue';

async function main(): Promise<void> {
  const tools = await mediaTools();
  console.log(`tools — sharp: ${tools.sharp ? 'yes' : 'no'}, ` +
    `heif-convert: ${tools.heifConvert ? 'yes' : 'no'}, mutool: ${tools.mutool ? 'yes' : 'no'}`);
  if (!tools.sharp) {
    console.error('\nsharp is not installed, so nothing can be made. See INSTALL-MEDIA.md.');
    process.exit(1);
  }

  const useQueue = queueHealthy();
  console.log(useQueue
    ? 'Redis is up — queueing the work; watch the app log as it drains.'
    : 'No Redis — doing the work here, which will take a while.\n');

  const shops = await mq<Array<RowDataPacket & { company_id: number; name: string }>>(
    `SELECT cd.company_id, c.name FROM company_databases cd
     JOIN companies c ON c.id = cd.company_id
     WHERE c.status <> 'closed' ORDER BY cd.company_id`
  );

  let queued = 0, done = 0, failed = 0;

  for (const shop of shops) {
    const rows = await tq<Array<RowDataPacket & { id: number; label: string; is_pdf: number }>>(
      shop.company_id,
      `SELECT id, label, is_pdf FROM documents
       WHERE deleted_at IS NULL AND thumb_state IN ('pending','failed')
         AND (is_image = 1 OR is_pdf = 1)
       ORDER BY id`
    ).catch(err => {
      console.error(`  ${shop.name}: ${err.message} — has it been migrated?`);
      return [];
    });

    if (!rows.length) { console.log(`${shop.name}: nothing waiting`); continue; }
    console.log(`${shop.name}: ${rows.length} to do`);

    for (const row of rows) {
      if (row.is_pdf && !tools.mutool) { failed++; continue; }
      if (useQueue) {
        await enqueueDerivative({ companyId: shop.company_id, documentId: row.id });
        queued++;
      } else {
        try {
          await makeDerivatives({ companyId: shop.company_id, documentId: row.id });
          done++;
          if (done % 25 === 0) console.log(`  ${done} done`);
        } catch (err) {
          failed++;
          console.error(`  ${row.label}: ${(err as Error).message}`);
        }
      }
    }
  }

  console.log(`\n${useQueue ? `${queued} queued` : `${done} made`}` +
    (failed ? `, ${failed} could not be done` : ''));
  if (failed && !tools.mutool) console.log('Install mupdf-tools and run it again for the PDFs.');

  await closeQueue();
  await closeAllTenants();
  await closeMaster();
}

main().catch(err => { console.error(err); process.exit(1); });
