import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { mexec } from '../db/master';
import { RowDataPacket } from 'mysql2/promise';
import { texec, tq } from '../db/tenant';
import { invalidateFeatures, requireCompany, requirePlatformOwner } from '../middleware/context';
import {
  receiveSms, removeAccount, replyRouting, saveAccount, sendSms, signatureOk, smsReady, smsSummary,
  statusCallback, verifyAccount
} from '../lib/sms';
import { fileFacts, fill, sentLength, SAMPLE, shopFacts, TOKENS } from '../lib/sms-status';
import { consentText, mayContact, normalise, recordConsent } from '../lib/consent';
import { suppressionState } from '../lib/suppression';
import { mayTouch } from './ro';
import { audit } from '../lib/audit';
import { actorFrom } from './audit';

async function paudit(actor: number, companyId: number, action: string, detail: unknown): Promise<void> {
  await mexec('INSERT INTO platform_audit (actor_user_id, company_id, action, detail) VALUES (?, ?, ?, ?)',
    [actor, companyId, action, JSON.stringify(detail ?? null)]).catch(() => undefined);
}

export async function registerSms(app: FastifyInstance): Promise<void> {

  /* ------------------------------------------------ platform admin: the account */

  app.get('/api/platform/companies/:id/sms', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    return smsSummary(Number((req.params as { id: string }).id));
  });

  app.put('/api/platform/companies/:id/sms', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const b = req.body as { accountSid?: string; authToken?: string; senderKind?: 'number' | 'service'; sender?: string };
    try {
      await saveAccount(id, b, ctx.user.id);
      /* Never log the token, not even sealed. */
      await paudit(ctx.user.id, id, 'sms.account.saved', {
        accountSid: b.accountSid, tokenChanged: !!b.authToken, senderKind: b.senderKind, sender: b.sender });
      const v = await verifyAccount(id).catch((e: Error) => ({ ok: false, error: e.message }));
      return { summary: await smsSummary(id), verify: v };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/platform/companies/:id/sms/verify', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    try {
      const v = await verifyAccount(id);
      return { summary: await smsSummary(id), verify: v };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message, summary: await smsSummary(id) });
    }
  });

  /** Removing the account also switches texting off — nothing could send anyway. */
  app.delete('/api/platform/companies/:id/sms', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    await removeAccount(id);
    await mexec(`INSERT INTO company_features (company_id, feature_key, enabled, updated_by) VALUES (?, 'sms', 0, ?)
      ON DUPLICATE KEY UPDATE enabled = 0, updated_by = VALUES(updated_by)`, [id, ctx.user.id]);
    invalidateFeatures(id);
    await paudit(ctx.user.id, id, 'sms.account.removed', null);
    return { ok: true };
  });

  /** One text to a number the admin types — their own phone. Skips consent, never suppression. */
  app.post('/api/platform/companies/:id/sms/test', async (req, reply) => {
    const ctx = requirePlatformOwner(req, reply);
    if (!ctx) return;
    const id = Number((req.params as { id: string }).id);
    const { to } = req.body as { to?: string };
    if (!to) return reply.code(400).send({ error: 'Give a number to send the test to.' });
    const r = await sendSms(id, to, 'Test message from Easy Shop. Text messaging is set up for this shop.',
      { purpose: 'test', sentBy: ctx.user.id });
    await paudit(ctx.user.id, id, 'sms.test', { to: String(to).replace(/\D/g, '').slice(-4), state: r.state });
    if (!r.ok) return reply.code(400).send({ error: r.reason ?? 'Not sent.' });
    return r;
  });

  /* ------------------------------------------------- the file: messages */

  /**
   * The thread on one file, oldest first, and whether the desk may write.
   * Needs the customer-contact capability: the thread carries the number.
   * Opening it marks the replies read.
   */
  app.get('/api/ro/:id/sms', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    if (!ctx.caps.viewCustomerContact) return { visible: false };
    if (!await mayTouch(ctx, id)) return reply.code(403).send({ error: 'Not your file' });

    const f = await fileFacts(cid, id);
    const phone = f?.phone ?? null;
    const dest = phone ? normalise('sms', phone) : '';
    const messages = await tq<RowDataPacket[]>(cid, `
      SELECT id, direction, body, purpose, trigger_key, state, reason, sent_by_name, read_at, created_at
        FROM sms_messages
       WHERE ro_id = ? ${dest ? "OR (ro_id IS NULL AND destination = ?)" : ''}
       ORDER BY created_at, id`, dest ? [id, dest] : [id]).catch(() => []);
    await texec(cid, "UPDATE sms_messages SET read_at = NOW() WHERE ro_id = ? AND direction = 'in' AND read_at IS NULL", [id])
      .catch(() => undefined);

    const on = ctx.features.has('sms') && await smsReady(cid);
    const sup = dest ? await suppressionState('sms', dest, cid) : { suppressed: false };
    const c = dest ? await mayContact(cid, 'sms', dest, 'transactional', id) : null;
    const wording = await consentText(cid);
    return {
      visible: true, on, phone,
      unread: messages.filter(m => m.direction === 'in' && !m.read_at).length,
      messages,
      stopped: !!sup.suppressed,
      allowed: !!c?.allowed,
      reason: !phone ? 'No phone number on the file.' : sup.suppressed ? 'They replied STOP.' : (c?.allowed ? null : c?.reason ?? null),
      /* The shop-side confirmation, offered only where it would change the answer. */
      canConfirm: !!phone && !sup.suppressed && !c?.allowed && !!wording?.body,
      consentWording: wording?.body ?? null,
      sender: (await smsSummary(cid)).sender
    };
  });

  app.post('/api/ro/:id/sms', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    if (!ctx.caps.viewCustomerContact) return reply.code(403).send({ error: 'Not permitted' });
    if (!await mayTouch(ctx, id)) return reply.code(403).send({ error: 'Not your file' });
    const body = String((req.body as { body?: string })?.body ?? '').trim();
    if (!body) return reply.code(400).send({ error: 'Write a message first.' });
    if (body.length > 600) return reply.code(400).send({ error: 'That is too long for a text.' });
    const f = await fileFacts(cid, id);
    if (!f?.phone) return reply.code(400).send({ error: 'No phone number on the file.' });
    const r = await sendSms(cid, f.phone, body, {
      purpose: 'transactional', roId: id, sentBy: ctx.user.id, sentByName: ctx.user.name });
    if (!r.ok) return reply.code(400).send({ error: r.reason ?? 'Not sent.' });
    return r;
  });

  /**
   * The shop confirming the customer agreed to text updates — the toggle from
   * the TCPA decision of 18 Sep 2026, here on the file. An ordinary
   * transactional consent row for this car, wording copied in as it reads
   * today, source 'desk'. It never overrides STOP: suppression is checked on
   * every send regardless.
   */
  app.post('/api/ro/:id/sms/consent', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    if (!ctx.caps.editCustomerContact) return reply.code(403).send({ error: 'Not permitted' });
    if (!await mayTouch(ctx, id)) return reply.code(403).send({ error: 'Not your file' });
    const f = await fileFacts(cid, id);
    const w = await consentText(cid);
    if (!f?.phone) return reply.code(400).send({ error: 'No phone number on the file.' });
    if (!w?.body) return reply.code(400).send({ error: 'Save the shop\'s consent wording first (Admin › Web form).' });
    await recordConsent(cid, {
      kind: 'transactional', channel: 'sms', destination: f.phone, granted: true,
      source: 'desk', wordingShown: w.body, boxesTicked: `confirmed by shop — ${ctx.user.name}, file drawer`,
      ip: req.ip, roId: id
    });
    await audit(cid, actorFrom(req), {
      entity: 'consents', entityId: id, roId: id, action: 'consent_confirmed', area: 'Messages',
      label: 'Text updates confirmed by the shop — the customer agreed',
      detail: { channel: 'sms', captured_by: 'drawer' } });
    return { ok: true };
  });

  /* ---------------------------------------------- admin: the shop's wording */

  app.get('/api/admin/sms-templates', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id;
    const shop = await shopFacts(cid);
    const sample = { ...SAMPLE, shopName: shop.shopName || 'Your Shop', shopPhone: shop.shopPhone || SAMPLE.shopPhone };
    const rows = await tq<RowDataPacket[]>(cid,
      'SELECT trigger_key, label, note, body, enabled FROM sms_templates ORDER BY sort_order').catch(() => []);
    return {
      on: ctx.features.has('sms') && await smsReady(cid),
      tokens: TOKENS,
      templates: rows.map(t => ({ ...t, enabled: Number(t.enabled) === 1,
        length: sentLength(fill(String(t.body), sample)) })),
      routing: await replyRouting(cid)
    };
  });

  app.put('/api/admin/sms-templates/:key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id;
    const key = (req.params as { key: string }).key;
    const b = req.body as { body?: string; enabled?: boolean };
    const sets: string[] = []; const vals: unknown[] = [];
    if (b.body !== undefined) {
      const t = String(b.body).trim();
      if (!t) return reply.code(400).send({ error: 'A message cannot be empty.' });
      if (t.length > 480) return reply.code(400).send({ error: 'Keep it under 480 characters.' });
      if (/reply\s+stop/i.test(t)) return reply.code(400).send({ error: 'Leave the STOP line off — it is added to every text automatically.' });
      sets.push('body = ?'); vals.push(t);
    }
    if (b.enabled !== undefined) { sets.push('enabled = ?'); vals.push(b.enabled ? 1 : 0); }
    if (!sets.length) return reply.code(400).send({ error: 'Nothing to change' });
    sets.push('updated_by = ?'); vals.push(ctx.user.id, key);
    const r = await texec(cid, `UPDATE sms_templates SET ${sets.join(', ')} WHERE trigger_key = ?`, vals);
    if (!r.affectedRows) return reply.code(404).send({ error: 'No such update' });
    return { ok: true };
  });

  app.put('/api/admin/sms-reply-routing', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.admin) return reply.code(403).send({ error: 'Owner only' });
    const cid = ctx.company!.id;
    const list = (req.body as { routing?: Array<{ target: string; enabled: boolean }> })?.routing ?? [];
    for (const r of list) {
      if (!/^[a-z_]{2,40}$/.test(r.target)) continue;
      await texec(cid, `INSERT INTO sms_reply_routing (target, enabled) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`, [r.target, r.enabled ? 1 : 0]);
    }
    return { ok: true, routing: await replyRouting(cid) };
  });

  /* ------------------------------------------------------- Twilio's webhooks */

  /**
   * Public, no session, no Origin. Authority is Twilio's signature, checked
   * against that shop's own Auth Token — an unsigned or mis-signed post is
   * refused before anything is read. Twilio posts form-encoded, so the parser
   * is registered inside this plugin only.
   */
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' },
      (_req, body, done) => {
        try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); }
        catch (e) { done(e as Error, undefined); }
      });

    const check = async (req: { url: string; headers: Record<string, unknown>; body: unknown }, companyId: number) => {
      const url = `${config.appUrl.replace(/\/$/, '')}${req.url}`;
      return signatureOk(companyId, url, (req.body ?? {}) as Record<string, string>,
        String(req.headers['x-twilio-signature'] ?? ''));
    };

    hook.post('/api/sms/twilio/inbound/:companyId', async (req, reply) => {
      const companyId = Number((req.params as { companyId: string }).companyId);
      if (!companyId || !(await check(req, companyId))) return reply.code(403).send('Forbidden');
      const b = req.body as Record<string, string>;
      await receiveSms(companyId, b.From ?? '', b.Body ?? '', b.MessageSid ?? '');
      /* Empty TwiML: Twilio's own opt-out handling answers STOP/START/HELP. */
      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });

    hook.post('/api/sms/twilio/status/:companyId', async (req, reply) => {
      const companyId = Number((req.params as { companyId: string }).companyId);
      if (!companyId || !(await check(req, companyId))) return reply.code(403).send('Forbidden');
      const b = req.body as Record<string, string>;
      await statusCallback(companyId, b.MessageSid ?? '', b.MessageStatus ?? '', b.ErrorCode);
      return reply.code(204).send();
    });
  });
}
