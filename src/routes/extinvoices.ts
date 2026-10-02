import { FastifyInstance } from 'fastify';
import { mexec } from '../db/master';
import { RowDataPacket } from 'mysql2/promise';
import { texec, tqOne } from '../db/tenant';
import { companyFeatures, requireCompany, requirePlatformOwner } from '../middleware/context';
import { invoicesForRo, removeSource, saveSource, sourceSummary, stageOf, syncInvoices, testSource } from '../lib/extinvoices';
import { mayTouch } from './ro';

async function paudit(actor: number, companyId: number, action: string, detail: unknown): Promise<void> {
  await mexec('INSERT INTO platform_audit (actor_user_id, company_id, action, detail) VALUES (?, ?, ?, ?)',
    [actor, companyId, action, JSON.stringify(detail ?? null)]).catch(() => undefined);
}

async function featureOn(companyId: number): Promise<boolean> {
  return (await companyFeatures(companyId)).includes('extinv');
}

/**
 * The connection to a shop's own invoicing database. Set by platform admin or
 * by the shop's owner (decided 2 Oct 2026) — but only once platform has
 * switched the feature on for that shop, so no other shop is ever offered it.
 */
export async function registerExtInvoices(app: FastifyInstance): Promise<void> {

  /* ------------------------------------------------------------- the shop */

  app.get('/api/admin/invoice-source', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    if (!ctx.features.has('extinv')) return reply.code(404).send({ error: 'Not available' });
    return sourceSummary(ctx.company!.id);
  });

  app.put('/api/admin/invoice-source', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (ctx.role !== 'owner' && !ctx.impersonating) return reply.code(403).send({ error: 'The shop owner sets this.' });
    if (!ctx.features.has('extinv')) return reply.code(404).send({ error: 'Not available' });
    const cid = ctx.company!.id;
    try {
      await saveSource(cid, req.body as never, ctx.user.id);
      await texec(cid, `INSERT INTO audit_log (user_id, user_name, entity, action, detail) VALUES (?, ?, 'invoice_source', 'saved', ?)`,
        [ctx.user.id, ctx.user.name, JSON.stringify({ ...(req.body as object), password: undefined })]);
      const test = await testSource(cid).catch((e: Error) => ({ error: e.message }));
      return { summary: await sourceSummary(cid), test };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post('/api/admin/invoice-source/sync', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    if (!ctx.features.has('extinv')) return reply.code(404).send({ error: 'Not available' });
    try { return { ...(await syncInvoices(ctx.company!.id)), summary: await sourceSummary(ctx.company!.id) }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message, summary: await sourceSummary(ctx.company!.id) }); }
  });

  /** The invoices tied to one file, for the drawer. Amounts need the money capability. */
  app.get('/api/ro/:id/invoices', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.features.has('extinv')) return reply.code(404).send({ error: 'Not available' });
    const id = Number((req.params as { id: string }).id);
    if (!(await mayTouch(ctx, id))) return reply.code(404).send({ error: 'No such repair order' });
    const src = await sourceSummary(ctx.company!.id);
    const rows = await invoicesForRo(ctx.company!.id, id);
    return {
      lastOkAt: (src as { lastOkAt?: unknown }).lastOkAt ?? null,
      invoices: rows.map(r => ({
        id: r.ext_id, number: r.number, profile: r.profile, client: r.client_name,
        stage: stageOf(r as never), generatedAt: r.generated_at, sentAt: r.sent_at, paidAt: r.paid_at,
        invoiceDate: r.invoice_date, dueDate: r.due_date, manual: r.match_how === 'manual',
        totalCents: ctx.caps.money ? Number(r.total_cents) : undefined,
        paidCents: ctx.caps.money ? Number(r.paid_cents) : undefined
      }))
    };
  });

  /**
   * Tie an invoice to this file by its number when the read could not. The tie
   * is manual from then on and no later read moves it.
   */
  app.post('/api/ro/:id/invoices/link', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.features.has('extinv')) return reply.code(404).send({ error: 'Not available' });
    if (!ctx.caps.money) return reply.code(403).send({ error: 'Not permitted' });
    const id = Number((req.params as { id: string }).id);
    if (!(await mayTouch(ctx, id))) return reply.code(404).send({ error: 'No such repair order' });
    const b = req.body as { number?: string; unlink?: number };
    const cid = ctx.company!.id;
    if (b.unlink) {
      await texec(cid, "UPDATE external_invoices SET ro_id = NULL, match_how = NULL WHERE ext_id = ? AND ro_id = ?", [b.unlink, id]);
      return { ok: true };
    }
    const n = String(b.number ?? '').trim().toUpperCase();
    if (!n) return reply.code(400).send({ error: 'Give the invoice number.' });
    const hit = await tqOne<RowDataPacket>(cid, 'SELECT ext_id, ro_id FROM external_invoices WHERE UPPER(number) = ? ORDER BY ext_id DESC LIMIT 1', [n]);
    if (!hit) return reply.code(404).send({ error: `No invoice ${n} has been read yet. Reads are hourly.` });
    await texec(cid, "UPDATE external_invoices SET ro_id = ?, match_how = 'manual' WHERE ext_id = ?", [id, hit.ext_id]);
    await texec(cid, `INSERT INTO ro_notes (ro_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
      [id, `Invoice ${n} tied to this file by hand.`, ctx.user.id, ctx.user.name]);
    return { ok: true };
  });

  /* ------------------------------------------------------------- platform */

  app.get('/api/platform/companies/:id/invoice-source', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    return { featureOn: await featureOn(id), ...(await sourceSummary(id)) };
  });

  app.put('/api/platform/companies/:id/invoice-source', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    try {
      await saveSource(id, req.body as never, ctx.user.id);
      await paudit(ctx.user.id, id, 'invoice_source.saved', { ...(req.body as object), password: undefined });
      const test = await testSource(id).catch((e: Error) => ({ error: e.message }));
      return { summary: { featureOn: await featureOn(id), ...(await sourceSummary(id)) }, test };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post('/api/platform/companies/:id/invoice-source/sync', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    try { return await syncInvoices(id); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.delete('/api/platform/companies/:id/invoice-source', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    await removeSource(id);
    await paudit(ctx.user.id, id, 'invoice_source.removed', null);
    return { ok: true };
  });
}
