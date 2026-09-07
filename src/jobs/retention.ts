import { RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { mq } from '../db/master';
import { tq, texec } from '../db/tenant';
import { removeFile } from '../lib/storage';

/**
 * Retention.
 *
 * The shop's answer, recorded 30 Aug 2026: keep a closed file forever as a
 * record, drop it to archival after a year, and erase its personal data at ten.
 * So two passes, and they do very different things.
 *
 *  **Archive at one year.** Thumbnails and rendered PDF pages are a cache: the
 *  original file is the record and the derivative is made from it in a second.
 *  A file nobody has opened in a year does not need them sitting on disk. Fully
 *  reversible — open the file and they come back.
 *
 *  **Purge at ten years.** Not reversible, and deliberately narrow. Documents
 *  leave the disk, the insurance contact columns are cleared, and a retail
 *  customer with no newer file loses their contact details. What stays is the
 *  accounting shell: RO number, dates, amounts, labour, who worked on it. That
 *  is a business record the shop is entitled to keep, and in several states
 *  required to. Purging it would be destroying their books, not protecting a
 *  customer.
 *
 * Nothing runs unless RETENTION_ENABLED=1. Until then both passes report what
 * they *would* do and write a dry-run row, which is how you find out that the
 * ten-year rule catches nine thousand files before it catches them.
 */

async function tenantIds(): Promise<number[]> {
  const rows = await mq<Array<RowDataPacket & { company_id: number }>>(
    `SELECT cd.company_id FROM company_databases cd
     JOIN companies c ON c.id = cd.company_id
     WHERE c.status <> 'closed' ORDER BY cd.company_id`
  );
  return rows.map(r => Number(r.company_id));
}

export interface RetentionResult {
  filesTouched: number;
  documentsGone: number;
  bytesFreed: number;
  clientsCleared: number;
  dryRun: boolean;
}

const EMPTY = (): RetentionResult =>
  ({ filesTouched: 0, documentsGone: 0, bytesFreed: 0, clientsCleared: 0, dryRun: !config.retention.enabled });

async function record(cid: number, kind: 'archive' | 'purge', r: RetentionResult, note?: string): Promise<void> {
  await texec(cid,
    `INSERT INTO retention_runs
       (kind, dry_run, files_touched, documents_gone, bytes_freed, clients_cleared, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [kind, r.dryRun ? 1 : 0, r.filesTouched, r.documentsGone, r.bytesFreed, r.clientsCleared,
     note ?? null]
  ).catch(() => undefined);
}

/* ------------------------------------------------------------------ archive */

/**
 * Drop the derivatives of files closed longer than the archive window.
 *
 * Page one of a PDF is kept, same as the page cache sweeper: it is the
 * document's thumbnail in the viewer, and dropping it makes every archived file
 * look broken in a list.
 */
export async function archiveOldFiles(): Promise<RetentionResult> {
  const out = EMPTY();
  const months = config.retention.archiveMonths;
  if (months <= 0) return out;

  for (const cid of await tenantIds()) {
    const files = await tq<Array<RowDataPacket & { id: number }>>(cid,
      `SELECT id FROM repair_orders
        WHERE closed_at IS NOT NULL
          AND archived_at IS NULL AND purged_at IS NULL
          AND closed_at < DATE_SUB(NOW(), INTERVAL ? MONTH)
        ORDER BY closed_at LIMIT 500`, [months]
    ).catch(() => []);
    if (!files.length) continue;

    for (const f of files) {
      const thumbs = await tq<Array<RowDataPacket & { id: number; thumb_key: string | null }>>(cid,
        `SELECT id, thumb_key FROM documents
          WHERE ro_id = ? AND deleted_at IS NULL AND thumb_key IS NOT NULL`, [f.id]).catch(() => []);
      const pages = await tq<Array<RowDataPacket & { document_id: number; page_no: number; storage_key: string }>>(
        cid, `SELECT p.document_id, p.page_no, p.storage_key
                FROM document_pages p JOIN documents d ON d.id = p.document_id
               WHERE d.ro_id = ? AND p.page_no > 1`, [f.id]).catch(() => []);

      out.filesTouched++;
      out.documentsGone += thumbs.length + pages.length;
      if (out.dryRun) continue;

      for (const t of thumbs) {
        if (t.thumb_key) await removeFile(t.thumb_key);
        await texec(cid,
          `UPDATE documents SET thumb_key = NULL, thumb_state = 'pending', thumb_tries = 0
            WHERE id = ?`, [t.id]);
      }
      for (const p of pages) {
        await removeFile(p.storage_key);
        await texec(cid, 'DELETE FROM document_pages WHERE document_id = ? AND page_no = ?',
          [p.document_id, p.page_no]);
      }
      await texec(cid, 'UPDATE repair_orders SET archived_at = NOW() WHERE id = ?', [f.id]);
    }

    await record(cid, 'archive', out, `closed before ${months} months ago`);
  }

  return out;
}

/* -------------------------------------------------------------------- purge */

/** Columns on the repair order that are somebody's personal data, not the shop's books. */
const RO_PERSONAL = [
  'claim_number', 'policy_number', 'date_of_loss',
  'adjuster', 'adjuster_phone', 'adjuster_email'
];

/** The same question asked of an imported estimate. */
const EMS_PERSONAL = [
  'customer_name', 'customer_phone', 'customer_phone2', 'customer_email',
  'customer_addr', 'customer_city', 'customer_state', 'customer_zip',
  'claim_number', 'policy_number', 'adjuster', 'adjuster_phone', 'adjuster_email',
  'insurer_phone', 'date_of_loss'
];

export async function purgeExpiredFiles(): Promise<RetentionResult> {
  const out = EMPTY();
  const years = config.retention.purgeYears;
  if (years <= 0) return out;

  for (const cid of await tenantIds()) {
    const files = await tq<Array<RowDataPacket & { id: number; ro_number: string; client_id: number | null }>>(cid,
      `SELECT id, ro_number, client_id FROM repair_orders
        WHERE closed_at IS NOT NULL AND purged_at IS NULL
          AND closed_at < DATE_SUB(NOW(), INTERVAL ? YEAR)
        ORDER BY closed_at LIMIT 200`, [years]
    ).catch(() => []);
    if (!files.length) continue;

    for (const f of files) {
      const docs = await tq<Array<RowDataPacket & {
        id: number; storage_key: string; thumb_key: string | null; size_bytes: number;
      }>>(cid,
        `SELECT id, storage_key, thumb_key, size_bytes FROM documents
          WHERE ro_id = ? AND deleted_at IS NULL`, [f.id]).catch(() => []);

      out.filesTouched++;
      out.documentsGone += docs.length;
      out.bytesFreed += docs.reduce((n, d) => n + Number(d.size_bytes || 0), 0);
      if (out.dryRun) continue;

      for (const d of docs) {
        await removeFile(d.storage_key);
        if (d.thumb_key) await removeFile(d.thumb_key);
        await texec(cid,
          `UPDATE documents SET deleted_at = NOW(), storage_key = '', thumb_key = NULL
            WHERE id = ?`, [d.id]);
      }
      await texec(cid, `DELETE p FROM document_pages p
                         JOIN documents d ON d.id = p.document_id WHERE d.ro_id = ?`, [f.id]);

      await texec(cid,
        `UPDATE repair_orders SET ${RO_PERSONAL.map(c => `${c} = NULL`).join(', ')},
          purged_at = NOW() WHERE id = ?`, [f.id]);
      await texec(cid,
        `UPDATE ems_estimates SET ${EMS_PERSONAL.map(c => `${c} = NULL`).join(', ')}
          WHERE ro_id = ?`, [f.id]).catch(() => undefined);

      /* A retail customer whose newest file is now purged has no reason to be
         on file. Wholesale and insurance clients are businesses with an ongoing
         relationship — they are not touched, whatever their file dates say. */
      if (f.client_id) {
        const cleared = await texec(cid,
          `UPDATE clients SET phone = NULL, phone2 = NULL, email = NULL,
                  address = NULL, city = NULL, state = NULL, zip = NULL
            WHERE id = ? AND kind = 'retail'
              AND NOT EXISTS (
                SELECT 1 FROM repair_orders r
                 WHERE r.client_id = clients.id AND r.purged_at IS NULL)`,
          [f.client_id]).catch(() => ({ affectedRows: 0 }));
        out.clientsCleared += Number(cleared.affectedRows || 0);
      }
    }

    await record(cid, 'purge', out, `closed before ${years} years ago`);
  }

  return out;
}

/** Both passes, in order. Archive first — a purged file needs no archiving. */
export async function runRetention(): Promise<{ archive: RetentionResult; purge: RetentionResult }> {
  return { archive: await archiveOldFiles(), purge: await purgeExpiredFiles() };
}
