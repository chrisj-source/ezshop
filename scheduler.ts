import { FastifyInstance } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { tq, texec, tqOne, withTenantTx } from '../db/tenant';
import { requireCompany, requireFeature } from '../middleware/context';
import { extensionOf, storageKey, writeStream } from '../lib/storage';

/**
 * Mobile check-in. A phone at the door: job type, VIN, decoded vehicle,
 * customer, intake photos. Creates the repair order and its documents.
 */
export async function registerCheckin(app: FastifyInstance): Promise<void> {

  /** Decode a VIN through NHTSA. Free, no key, and authoritative for US vehicles. */
  app.get('/api/vin/:vin', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;

    const vin = String((req.params as { vin: string }).vin).trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) {
      return reply.code(400).send({ error: 'That does not look like a VIN.' });
    }

    try {
      const res = await fetch(
        `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (!res.ok) throw new Error('decode service unavailable');
      const json = await res.json() as { Results?: Array<Record<string, string>> };
      const r = json.Results?.[0];
      if (!r) throw new Error('no result');

      return {
        vin,
        year: r.ModelYear ? Number(r.ModelYear) : null,
        make: title(r.Make),
        model: title(r.Model),
        trim: r.Trim || null,
        bodyClass: r.BodyClass || null,
        doors: r.Doors ? Number(r.Doors) : null,
        driveType: r.DriveType || null,
        engine: [r.EngineCylinders ? r.EngineCylinders + 'cyl' : null,
                 r.DisplacementL ? Number(r.DisplacementL).toFixed(1) + 'L' : null]
                 .filter(Boolean).join(' ') || null,
        plant: [r.PlantCity, r.PlantCountry].filter(Boolean).join(', ') || null,
        error: r.ErrorText && !/^0/.test(r.ErrorCode ?? '') ? r.ErrorText : null
      };
    } catch (e) {
      req.log.warn({ err: e }, 'vin decode failed');
      return reply.code(502).send({ error: 'Could not reach the VIN service. Enter the vehicle by hand.' });
    }
  });

  /** Look up an existing customer by phone or name fragment. */
  app.get('/api/clients/search', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const q = String((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 2) return { clients: [] };

    const like = `%${q}%`;
    const digits = q.replace(/\D/g, '');
    const rows = await tq<RowDataPacket[]>(ctx.company!.id, `
      SELECT id, kind, wholesale_type, name, contact_name, phone, email
      FROM clients
      WHERE active = 1 AND (name LIKE ? OR contact_name LIKE ?
        ${digits.length >= 4 ? "OR REPLACE(REPLACE(REPLACE(phone,'-',''),' ',''),'.','') LIKE ?" : ''})
      ORDER BY name LIMIT 20`,
      digits.length >= 4 ? [like, like, `%${digits}%`] : [like, like]
    );
    return { clients: rows };
  });

  /**
   * The check-in itself. Multipart: fields plus any number of photos.
   * One transaction for the file, then photos are attached.
   */
  app.post('/api/checkin', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!requireFeature(ctx, 'mcheck', reply)) return;
    if (!ctx.caps.editRepairOrders) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const fields: Record<string, string> = {};
    const photos: Array<{
      key: string; bytes: number; mime: string; name: string;
      thumbKey?: string; width?: number; height?: number;
    }> = [];
    const thumbs = new Map<string, { key: string }>();
    const dims = new Map<string, string>();

    if (!req.isMultipart()) return reply.code(400).send({ error: 'Expected a multipart submission' });

    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname.startsWith('dim')) dims.set(part.fieldname.slice(3), String(part.value));
        else fields[part.fieldname] = String(part.value);
        continue;
      }

      const ext = extensionOf(part.filename ?? '', part.mimetype);
      const key = storageKey(cid, ext);
      const bytes = await writeStream(key, part.file);

      if (part.fieldname.startsWith('thumb')) {
        thumbs.set(part.fieldname.slice(5), { key });
      } else {
        const index = part.fieldname.replace(/^(file|photo)/, '');
        photos.push({
          key, bytes, mime: part.mimetype ?? 'image/jpeg',
          name: part.filename ?? 'photo.jpg',
          thumbKey: index, width: undefined, height: undefined
        });
      }
    }

    const roNumber = (fields.roNumber ?? '').trim();
    if (!roNumber) return reply.code(400).send({ error: 'RO number is required' });

    const dup = await tqOne<RowDataPacket>(cid, 'SELECT id FROM repair_orders WHERE ro_number = ?', [roNumber]);
    if (dup) return reply.code(409).send({ error: `RO ${roNumber} already exists.` });

    const jobType = fields.jobType ?? 'undecided';
    const payType = fields.payType ?? 'retail';
    const isWholesale = payType === 'wholesale';

    // A wholesale car is billed to an account that must already exist.
    if (isWholesale) {
      const acct = fields.clientId ? await tqOne<RowDataPacket & { id: number; kind: string; active: number }>(
        cid, 'SELECT id, kind, active FROM clients WHERE id = ?', [Number(fields.clientId)]
      ) : null;
      if (!acct || acct.kind !== 'wholesale' || acct.active !== 1) {
        return reply.code(400).send({
          error: 'Pick the wholesale account sending this car. Add accounts in Admin › Clients.'
        });
      }
    }
    const pathMap: Record<string, string> = {
      hail: 'pdr', dent: 'pdr', collision: 'conventional',
      both: 'both', detail: 'undecided', undecided: 'undecided'
    };

    const roId = await withTenantTx(cid, async (c) => {
      let clientId: number | null = fields.clientId ? Number(fields.clientId) : null;

      // Retail and insurance cars create a customer record; wholesale bills
      // the account, so the person who dropped it is a note, not a client.
      if (!isWholesale && !clientId && fields.customerName) {
        const [r] = await c.query<ResultSetHeader>(
          `INSERT INTO clients (kind, name, phone, email) VALUES ('retail', ?, ?, ?)`,
          [fields.customerName, fields.phone || null, fields.email || null]
        );
        clientId = r.insertId;
      }

      let vehicleId: number | null = null;
      if (fields.vin || fields.make) {
        const [r] = await c.query<ResultSetHeader>(
          `INSERT INTO vehicles (client_id, vin, year, make, model, color, plate, plate_state, mileage)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [clientId, (fields.vin || '').toUpperCase() || null,
           fields.year ? Number(fields.year) : null, fields.make || null, fields.model || null,
           fields.color || null, (fields.plate || '').toUpperCase() || null,
           fields.plateState || null, fields.mileage ? Number(fields.mileage) : null]
        );
        vehicleId = r.insertId;
      }

      let insurerId: number | null = null;
      if (fields.insurerName) {
        const [rows] = await c.query<RowDataPacket[]>(
          `SELECT id FROM clients WHERE kind = 'insurance' AND name = ?`, [fields.insurerName]
        );
        if (rows.length) insurerId = rows[0].id as number;
        else {
          const [r] = await c.query<ResultSetHeader>(
            `INSERT INTO clients (kind, name) VALUES ('insurance', ?)`, [fields.insurerName]
          );
          insurerId = r.insertId;
        }
      }

      const [r] = await c.query<ResultSetHeader>(
        `INSERT INTO repair_orders
           (ro_number, client_id, vehicle_id, insurer_client_id, ro_type, repair_path,
            status_slot, status_since, claim_number, date_of_loss, amount_cents, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'intake.arrived', NOW(), ?, ?, ?, ?)`,
        [roNumber, clientId, vehicleId, insurerId,
         isWholesale ? 'wholesale' : 'repair', pathMap[jobType] ?? 'undecided',
         fields.claimNumber || null, fields.dateOfLoss || null,
         Number(fields.amountCents) > 0 ? Number(fields.amountCents) : 0, ctx.user.id]
      );
      const id = r.insertId;

      await c.query(
        `INSERT INTO ro_status_history (ro_id, from_slot, to_slot, to_label, reason, user_id, user_name)
         VALUES (?, NULL, 'intake.arrived', 'Vehicle Arrived', 'Mobile check-in', ?, ?)`,
        [id, ctx.user.id, ctx.user.name]
      );

      await c.query(
        `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
        [id, `Checked in from a phone${photos.length ? ` with ${photos.length} intake photo${photos.length === 1 ? '' : 's'}` : ''}.`,
         ctx.user.id, ctx.user.name]
      );

      if (isWholesale && fields.droppedBy) {
        await c.query(
          `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
          [id, `Dropped off by ${fields.droppedBy}.`, ctx.user.id, ctx.user.name]
        );
      }

      if (fields.damageNote) {
        await c.query(
          `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'note', ?, ?, ?)`,
          [id, fields.damageNote, ctx.user.id, ctx.user.name]
        );
      }

      return id;
    });

    for (const p of photos) {
      const index = p.thumbKey ?? '';
      const thumb = thumbs.get(index)?.key ?? null;
      const [w, h] = (dims.get(index) ?? '').split('x').map(Number);

      await texec(cid, `
        INSERT INTO documents
          (ro_id, doc_type, label, storage_key, thumb_key, mime_type, width, height,
           is_image, size_bytes, is_money_doc, uploaded_by, uploaded_name)
        VALUES (?, 'photos_intake', ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
        [roId, p.name.slice(0, 190), p.key, thumb, p.mime, w || null, h || null,
         p.bytes, ctx.user.id, ctx.user.name]
      );
    }

    return { ok: true, id: roId, roNumber, photos: photos.length };
  });

  /** Suggest the next RO number so two people at the door do not collide. */
  app.get('/api/next-ro-number', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const row = await tqOne<RowDataPacket & { ro_number: string }>(ctx.company!.id,
      `SELECT ro_number FROM repair_orders ORDER BY id DESC LIMIT 1`);

    if (!row) return { suggestion: String(new Date().getFullYear()).slice(2) + '0001' };

    const m = /^(.*?)(\d+)$/.exec(row.ro_number);
    if (!m) return { suggestion: '', last: row.ro_number };

    const next = m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
    return { suggestion: next, last: row.ro_number };
  });
}

function title(s?: string): string | null {
  if (!s) return null;
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}
