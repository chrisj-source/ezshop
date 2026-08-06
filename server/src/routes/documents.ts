import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, texec, tqOne } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import {
  DOC_TYPES, extensionOf, isMoneyDoc, readStream, removeFile, storageKey, writeStream
} from '../lib/storage';

/**
 * Documents.
 *
 * Images arrive already resized by the browser (web/photos.js): a 2048px
 * version to keep and a 400px thumbnail. The server stores both and serves the
 * thumbnail to grids, so opening a file with two hundred photos costs about
 * 8 MB rather than 800.
 */
export async function registerDocuments(app: FastifyInstance): Promise<void> {

  app.get('/api/doc-types', async () => ({ types: DOC_TYPES }));

  app.post('/api/ro/:id/documents', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'docs', reply)) return;

    const roId = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const ro = await tqOne<RowDataPacket>(cid, 'SELECT id FROM repair_orders WHERE id = ?', [roId]);
    if (!ro) return reply.code(404).send({ error: 'No such repair order' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'Expected a file upload' });

    let docType = 'other';
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
        if (part.fieldname === 'docType') docType = v;
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

    const saved: Array<{ id: number; label: string }> = [];

    for (const [, slot] of slots) {
      if (!slot.main) {
        if (slot.thumb) await removeFile(slot.thumb.key);
        continue;
      }

      const isImage = /^image\//.test(slot.main.mime);
      const [w, h] = (slot.dim ?? '').split('x').map(Number);
      const label = labelOverride ?? slot.main.name;

      const res = await texec(cid, `
        INSERT INTO documents
          (ro_id, doc_type, label, storage_key, thumb_key, mime_type, width, height,
           is_image, size_bytes, is_money_doc, uploaded_by, uploaded_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [roId, docType, label.slice(0, 190), slot.main.key, slot.thumb?.key ?? null,
         slot.main.mime, w || null, h || null, isImage ? 1 : 0,
         slot.main.bytes, isMoneyDoc(docType) ? 1 : 0, ctx.user.id, ctx.user.name]
      );

      saved.push({ id: res.insertId, label });
    }

    if (!saved.length) return reply.code(400).send({ error: 'No file received' });

    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [roId, saved.length === 1
        ? `Document added: ${saved[0].label}.`
        : `${saved.length} documents added.`,
       ctx.user.id, ctx.user.name]
    );

    return { ok: true, documents: saved };
  });

  /**
   * Serve a document. `variant=thumb` gives the small version for grids;
   * `download=1` forces a save rather than a preview. Storage keys are random
   * and never reused, so the response can be cached forever.
   */
  app.get('/api/documents/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { variant?: string; download?: string };

    const doc = await tqOne<RowDataPacket & {
      storage_key: string; thumb_key: string | null; mime_type: string | null;
      label: string; is_money_doc: number; is_image: number;
    }>(ctx.company!.id,
      `SELECT storage_key, thumb_key, mime_type, label, is_money_doc, is_image
       FROM documents WHERE id = ? AND deleted_at IS NULL`, [id]
    );
    if (!doc) return reply.code(404).send({ error: 'No such document' });
    if (doc.is_money_doc === 1 && !ctx.caps.money) {
      return reply.code(403).send({ error: 'Not permitted' });
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

  /** Just the images on a file, for the drawer's grid. */
  app.get('/api/ro/:id/photos', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const roId = Number((req.params as { id: string }).id);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, doc_type, label, width, height, size_bytes,
             thumb_key IS NOT NULL AS has_thumb, uploaded_name, created_at
      FROM documents
      WHERE ro_id = ? AND deleted_at IS NULL AND is_image = 1
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
             COALESCE(SUM(size_bytes), 0) AS bytes
      FROM documents WHERE deleted_at IS NULL`);

    const byType = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT doc_type, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes
      FROM documents WHERE deleted_at IS NULL
      GROUP BY doc_type ORDER BY bytes DESC`);

    return {
      files: Number(row.files ?? 0),
      images: Number(row.images ?? 0),
      bytes: Number(row.bytes ?? 0),
      byType
    };
  });
}

function safeName(label: string, mime: string | null): string {
  const clean = label.replace(/[^\w .-]/g, '_').slice(0, 120) || 'document';
  if (/\.[a-z0-9]{2,5}$/i.test(clean)) return clean;
  const ext = mime === 'application/pdf' ? '.pdf' : /^image\//.test(mime ?? '') ? '.jpg' : '';
  return clean + ext;
}
