import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, texec, tqOne } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import {
  DOC_TYPES, extensionOf, isMoneyDoc, readStream, removeFile, storageKey, writeStream
} from '../lib/storage';
import { mediaTools, pdfPageCount, renderPdfPage, EDGES } from '../lib/media';
import { enqueueDerivative, queueHealthy } from '../queue';
import { makeDerivatives } from '../jobs/derivatives';

/**
 * Documents.
 *
 * Every photo and every PDF gets a thumbnail, made on the server: HEIC decoded
 * to JPEG, page one of a PDF rendered. The work happens on a queue behind the
 * upload, so the upload returns as soon as the bytes are down, and a tile only
 * joins the grid once its thumbnail is ready.
 *
 * The browser still resizes what it can before uploading (web/photos.js) — that
 * is bandwidth, not thumbnails, and it means a phone on shop wifi sends 350 KB
 * instead of 4 MB. Anything it cannot decode goes up whole and the server deals
 * with it.
 */
export async function registerDocuments(app: FastifyInstance): Promise<void> {

  app.get('/api/doc-types', async () => ({ types: DOC_TYPES }));

  /** What this box can make thumbnails of — Admin shows the owner what is missing. */
  app.get('/api/media-tools', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const tools = await mediaTools(true);
    return {
      ...tools,
      queue: queueHealthy(),
      /* A shop can run without any of it; this is what they lose. */
      missing: [
        tools.sharp ? null : 'sharp — no thumbnails at all',
        tools.heifConvert || tools.sharp ? null : 'heif-convert — iPhone HEIC photos',
        tools.mutool ? null : 'mutool — PDF thumbnails and page viewing'
      ].filter(Boolean)
    };
  });

  app.post('/api/ro/:id/documents', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'docs', reply)) return;

    const roId = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const ro = await tqOne<RowDataPacket>(cid, 'SELECT id FROM repair_orders WHERE id = ?', [roId]);
    if (!ro) return reply.code(404).send({ error: 'No such repair order' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'Expected a file upload' });

    /* A technician shoots damage photos; paperwork is the office's. */
    const photosOnly = !ctx.caps.viewPaperwork;

    let docType: string | null = null;
    let labelOverride: string | null = null;

    // fieldname suffix -> the pieces of one upload
    const slots = new Map<string, {
      main?: { key: string; bytes: number; mime: string; name: string };
      thumb?: { key: string; bytes: number };
      dim?: string;
    }>();

    for await (const part of req.parts()) {
      if (part.type === 'field') {
        const v = String(part.value);
        if (part.fieldname === 'docType') docType = v || null;
        else if (part.fieldname === 'label') labelOverride = v || null;
        else if (part.fieldname.startsWith('dim')) {
          const i = part.fieldname.slice(3);
          slots.set(i, Object.assign(slots.get(i) ?? {}, { dim: v }));
        }
        continue;
      }

      const isThumb = part.fieldname.startsWith('thumb');
      const index = part.fieldname.replace(/^(file|thumb)/, '');
      const ext = extensionOf(part.filename ?? '', part.mimetype);
      const key = storageKey(cid, ext);
      const bytes = await writeStream(key, part.file);

      if ((part.file as unknown as { truncated?: boolean }).truncated) {
        await removeFile(key);
        return reply.code(413).send({ error: 'That file is too large. 25 MB maximum.' });
      }

      const slot = slots.get(index) ?? {};
      if (isThumb) slot.thumb = { key, bytes };
      else slot.main = { key, bytes, mime: part.mimetype ?? 'application/octet-stream', name: part.filename ?? 'file' };
      slots.set(index, slot);
    }

    const saved: Array<{ id: number; label: string; pending: boolean }> = [];
    const rejected: string[] = [];

    for (const [, slot] of slots) {
      if (!slot.main) {
        if (slot.thumb) await removeFile(slot.thumb.key);
        continue;
      }

      const mime = slot.main.mime;
      const name = slot.main.name;
      const isImage = /^image\//.test(mime) || /\.(jpe?g|png|bmp|gif|webp|hei[cf])$/i.test(name);
      const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(name);

      if (photosOnly && !isImage) {
        rejected.push(name);
        await removeFile(slot.main.key);
        if (slot.thumb) await removeFile(slot.thumb.key);
        continue;
      }

      /* The type is read from the file rather than asked for: an image is a
         photo, a PDF is paperwork. Whoever cares can retype it after. */
      const type = docType ?? (isPdf ? 'other' : isImage ? 'photos_progress' : 'other');

      const [w, h] = (slot.dim ?? '').split('x').map(Number);
      const label = labelOverride ?? name;

      /* The browser's thumbnail is good enough when it made one — no need to
         queue work we already have. */
      const haveThumb = !!slot.thumb;
      const thumbState = haveThumb ? 'ready' : (isImage || isPdf) ? 'pending' : 'none';

      const res = await texec(cid, `
        INSERT INTO documents
          (ro_id, doc_type, label, storage_key, thumb_key, thumb_state, mime_type, width, height,
           is_image, is_pdf, size_bytes, is_money_doc, uploaded_by, uploaded_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [roId, type, label.slice(0, 190), slot.main.key, slot.thumb?.key ?? null, thumbState,
         mime, w || null, h || null, isImage ? 1 : 0, isPdf ? 1 : 0,
         slot.main.bytes, isMoneyDoc(type) ? 1 : 0, ctx.user.id, ctx.user.name]
      );

      if (thumbState === 'pending') {
        const queued = await enqueueDerivative({ companyId: cid, documentId: res.insertId });
        /* No Redis: do it here. Slower for whoever is uploading, but they get a
           thumbnail rather than a glyph. */
        if (!queued) {
          await makeDerivatives({ companyId: cid, documentId: res.insertId })
            .catch(e => req.log.error({ err: e }, 'inline derivative'));
        }
      }

      saved.push({ id: res.insertId, label, pending: thumbState === 'pending' });
    }

    if (!saved.length) {
      return reply.code(rejected.length ? 403 : 400).send({
        error: rejected.length
          ? 'Photos only — paperwork is uploaded by the office.'
          : 'No file received'
      });
    }

    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [roId, saved.length === 1
        ? `Document added: ${saved[0].label}.`
        : `${saved.length} documents added.`,
       ctx.user.id, ctx.user.name]
    );

    return {
      ok: true,
      documents: saved,
      pending: saved.filter(s => s.pending).length,
      rejected
    };
  });

  /**
   * Serve a document. `variant=thumb` gives the small version for grids;
   * `page=N` gives a rendered page of a PDF; `download=1` forces a save rather
   * than a preview. Storage keys are random and never reused, so the response
   * can be cached forever.
   */
  app.get('/api/documents/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { variant?: string; download?: string; page?: string };

    const doc = await tqOne<RowDataPacket & {
      storage_key: string; thumb_key: string | null; mime_type: string | null;
      label: string; is_money_doc: number; is_image: number; is_pdf: number;
      page_count: number | null;
    }>(ctx.company!.id,
      `SELECT storage_key, thumb_key, mime_type, label, is_money_doc, is_image, is_pdf, page_count
       FROM documents WHERE id = ? AND deleted_at IS NULL`, [id]
    );
    if (!doc) return reply.code(404).send({ error: 'No such document' });
    if (doc.is_money_doc === 1 && !ctx.caps.money) {
      return reply.code(403).send({ error: 'Not permitted' });
    }
    /* Paperwork is the office's, the owner's and the production manager's. */
    if (doc.is_pdf === 1 && !ctx.caps.viewPaperwork) {
      return reply.code(403).send({ error: 'Not permitted' });
    }

    /* A page of a PDF, rendered on first ask and kept for a month after it was
       last opened. */
    const pageNo = Number(q.page ?? 0);
    if (pageNo > 0 && doc.is_pdf) {
      const key = await pageKey(ctx.company!.id, id, doc.storage_key, pageNo, doc.page_count);
      if (!key) return reply.code(503).send({ error: 'Cannot render PDF pages on this server.' });
      reply.header('content-type', 'image/jpeg');
      reply.header('cache-control', 'private, max-age=86400');
      return reply.send(readStream(key));
    }

    const wantThumb = q.variant === 'thumb' && doc.thumb_key;
    const key = wantThumb ? doc.thumb_key! : doc.storage_key;
    const download = q.download === '1';

    // A thumbnail is never a download; the full file is unless asked to preview.
    const disposition = download ? 'attachment' : 'inline';
    const filename = safeName(doc.label, doc.mime_type);

    reply.header('content-type', wantThumb ? 'image/jpeg' : (doc.mime_type ?? 'application/octet-stream'));
    reply.header('content-disposition', `${disposition}; filename="${filename}"`);
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(readStream(key));
  });

  /**
   * Rotation is display-only. The file on disk stays exactly as the camera wrote
   * it — an intake photo is evidence — and the viewer turns it on the way out.
   */
  app.patch('/api/documents/:id/rotate', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const { turn } = req.body as { turn?: number };
    const step = turn === -90 ? -90 : 90;

    const doc = await tqOne<RowDataPacket & { rotation: number; is_image: number }>(
      ctx.company!.id, 'SELECT rotation, is_image FROM documents WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!doc) return reply.code(404).send({ error: 'No such document' });
    if (!doc.is_image) return reply.code(400).send({ error: 'Only photos rotate.' });

    const next = (((Number(doc.rotation) + step) % 360) + 360) % 360;
    await texec(ctx.company!.id, 'UPDATE documents SET rotation = ? WHERE id = ?', [next, id]);
    return { ok: true, rotation: next };
  });

  /** Ask again for a thumbnail that failed. */
  app.post('/api/documents/:id/rethumb', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;
    await texec(cid, `UPDATE documents SET thumb_state = 'pending', thumb_tries = 0 WHERE id = ?`, [id]);
    const queued = await enqueueDerivative({ companyId: cid, documentId: id });
    if (!queued) await makeDerivatives({ companyId: cid, documentId: id }).catch(() => undefined);
    return { ok: true };
  });

  /**
   * The viewer's sequence: photos first, then paperwork, each in upload order.
   * Money documents are absent for anyone who cannot see money, and paperwork is
   * absent for anyone outside the office — not locked, absent, so the arrows
   * never land on a door they cannot open.
   *
   * A document whose thumbnail is still being made is left out; it appears on
   * the next load, which is a second or two later.
   */
  app.get('/api/ro/:id/media', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const roId = Number((req.params as { id: string }).id);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, doc_type, label, width, height, rotation, page_count, size_bytes,
             mime_type, source_mime, is_image, is_pdf, thumb_state,
             thumb_key IS NOT NULL AS has_thumb, uploaded_name, created_at
      FROM documents
      WHERE ro_id = ? AND deleted_at IS NULL
        AND thumb_state <> 'pending'
        ${ctx.caps.money ? '' : 'AND is_money_doc = 0'}
        ${ctx.caps.viewPaperwork ? '' : 'AND is_pdf = 0'}
      ORDER BY is_image DESC, created_at, id`, [roId]);

    const pending = await tqOne<RowDataPacket & { n: number }>(ctx.company!.id,
      `SELECT COUNT(*) AS n FROM documents
       WHERE ro_id = ? AND deleted_at IS NULL AND thumb_state = 'pending'`, [roId]);

    return { media: rows, pending: Number(pending?.n ?? 0) };
  });

  /** Just the images on a file, for the drawer's grid. */
  app.get('/api/ro/:id/photos', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const roId = Number((req.params as { id: string }).id);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, doc_type, label, width, height, rotation, size_bytes,
             thumb_key IS NOT NULL AS has_thumb, uploaded_name, created_at
      FROM documents
      WHERE ro_id = ? AND deleted_at IS NULL AND is_image = 1 AND thumb_state <> 'pending'
      ORDER BY created_at, id`, [roId]);

    return { photos: rows };
  });

  app.patch('/api/documents/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const { label, docType } = req.body as { label?: string; docType?: string };

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (label !== undefined) { sets.push('label = ?'); vals.push(label.slice(0, 190)); }
    if (docType !== undefined) {
      sets.push('doc_type = ?', 'is_money_doc = ?');
      vals.push(docType, isMoneyDoc(docType) ? 1 : 0);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });

    vals.push(id);
    await texec(ctx.company!.id, `UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, vals);
    return { ok: true };
  });

  app.delete('/api/documents/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.deleteDocuments) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const doc = await tqOne<RowDataPacket & {
      storage_key: string; thumb_key: string | null; label: string; ro_id: number;
    }>(cid, `SELECT storage_key, thumb_key, label, ro_id FROM documents
             WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!doc) return reply.code(404).send({ error: 'No such document' });

    await texec(cid, 'UPDATE documents SET deleted_at = NOW() WHERE id = ?', [id]);
    await removeFile(doc.storage_key);
    if (doc.thumb_key) await removeFile(doc.thumb_key);

    /* Cached pages are derived from a file that is now gone. */
    const pages = await tq<Array<RowDataPacket & { storage_key: string }>>(
      cid, 'SELECT storage_key FROM document_pages WHERE document_id = ?', [id]);
    for (const p of pages) await removeFile(p.storage_key);
    await texec(cid, 'DELETE FROM document_pages WHERE document_id = ?', [id]);

    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [doc.ro_id, `Document deleted: ${doc.label}.`, ctx.user.id, ctx.user.name]
    );

    return { ok: true };
  });

  /** What the shop is using on disk — the number that creeps up on you. */
  app.get('/api/storage', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });

    const [row] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COUNT(*) AS files,
             SUM(is_image = 1) AS images,
             SUM(is_pdf = 1) AS pdfs,
             SUM(thumb_state = 'failed') AS no_thumb,
             SUM(thumb_state = 'pending') AS pending,
             COALESCE(SUM(size_bytes), 0) AS bytes
      FROM documents WHERE deleted_at IS NULL`);

    const byType = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT doc_type, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes
      FROM documents WHERE deleted_at IS NULL
      GROUP BY doc_type ORDER BY bytes DESC`);

    /* Rendered PDF pages are a cache, counted apart from the records they came
       from — it is disk you can throw away, and it helps to see it that way. */
    const [cache] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COUNT(*) AS pages, COALESCE(SUM(size_bytes), 0) AS bytes FROM document_pages`);

    return {
      files: Number(row.files ?? 0),
      images: Number(row.images ?? 0),
      pdfs: Number(row.pdfs ?? 0),
      noThumb: Number(row.no_thumb ?? 0),
      pending: Number(row.pending ?? 0),
      bytes: Number(row.bytes ?? 0),
      pageCache: { pages: Number(cache?.pages ?? 0), bytes: Number(cache?.bytes ?? 0) },
      byType
    };
  });
}

