import { RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { mq } from '../db/master';
import { tq, texec } from '../db/tenant';
import { removeFile } from '../lib/storage';

/** Every shop with a database, for work that sweeps across all of them. */
async function tenantIds(): Promise<number[]> {
  const rows = await mq<Array<RowDataPacket & { company_id: number }>>(
    `SELECT cd.company_id FROM company_databases cd
     JOIN companies c ON c.id = cd.company_id
     WHERE c.status <> 'closed' ORDER BY cd.company_id`
  );
  return rows.map(r => Number(r.company_id));
}

/**
 * Rendered PDF pages are a cache, not a record: the PDF is the record. A page
 * nobody has opened in thirty days goes, and comes back in a second the next
 * time someone does.
 *
 * Page one is never dropped — it is the document's thumbnail.
 */
export async function prunePageCache(): Promise<number> {
  const days = config.media.pageCacheDays;
  let dropped = 0;

  for (const cid of await tenantIds()) {
    const stale = await tq<Array<RowDataPacket & { document_id: number; page_no: number; storage_key: string }>>(
      cid, `SELECT document_id, page_no, storage_key FROM document_pages
            WHERE page_no > 1 AND last_seen_at < DATE_SUB(NOW(), INTERVAL ? DAY)
            LIMIT 2000`, [days]
    ).catch(() => []);

    for (const p of stale) {
      await removeFile(p.storage_key);
      await texec(cid, 'DELETE FROM document_pages WHERE document_id = ? AND page_no = ?',
        [p.document_id, p.page_no]);
      dropped++;
    }
  }

  return dropped;
}
