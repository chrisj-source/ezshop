import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { tq, texec, tqOne } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import {
  DOC_TYPES, extensionOf, isMoneyDoc, readStream, removeFile, storageKey, writeStream
} from '../lib/storage';

export async function registerDocuments(app: FastifyInstance): Promise<void> {

  app.get('/api/doc-types', async () => ({ types: DOC_TYPES }));

  /** Upload one or more files against a repair order. */
  app.post('/api/ro/:id/documents', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'docs', reply)) return;

    const roId = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const ro = await tqOne<RowDataPacket>(cid, 'SELECT id, ro_number FROM repair_orders WHERE id = ?', [roId]);
    if (!ro) return reply.code(404).send({ error: 'No such repair order' });

    if (!req.isMultipart()) return reply.code(400).send({ error: 'Expected a file upload' });

    const saved: Array<{ id: number; label: string }> = [];
    let docType = 'other';
    let labelOverride: string | null = null;

    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'docType') docType = String(part.value);
        if (part.fieldname === 'label') labelOverride = String(part.value) || null;
        continue;
      }

      const ext = extensionOf(part.filename ?? '', part.mimetype);
      const key = storageKey(cid, ext);
      const bytes = await writeStream(key, part.file);

      if ((part.file as unknown as { truncated?: boolean }).truncated) {
        await removeFile(key);
        return reply.code(413).send({ error: 'That file is too large. 25 MB maximum.' });
      }

      const label = labelOverride ?? (part.filename ?? 'Untitled');
      const res = await texec(cid, `
        INSERT INTO documents
          (ro_id, doc_type, label, storage_key, mime_type, size_bytes, is_money_doc, uploaded_by, uploaded_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [roId, docType, label.slice(0, 190), key, part.mimetype ?? null, bytes,
         isMoneyDoc(docType) ? 1 : 0, ctx.user.id, ctx.user.name]
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

  app.get('/api/documents/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);

    const doc = await tqOne<RowDataPacket & {
      storage_key: string; mime_type: string | null; label: string; is_money_doc: number;
    }>(ctx.company!.id,
      `SELECT storage_key, mime_type, label, is_money_doc FROM documents
       WHERE id = ? AND deleted_at IS NULL`, [id]
    );
    if (!doc) return reply.code(404).send({ error: 'No such document' });
    if (doc.is_money_doc === 1 && !ctx.caps.money) {
      return reply.code(403).send({ error: 'Not permitted' });
    }

    const inline = (req.query as { inline?: string }).inline === '1';
    reply.header('content-type', doc.mime_type ?? 'application/octet-stream');
    reply.header('content-disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${doc.label.replace(/["\\]/g, '')}"`);
    reply.header('cache-control', 'private, max-age=300');
    return reply.send(readStream(doc.storage_key));
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

  /** Soft delete — the row stays, the file goes. */
  app.delete('/api/documents/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.deleteDocuments) return reply.code(403).send({ error: 'Not permitted' });

    const id = Number((req.params as { id: string }).id);
    const cid = ctx.company!.id;

    const doc = await tqOne<RowDataPacket & { storage_key: string; label: string; ro_id: number }>(
      cid, 'SELECT storage_key, label, ro_id FROM documents WHERE id = ? AND deleted_at IS NULL', [id]
    );
    if (!doc) return reply.code(404).send({ error: 'No such document' });

    await texec(cid, 'UPDATE documents SET deleted_at = NOW() WHERE id = ?', [id]);
    await removeFile(doc.storage_key);
    await texec(cid,
      `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [doc.ro_id, `Document deleted: ${doc.label}.`, ctx.user.id, ctx.user.name]
    );

    return { ok: true };
  });
}
