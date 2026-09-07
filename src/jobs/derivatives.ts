import { RowDataPacket } from 'mysql2/promise';
import { tqOne, texec } from '../db/tenant';
import {
  heicToJpeg, imageSize, mediaTools, pdfPageCount, renderPdfPage, resizeToKey, EDGES
} from '../lib/media';
import { removeFile, storageKey, writeBuffer } from '../lib/storage';
import { DerivativeJob } from '../queue';

/**
 * Make the derivatives for one document.
 *
 * Photos: a 400px thumbnail, and a 2048px version to keep if what arrived was
 * larger. A HEIC is converted to JPEG and the HEIC is deleted — anyone can open
 * a JPEG in ten years.
 *
 * PDFs: page one rendered to a JPEG thumbnail, and the page count recorded so
 * the viewer knows how many arrows to offer. The other pages are rendered when
 * someone actually turns to them.
 *
 * Failure is not an exception: three tries is BullMQ's business, and when they
 * run out the row goes to `failed` and the grid shows a type glyph.
 */
export async function makeDerivatives(job: DerivativeJob): Promise<void> {
  const { companyId: cid, documentId: id } = job;

  const doc = await tqOne<RowDataPacket & {
    storage_key: string; thumb_key: string | null; mime_type: string | null;
    source_mime: string | null; is_image: number; is_pdf: number; label: string;
  }>(cid, `SELECT storage_key, thumb_key, mime_type, source_mime, is_image, is_pdf, label
           FROM documents WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (!doc) return;                       // deleted while queued — nothing to do

  const tools = await mediaTools();
  await texec(cid, 'UPDATE documents SET thumb_tries = thumb_tries + 1 WHERE id = ?', [id]);

  try {
    if (doc.is_pdf) {
      if (!tools.mutool || !tools.sharp) throw new Error('mutool or sharp missing');
      await pdfDerivatives(cid, id, doc.storage_key);
    } else if (doc.is_image) {
      if (!tools.sharp) throw new Error('sharp missing');
      await imageDerivatives(cid, id, doc);
    } else {
      await texec(cid, `UPDATE documents SET thumb_state = 'none' WHERE id = ?`, [id]);
      return;
    }
    await texec(cid, `UPDATE documents SET thumb_state = 'ready' WHERE id = ?`, [id]);
  } catch (err) {
    /* Out of tries: settle on failed so the tile stops waiting and shows a glyph. */
    const row = await tqOne<RowDataPacket & { thumb_tries: number }>(
      cid, 'SELECT thumb_tries FROM documents WHERE id = ?', [id]);
    if (Number(row?.thumb_tries ?? 3) >= 3) {
      await texec(cid, `UPDATE documents SET thumb_state = 'failed' WHERE id = ?`, [id]);
      return;                             // swallow: retrying past three is noise
    }
    throw err;                            // let BullMQ back off and come again
  }
}

async function imageDerivatives(
  cid: number, id: number,
  doc: { storage_key: string; mime_type: string | null; source_mime: string | null }
): Promise<void> {
  let mainKey = doc.storage_key;
  const wasHeic = /hei[cf]/i.test(doc.mime_type ?? '') || /\.hei[cf]$/i.test(mainKey);

  if (wasHeic) {
    const jpeg = await heicToJpeg(mainKey);
    const jpegKey = storageKey(cid, 'jpg');
    const bytes = await writeBuffer(jpegKey, jpeg);
    /* The JPEG becomes the document; the HEIC goes. `source_mime` remembers what
       the phone actually sent. */
    await texec(cid, `
      UPDATE documents
      SET storage_key = ?, mime_type = 'image/jpeg', source_mime = COALESCE(source_mime, ?),
          size_bytes = ?
      WHERE id = ?`, [jpegKey, doc.mime_type ?? 'image/heic', bytes, id]);
    await removeFile(mainKey);
    mainKey = jpegKey;
  }

  /* Anything bigger than the keep size is replaced by the keep size — a 12 MP
     phone photo is 350 KB after this, and the grid opens on shop wifi. */
  const size = await imageSize(mainKey);
  if (size && Math.max(size.width, size.height) > EDGES.full) {
    const smallerKey = storageKey(cid, 'jpg');
    const full = await resizeToKey(mainKey, smallerKey, EDGES.full, 82);
    await texec(cid,
      'UPDATE documents SET storage_key = ?, size_bytes = ?, width = ?, height = ? WHERE id = ?',
      [full.key, full.bytes, full.width, full.height, id]);
    await removeFile(mainKey);
    mainKey = full.key;
  } else if (size) {
    await texec(cid, 'UPDATE documents SET width = ?, height = ? WHERE id = ?',
      [size.width, size.height, id]);
  }

  const thumbKey = storageKey(cid, 'jpg');
  const thumb = await resizeToKey(mainKey, thumbKey, EDGES.thumb, 72);
  const old = await tqOne<RowDataPacket & { thumb_key: string | null }>(
    cid, 'SELECT thumb_key FROM documents WHERE id = ?', [id]);
  await texec(cid, 'UPDATE documents SET thumb_key = ? WHERE id = ?', [thumb.key, id]);
  if (old?.thumb_key && old.thumb_key !== thumb.key) await removeFile(old.thumb_key);
}

async function pdfDerivatives(cid: number, id: number, key: string): Promise<void> {
  const pages = await pdfPageCount(key);

  /* Page one at thumbnail size. Portrait paperwork in a square tile is cropped
     by the grid, not by us — the whole page is in the file. */
  const thumbKey = storageKey(cid, 'jpg');
  await renderPdfPage(key, 1, thumbKey, EDGES.thumb * 2);
  const thumb = await resizeToKey(thumbKey, thumbKey, EDGES.thumb, 74);

  await texec(cid,
    'UPDATE documents SET thumb_key = ?, page_count = ?, width = ?, height = ? WHERE id = ?',
    [thumb.key, pages, thumb.width, thumb.height, id]);
}
