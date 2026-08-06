import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { extensionOf, storageKey, writeStream } from '../lib/storage';
import { notify } from '../notify';

/**
 * The mobile sales app.
 *
 * A rep on the road writes an opportunity: name, phone, a photo of the signed
 * contract. That raises a lead. Then the shop's remaining drop capacity decides
 * what they can promise the customer — or tells them to bring the car in
 * themselves.
 */
export async function registerSales(app: FastifyInstance): Promise<void> {

  /** What a rep needs to know before they promise anything. */
  app.get('/api/sales/capacity', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'msales', reply)) return;

    const days = Math.min(Math.max(Number((req.query as { days?: string }).days ?? 10), 1), 30);
    const cid = ctx.company!.id;

    const capRow = await tqOne<RowDataPacket & { setting_value: string }>(cid,
      "SELECT setting_value FROM shop_settings WHERE setting_key = 'cap_drop'");
    const cap = Number(capRow?.setting_value ?? 0);

    const closedRow = await tqOne<RowDataPacket & { setting_value: string }>(cid,
      "SELECT setting_value FROM shop_settings WHERE setting_key = 'closed_days'");
    const closed = String(closedRow?.setting_value ?? '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    const booked = await tq<RowDataPacket[]>(cid, `
      SELECT DATE(starts_at) AS day, COUNT(*) AS n
      FROM appointments
      WHERE cancelled_at IS NULL AND kind = 'drop'
        AND starts_at >= CURDATE() AND starts_at < DATE_ADD(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(starts_at)`, [days]);

    const used: Record<string, number> = {};
    for (const b of booked) used[isoDay(b.day as Date)] = Number(b.n);

    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const out = [];

    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() + i);
      const iso = isoDay(d);
      const weekday = names[d.getDay()];
      const isClosed = closed.includes(weekday);
      const u = used[iso] ?? 0;
      out.push({
        day: iso,
        weekday,
        label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        used: u,
        cap,
        open: isClosed ? 0 : Math.max(0, cap - u),
        closed: isClosed
      });
    }

    return {
      capacity: cap,
      days: out,
      // If nothing is open in the window, the rep drives it in themselves —
      // better than promising a slot the shop cannot take.
      anyOpen: out.some(d => d.open > 0)
    };
  });

  /**
   * Write an opportunity. Multipart so the contract photo comes with it.
   * Creates a lead, files the photo, and optionally books the drop.
   */
  app.post('/api/sales/opportunity', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'msales', reply)) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'Expected a multipart submission' });

    const cid = ctx.company!.id;
    const fields: Record<string, string> = {};
    const shots: Array<{ key: string; bytes: number; mime: string; name: string; thumb?: string; dim?: string }> = [];
    const thumbs = new Map<string, string>();
    const dims = new Map<string, string>();

    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname.startsWith('dim')) dims.set(part.fieldname.slice(3), String(part.value));
        else fields[part.fieldname] = String(part.value);
        continue;
      }

      const key = storageKey(cid, extensionOf(part.filename ?? '', part.mimetype));
      const bytes = await writeStream(key, part.file);

      if (part.fieldname.startsWith('thumb')) {
        thumbs.set(part.fieldname.slice(5), key);
      } else {
        shots.push({
          key, bytes,
          mime: part.mimetype ?? 'image/jpeg',
          name: part.filename ?? 'contract.jpg',
          thumb: part.fieldname.replace(/^(file|photo|contract)/, '')
        });
      }
    }

    const first = (fields.firstName ?? '').trim();
    const last = (fields.lastName ?? '').trim();
    const phone = (fields.phone ?? '').trim();

    if (!last && !first) return reply.code(400).send({ error: 'A name is required.' });
    if (!phone) return reply.code(400).send({ error: 'A phone number is required.' });

    const dropDay = (fields.dropDay ?? '').trim();
    const selfDeliver = fields.selfDeliver === '1';

    const result = await withTenantTx(cid, async (c) => {
      const [seq] = await c.query<RowDataPacket[]>(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(lead_number, 2) AS UNSIGNED)), 0) + 1 AS n FROM leads`);
      const num = 'L' + String(Number(seq[0].n ?? 1)).padStart(5, '0');

      const [l] = await c.query<ResultSetHeader>(`
        INSERT INTO leads
          (lead_number, source, state, first_name, last_name, phone, email,
           vehicle_text, damage_note, owner_user_id, first_reply_at)
        VALUES (?, 'sales app', 'contacted', ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [num, first || null, last || null, phone, (fields.email ?? '').trim() || null,
         (fields.vehicleText ?? '').trim() || null, (fields.note ?? '').trim() || null,
         ctx.user.id]);

      const leadId = l.insertId;

      await c.query(
        `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [leadId, `Written on the road by ${ctx.user.name}${shots.length ? ' with a contract photo' : ''}.`,
         ctx.user.id, ctx.user.name]);

      let appointmentId: number | null = null;

      if (dropDay && !selfDeliver) {
        const [cnt] = await c.query<RowDataPacket[]>(`
          SELECT COUNT(*) AS n FROM appointments
          WHERE cancelled_at IS NULL AND kind = 'drop' AND DATE(starts_at) = ?`, [dropDay]);
        const [capRow] = await c.query<RowDataPacket[]>(
          "SELECT setting_value FROM shop_settings WHERE setting_key = 'cap_drop'");
        const cap = Number(capRow[0]?.setting_value ?? 0);

        if (cap > 0 && Number(cnt[0].n ?? 0) >= cap) {
          throw new Error(`${dropDay} filled up while you were writing this. Pick another day.`);
        }

        const [a] = await c.query<ResultSetHeader>(`
          INSERT INTO appointments
            (kind, starts_at, duration_min, lead_id, customer_name, vehicle_text, phone, note, created_by)
          VALUES ('drop', ?, 30, ?, ?, ?, ?, ?, ?)`,
          [dropDay + ' 09:00:00', leadId, [first, last].filter(Boolean).join(' '),
           (fields.vehicleText ?? '').trim() || null, phone,
           'Booked from the sales app', ctx.user.id]);

        appointmentId = a.insertId;
        await c.query('UPDATE leads SET appointment_id = ?, state = ? WHERE id = ?',
          [appointmentId, 'appraisal_booked', leadId]);
        await c.query(
          `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
          [leadId, `Drop off booked for ${dropDay}.`, ctx.user.id, ctx.user.name]);
      }

      if (selfDeliver) {
        await c.query(
          `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
          [leadId, `${ctx.user.name} is bringing the vehicle in themselves — no drop slot used.`,
           ctx.user.id, ctx.user.name]);
      }

      return { leadId, leadNumber: num, appointmentId };
    });

    // The contract photo is filed against the lead, not a repair order — there
    // is no RO yet. It moves across on conversion.
    for (const s of shots) {
      const idx = s.thumb ?? '';
      const [w, h] = (dims.get(idx) ?? '').split('x').map(Number);
      await texec(cid, `
        INSERT INTO lead_documents
          (lead_id, label, storage_key, thumb_key, mime_type, width, height, size_bytes, uploaded_by, uploaded_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [result.leadId, s.name.slice(0, 190), s.key, thumbs.get(idx) ?? null,
         s.mime, w || null, h || null, s.bytes, ctx.user.id, ctx.user.name]);
    }

    await notify({
      companyId: cid,
      event: 'assign.file',
      leadId: result.leadId,
      title: `New opportunity — ${[first, last].filter(Boolean).join(' ')}`,
      body: `${ctx.user.name} wrote ${result.leadNumber}` +
        (result.appointmentId ? `, dropping ${dropDay}.` : selfDeliver ? ', bringing it in themselves.' : '.'),
      actorUserId: ctx.user.id,
      dedupeKey: `opp:${result.leadId}`
    }).catch(() => {});

    return { ok: true, ...result, photos: shots.length };
  });

  /** A rep's own recent work, so they can see what they wrote. */
  app.get('/api/sales/mine', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT l.id, l.lead_number, l.first_name, l.last_name, l.phone, l.vehicle_text,
             l.state, l.received_at, l.ro_id, r.ro_number,
             a.starts_at AS drop_at,
             (SELECT COUNT(*) FROM lead_documents d WHERE d.lead_id = l.id) AS photos
      FROM leads l
      LEFT JOIN repair_orders r ON r.id = l.ro_id
      LEFT JOIN appointments a ON a.id = l.appointment_id
      WHERE l.owner_user_id = ? AND l.received_at > DATE_SUB(NOW(), INTERVAL 60 DAY)
      ORDER BY l.received_at DESC LIMIT 100`, [ctx.user.id]);

    const [sum] = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT COUNT(*) AS written,
             SUM(state = 'won') AS won,
             SUM(state = 'lost') AS lost
      FROM leads
      WHERE owner_user_id = ? AND received_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`, [ctx.user.id]);

    return {
      opportunities: rows,
      summary: {
        written: Number(sum.written ?? 0),
        won: Number(sum.won ?? 0),
        lost: Number(sum.lost ?? 0)
      }
    };
  });

  /** Photos filed against a lead. */
  app.get('/api/leads/:id/documents', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);

    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, label, width, height, size_bytes, thumb_key IS NOT NULL AS has_thumb,
             uploaded_name, created_at
      FROM lead_documents WHERE lead_id = ? AND deleted_at IS NULL ORDER BY id`, [id]);

    return { documents: rows };
  });

  app.get('/api/lead-documents/:id', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { variant?: string; download?: string };

    const doc = await tqOne<RowDataPacket & {
      storage_key: string; thumb_key: string | null; mime_type: string | null; label: string;
    }>(ctx.company!.id,
      'SELECT storage_key, thumb_key, mime_type, label FROM lead_documents WHERE id = ? AND deleted_at IS NULL',
      [id]);
    if (!doc) return reply.code(404).send({ error: 'No such document' });

    const { readStream } = await import('../lib/storage');
    const wantThumb = q.variant === 'thumb' && doc.thumb_key;

    reply.header('content-type', wantThumb ? 'image/jpeg' : (doc.mime_type ?? 'application/octet-stream'));
    reply.header('content-disposition',
      `${q.download === '1' ? 'attachment' : 'inline'}; filename="${doc.label.replace(/[^\w .-]/g, '_')}"`);
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(readStream(wantThumb ? doc.thumb_key! : doc.storage_key));
  });
}

function isoDay(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