/**
 * The stored key for one page of a PDF, rendering it if this is the first time
 * anyone has asked. Touching `last_seen_at` is what keeps it alive.
 */
async function pageKey(
  cid: number, docId: number, sourceKey: string, pageNo: number, pageCount: number | null
): Promise<string | null> {
  if (pageCount && pageNo > pageCount) return null;

  const hit = await tqOne<RowDataPacket & { storage_key: string }>(
    cid, 'SELECT storage_key FROM document_pages WHERE document_id = ? AND page_no = ?',
    [docId, pageNo]);
  if (hit) {
    await texec(cid,
      'UPDATE document_pages SET last_seen_at = NOW() WHERE document_id = ? AND page_no = ?',
      [docId, pageNo]);
    return hit.storage_key;
  }

  const tools = await mediaTools();
  if (!tools.mutool || !tools.sharp) return null;

  const dest = storageKey(cid, 'jpg');
  const out = await renderPdfPage(sourceKey, pageNo, dest, EDGES.page).catch(() => null);
  if (!out) return null;

  await texec(cid, `
    INSERT INTO document_pages (document_id, page_no, storage_key, width, height, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE last_seen_at = NOW()`,
    [docId, pageNo, out.key, out.width, out.height, out.bytes]);

  /* First ask for any page also settles the page count, for a PDF uploaded
     before mutool was installed. */
  if (!pageCount) {
    const n = await pdfPageCount(sourceKey);
    if (n) await texec(cid, 'UPDATE documents SET page_count = ? WHERE id = ?', [n, docId]);
  }

  return out.key;
}

function safeName(label: string, mime: string | null): string {
  const clean = label.replace(/[^\w .-]/g, '_').slice(0, 120) || 'document';
  if (/\.[a-z0-9]{2,5}$/i.test(clean)) return clean;
  const ext = mime === 'application/pdf' ? '.pdf' : /^image\//.test(mime ?? '') ? '.jpg' : '';
  return clean + ext;
}
