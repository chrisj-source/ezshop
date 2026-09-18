import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mexec } from '../db/master';
import { tq, tqOne, texec, withTenantTx } from '../db/tenant';
import { requireCompany } from '../middleware/context';
import { pushAppointment } from './gcal';
import { config } from '../config';
import {
  contrastRatio, contrastWarnings, funnelFields, funnelSettings, keysFor,
  newPublicKey, publicSlots, renderLetter, LETTER_TOKENS, LetterTokens, REQUIRED_FIELDS
} from '../lib/funnel';
import { prettyDate, sendCustomerLetter } from './funnel';
import { consentReady, consentText, missingFromConsent } from '../lib/consent';

/**
 * The desk half of web funnels: the owner's settings, and the queue.
 *
 * These are internal screens behind sign-in and are NOT held to the public
 * form's accessibility standard — see CLAUDE.md. What they are held to is the
 * rule the form depends on: everything here narrows what a stranger may book
 * and nothing here widens it.
 */
export async function registerFunnelAdmin(app: FastifyInstance): Promise<void> {

  /* ------------------------------------------------------------- settings */

  app.get('/api/web-form', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const [settings, fields, keys, domains, hours, blocks, letters, shopHours, address] =
      await Promise.all([
        funnelSettings(cid),
        funnelFields(cid),
        keysFor(cid),
        tq<RowDataPacket[]>(cid, 'SELECT host, last_seen_at FROM funnel_domains ORDER BY host'),
        tq<RowDataPacket[]>(cid, 'SELECT dow, blocked, open_time, close_time FROM funnel_hours'),
        tq<RowDataPacket[]>(cid,
          `SELECT DATE_FORMAT(on_date,'%Y-%m-%d') AS on_date, label FROM funnel_blocks
            WHERE on_date >= CURDATE() ORDER BY on_date`),
        tq<RowDataPacket[]>(cid, 'SELECT event_key, subject, body, enabled FROM funnel_emails'),
        tq<RowDataPacket[]>(cid, 'SELECT dow, open_time, close_time, closed FROM shop_hours'),
        tq<RowDataPacket[]>(cid,
          `SELECT setting_key, setting_value FROM shop_settings
            WHERE setting_key IN ('shop_address','shop_phone')`)
      ]);

    const closures = await tq<RowDataPacket[]>(cid,
      `SELECT DATE_FORMAT(on_date,'%Y-%m-%d') AS on_date, label, kind, source
         FROM shop_closures WHERE on_date >= CURDATE()
        ORDER BY on_date LIMIT 20`).catch(() => [] as RowDataPacket[]);

    const addr: Record<string, string> = {};
    for (const a of address) addr[String(a.setting_key)] = String(a.setting_value ?? '');

    const consent = await consentText(cid);

    return {
      settings,
      /* Named, because it is the one thing on this screen that is not a
         preference: a shop pastes it and never thinks about it again. */
      snippet: snippetFor(keys[0]?.publicKey ?? ''),
      keys,
      domains,
      fields,
      publicHours: hours,
      /* The shop's real week, shown beside the public one so the narrowing is
         visible rather than asserted. */
      shopHours,
      publicBlocks: blocks,
      /* Read only here. Closures and holidays belong to the shop calendar, and
         un-ticking a holiday is not something this screen should be able to
         undo. */
      shopClosures: closures,
      letters,
      tokens: LETTER_TOKENS.map(t => ({ token: t.token, needs: t.needs ?? null })),
      shopAddress: addr.shop_address ?? '',
      shopPhone: addr.shop_phone ?? '',
      contrast: {
        onButton: contrastRatio(settings.accent, settings.accentInk),
        onPaper: contrastRatio(settings.accent, '#ffffff'),
        warnings: contrastWarnings(settings.accent, settings.accentInk)
      },
      /* The consent block, and what is wrong with it. The form cannot be
         switched on while anything is missing, so this is not advisory. */
      consent: consent,
      consentMissing: consent && consent.body ? missingFromConsent(consent.body) : ['Nothing written yet.'],
      consentReady: await consentReady(cid)
    };
  });

  app.patch('/api/web-form', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const b = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];

    const num = (v: unknown, lo: number, hi: number, d: number): number =>
      Math.min(Math.max(Math.round(Number(v ?? d)) || d, lo), hi);

    /**
     * The one place this is strict: the form does not go live until the shop
     * has written its own consent wording and it contains what it has to.
     *
     * A shop that switched booking on without going near the consent tab would
     * be collecting phone numbers against no disclosure at all — which is the
     * gap that raised this in the first place. Switching the form OFF is never
     * blocked, and neither is any other setting on this screen.
     */
    if (b.enabled && !(await consentReady(cid))) {
      const t = await consentText(cid);
      return reply.code(409).send({
        error: 'The form cannot go live until your consent wording is written and saved.',
        consent: true,
        missing: t && t.body ? missingFromConsent(t.body) : ['Nothing written yet.']
      });
    }

    if (b.enabled !== undefined) { sets.push('enabled = ?'); vals.push(b.enabled ? 1 : 0); }
    if (b.offerEstimate !== undefined) { sets.push('offer_estimate = ?'); vals.push(b.offerEstimate ? 1 : 0); }
    if (b.offerDrop !== undefined) { sets.push('offer_drop = ?'); vals.push(b.offerDrop ? 1 : 0); }
    if (b.holdHours !== undefined) { sets.push('hold_hours = ?'); vals.push(num(b.holdHours, 1, 168, 24)); }
    if (b.noticeHours !== undefined) { sets.push('notice_hours = ?'); vals.push(num(b.noticeHours, 0, 168, 2)); }
    if (b.intro !== undefined) { sets.push('intro = ?'); vals.push(String(b.intro ?? '').slice(0, 400) || null); }
    if (b.replyTo !== undefined) { sets.push('reply_to = ?'); vals.push(String(b.replyTo ?? '').slice(0, 190) || null); }

    /* Colour is the owner's, ink included — the form has to match their theme,
       and a shop that cannot set its own text colour fights it forever. */
    const hex = (v: unknown): string | null => {
      const s = String(v ?? '').trim();
      return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
    };
    const accent = b.accent !== undefined ? hex(b.accent) : null;
    const ink = b.accentInk !== undefined ? hex(b.accentInk) : null;
    if (b.accent !== undefined && !accent) return reply.code(400).send({ error: 'That is not a colour.' });
    if (b.accentInk !== undefined && !ink) return reply.code(400).send({ error: 'That is not a colour.' });
    if (accent) { sets.push('accent = ?'); vals.push(accent); }
    if (ink) { sets.push('accent_ink = ?'); vals.push(ink); }

    /**
     * Warn and allow — and record the acceptance.
     *
     * The form is a Title III surface, so this is a real exception to the AA
     * rule rather than a nicety. Our part ends at telling them what breaks; a
     * shop that was told and proceeded has made its own choice about its own
     * public page. The acceptance is an audit row and NOTHING ELSE: it is
     * never mentioned to the customer, never in the form's markup, and there
     * is no nagging banner afterwards. A record, not a message.
     */
    if (accent || ink) {
      const current = await funnelSettings(cid);
      const warnings = contrastWarnings(accent ?? current.accent, ink ?? current.accentInk);
      if (warnings.length) {
        if (!b.acceptContrast) {
          return reply.code(409).send({
            error: 'Those colours do not meet the contrast this form is held to.',
            contrast: true, canOverride: true, warnings
          });
        }
        sets.push('contrast_ack_at = NOW()', 'contrast_ack_by = ?', 'contrast_ack_note = ?');
        vals.push(ctx.user.id, warnings.join(' ').slice(0, 190));

        await texec(cid, `
          INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
          VALUES (?, ?, 'web_form', 0, 'contrast.accepted', ?)`,
          [ctx.user.id, ctx.user.name, JSON.stringify({
            accent: accent ?? current.accent, ink: ink ?? current.accentInk,
            onButton: contrastRatio(accent ?? current.accent, ink ?? current.accentInk),
            onPaper: contrastRatio(accent ?? current.accent, '#ffffff'),
            warnings
          })]).catch(() => undefined);
      } else {
        sets.push('contrast_ack_at = NULL', 'contrast_ack_by = NULL', 'contrast_ack_note = NULL');
      }
    }

    if (sets.length) {
      await texec(cid, `UPDATE funnel_settings SET ${sets.join(', ')} WHERE id = 1`, vals);
    }

    if (b.shopAddress !== undefined || b.shopPhone !== undefined) {
      for (const [k, v] of [['shop_address', b.shopAddress], ['shop_phone', b.shopPhone]] as const) {
        if (v === undefined) continue;
        await texec(cid,
          `INSERT INTO shop_settings (setting_key, setting_value) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
          [k, String(v ?? '').slice(0, 255)]);
      }
    }

    /* Switching the form on without a key is the one state that cannot work,
       so the first one is minted rather than asked for. */
    if (b.enabled) {
      const keys = await keysFor(cid);
      if (!keys.length) await mintKey(cid, ctx.user.id);
    }

    return { ok: true };
  });

  /* -------------------------------------------------------------- consent */

  /**
   * The shop's own TCPA wording. Their liability, their words, their shop name
   * in it — which is the main reason it cannot be ours.
   *
   * It is checked loosely on save. "Text STOP to quit" has met the opt-out
   * requirement; refusing it because it does not match a template would teach
   * shops to paste words they have not read. What is checked is that each idea
   * is present at all, because a shop that leaves out STOP has collected
   * consent that may be worth nothing and the first anybody would know is a
   * complaint.
   */
  app.put('/api/web-form/consent', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const b = req.body as Record<string, unknown>;
    const body = String(b.body ?? '').trim().slice(0, 2000);
    const label = String(b.label ?? '').trim().slice(0, 190) || 'Text me about my repair.';

    if (!body) return reply.code(400).send({ error: 'Write the consent wording first.' });

    const missing = missingFromConsent(body);
    if (missing.length) {
      return reply.code(400).send({
        error: 'That wording is not complete enough to collect consent against.',
        missing
      });
    }

    const url = (v: unknown): string | null => {
      const s = String(v ?? '').trim();
      if (!s) return null;
      return /^https?:\/\/\S+$/.test(s) ? s.slice(0, 400) : null;
    };
    const privacy = url(b.privacyUrl);
    const terms = url(b.termsUrl);
    if (b.privacyUrl && !privacy) {
      return reply.code(400).send({ error: 'The privacy link has to be a full https:// address.' });
    }
    if (b.termsUrl && !terms) {
      return reply.code(400).send({ error: 'The terms link has to be a full https:// address.' });
    }

    await texec(cid, `
      UPDATE funnel_consent
         SET label = ?, body = ?, privacy_url = ?, terms_url = ?,
             approved_at = NOW(), approved_by = ?, approved_name = ?
       WHERE id = 1`,
      [label, body, privacy, terms, ctx.user.id, ctx.user.name]);

    /* Who approved which words, and when. The consent rows copy the wording in
       at submission time, so this is the shop's own trail of what it published
       rather than the evidence itself. */
    await texec(cid, `
      INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
      VALUES (?, ?, 'web_form', 0, 'consent.saved', ?)`,
      [ctx.user.id, ctx.user.name, JSON.stringify({ label, body, privacy, terms })])
      .catch(() => undefined);

    return { ok: true, ready: true };
  });

  /* ----------------------------------------------------------------- keys */

  app.post('/api/web-form/key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    /* Rotating revokes the old key rather than editing it, so a shop whose old
       snippet is still on a page sees refused traffic instead of silence. */
    await mexec('UPDATE funnel_keys SET revoked_at = NOW() WHERE company_id = ? AND revoked_at IS NULL',
      [cid]);
    const key = await mintKey(cid, ctx.user.id);

    await texec(cid, `
      INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
      VALUES (?, ?, 'web_form', 0, 'key.rotated', ?)`,
      [ctx.user.id, ctx.user.name, JSON.stringify({ key })]).catch(() => undefined);

    return { ok: true, publicKey: key, snippet: snippetFor(key) };
  });

  /* -------------------------------------------------------------- domains */

  app.post('/api/web-form/domain', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    /* Whatever they paste — a whole URL, a scheme, a trailing slash — reduced
       to the host, because that is what a browser will send as the Origin. */
    const raw = String((req.body as { host?: string }).host ?? '').trim().toLowerCase();
    const host = raw
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .trim();

    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
      return reply.code(400).send({ error: 'That does not look like a website address.' });
    }

    await texec(ctx.company!.id,
      `INSERT INTO funnel_domains (host, added_by) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE host = host`, [host, ctx.user.id]);

    /* `www.` is not assumed anywhere, so a shop whose site answers on both has
       to name both — guessing which of somebody's subdomains are theirs is not
       ours to do. Said here rather than silently adding it. */
    const bare = host.replace(/^www\./, '');
    const sibling = host.startsWith('www.') ? bare : 'www.' + bare;
    const have = await tqOne<RowDataPacket>(ctx.company!.id,
      'SELECT host FROM funnel_domains WHERE host = ?', [sibling]);

    return { ok: true, host, suggest: have ? null : sibling };
  });

  app.delete('/api/web-form/domain/:host', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });
    await texec(ctx.company!.id, 'DELETE FROM funnel_domains WHERE host = ?',
      [String((req.params as { host: string }).host).toLowerCase()]);
    return { ok: true };
  });

  /* --------------------------------------------------------- public hours */

  app.put('/api/web-form/hours', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const rows = (req.body as { days?: Array<Record<string, unknown>> }).days ?? [];
    const cid = ctx.company!.id;

    await withTenantTx(cid, async (c) => {
      for (const r of rows) {
        const dow = Number(r.dow);
        if (!(dow >= 0 && dow <= 6)) continue;
        const time = (v: unknown): string | null => {
          const s = String(v ?? '').trim();
          return /^\d{2}:\d{2}(:\d{2})?$/.test(s) ? s.slice(0, 5) + ':00' : null;
        };
        await c.query(`
          INSERT INTO funnel_hours (dow, blocked, open_time, close_time)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE blocked = VALUES(blocked),
            open_time = VALUES(open_time), close_time = VALUES(close_time)`,
          [dow, r.blocked ? 1 : 0, time(r.open), time(r.close)]);
      }
    });

    return { ok: true };
  });

  app.post('/api/web-form/block', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const b = req.body as { date?: string; label?: string };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '')) {
      return reply.code(400).send({ error: 'Pick a date.' });
    }
    await texec(ctx.company!.id, `
      INSERT INTO funnel_blocks (on_date, label, created_by) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE label = VALUES(label)`,
      [b.date, String(b.label ?? '').slice(0, 80) || 'No public booking', ctx.user.id]);
    return { ok: true };
  });

  app.delete('/api/web-form/block/:date', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });
    await texec(ctx.company!.id, 'DELETE FROM funnel_blocks WHERE on_date = ?',
      [String((req.params as { date: string }).date)]);
    return { ok: true };
  });

  /* --------------------------------------------------------------- fields */

  app.put('/api/web-form/fields', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const list = (req.body as { fields?: Array<Record<string, unknown>> }).fields ?? [];

    for (const f of list) {
      const key = String(f.key ?? '').trim();
      if (!key) continue;

      /* Name, phone and email can never be removed. Enforced here rather than
         in the schema, because a NOT NULL cannot say "these three rows must
         exist and stay enabled". */
      const locked = (REQUIRED_FIELDS as readonly string[]).includes(key);
      const enabled = locked ? 1 : (f.enabled ? 1 : 0);

      await texec(cid, `
        UPDATE funnel_fields
           SET enabled = ?, label = ?, sort_order = ?, purpose = ?
         WHERE key_name = ?`,
        [enabled, String(f.label ?? '').slice(0, 120) || key,
         Number(f.sortOrder ?? 0),
         ['both', 'estimate', 'drop'].includes(String(f.purpose)) ? String(f.purpose) : 'both',
         key]);
    }

    return { ok: true };
  });

  app.post('/api/web-form/fields', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const b = req.body as Record<string, unknown>;
    const label = String(b.label ?? '').trim().slice(0, 120);
    if (!label) return reply.code(400).send({ error: 'Give the question a label.' });

    const kind = ['text', 'choice', 'yesno'].includes(String(b.kind)) ? String(b.kind) : 'text';
    const options = String(b.options ?? '').split('\n').map(s => s.trim()).filter(Boolean);
    if (kind === 'choice' && options.length < 2) {
      return reply.code(400).send({ error: 'A pick-one question needs at least two answers.' });
    }

    /* A stable key from the label, so an answer can be matched back to the
       question it belongs to after the label is reworded. */
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)
      || 'question';
    const cid = ctx.company!.id;
    let key = base, n = 1;
    while (await tqOne<RowDataPacket>(cid, 'SELECT id FROM funnel_fields WHERE key_name = ?', [key])) {
      key = `${base}_${++n}`;
    }

    const [max] = await tq<RowDataPacket[]>(cid, 'SELECT COALESCE(MAX(sort_order),0) + 10 AS n FROM funnel_fields');

    await texec(cid, `
      INSERT INTO funnel_fields (key_name, label, kind, options, purpose, enabled, required, sort_order)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
      [key, label, kind, options.length ? options.join('\n') : null,
       ['both', 'estimate', 'drop'].includes(String(b.purpose)) ? String(b.purpose) : 'both',
       Number(max?.n ?? 100)]);

    return { ok: true, key };
  });

  app.delete('/api/web-form/fields/:key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const key = String((req.params as { key: string }).key);
    if ((REQUIRED_FIELDS as readonly string[]).includes(key)) {
      return reply.code(400).send({
        error: 'Name, phone and email have to stay — without them a submission is not a lead.'
      });
    }
    await texec(ctx.company!.id, `DELETE FROM funnel_fields WHERE key_name = ? AND kind <> 'builtin'`, [key]);
    /* A built-in is switched off, not deleted: the shop may want it back and
       the answers already on old requests still refer to it. */
    await texec(ctx.company!.id, `UPDATE funnel_fields SET enabled = 0 WHERE key_name = ?`, [key]);
    return { ok: true };
  });

  /* -------------------------------------------------------------- letters */

  app.put('/api/web-form/letter/:key', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageWebForms) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const key = String((req.params as { key: string }).key);
    const b = req.body as Record<string, unknown>;
    const subject = String(b.subject ?? '').slice(0, 190);
    const body = String(b.body ?? '').slice(0, 4000);

    if (!subject || !body) return reply.code(400).send({ error: 'A subject and a message.' });

    /**
     * A token for a field the form is not collecting is refused HERE, at the
     * moment somebody is writing, rather than discovered by a customer reading
     * "drop off your  ." That is the real fix; `renderLetter` dropping the
     * sentence is the safety net for a field switched off afterwards.
     */
    const fields = await funnelFields(cid);
    const on = new Set(fields.filter(f => f.enabled).map(f => f.key));
    const bad: string[] = [];

    for (const m of `${subject} ${body}`.matchAll(/\[\s*([^\]]+?)\s*\]/g)) {
      const name = m[1].trim().toLowerCase();
      const def = LETTER_TOKENS.find(t => t.token === name);
      if (!def) { bad.push(`[ ${m[1]} ] is not a token we fill in.`); continue; }
      if (def.needs && !on.has(def.needs)) {
        bad.push(`[ ${m[1]} ] needs the "${def.needs}" field, which this form is not asking for.`);
      }
    }
    if (bad.length) return reply.code(400).send({ error: bad.join(' '), tokens: true });

    await texec(cid, `
      INSERT INTO funnel_emails (event_key, subject, body, enabled) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body), enabled = VALUES(enabled)`,
      [key, subject, body, b.enabled === false ? 0 : 1]);

    /* What it will actually look like, filled in with a worked example. */
    const sample: LetterTokens = {
      firstName: 'Marisol', lastName: 'Vega',
      appointmentDate: prettyDate(new Date(Date.now() + 86400000).toISOString().slice(0, 10)),
      appointmentTime: '9:00 AM',
      vehicleYear: '2021', vehicleMake: 'Chevrolet', vehicleModel: 'Silverado',
      shopName: ctx.company!.name, shopAddress: '1420 Avenue K, Plano', shopPhone: '(972) 555-0100'
    };

    return { ok: true, preview: renderLetter(body, sample) };
  });

  /* ------------------------------------------------------------- the queue */

  /**
   * Everything a stranger asked for and nobody has answered.
   *
   * Lives as a tab on Leads rather than its own screen: a request is a lead
   * that arrived with a time attached, and putting it anywhere else would give
   * the shop two inboxes.
   */
  app.get('/api/web-requests', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.viewLeads) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const tab = String((req.query as { tab?: string }).tab ?? 'waiting');

    const where = tab === 'lapsed' ? `fr.state IN ('lapsed','declined')`
      : tab === 'all' ? '1 = 1'
      : `fr.state IN ('held','booked') AND fr.answered_at IS NULL`;

    const rows = await tq<RowDataPacket[]>(cid, `
      SELECT fr.*, l.lead_number, r.ro_number,
             TIMESTAMPDIFF(MINUTE, NOW(), fr.hold_until) AS hold_minutes
        FROM funnel_requests fr
        LEFT JOIN leads l ON l.id = fr.lead_id
        LEFT JOIN repair_orders r ON r.id = fr.ro_id
       WHERE ${where}
       ORDER BY fr.state = 'held' DESC, fr.hold_until IS NULL, fr.hold_until, fr.created_at DESC
       LIMIT 200`);

    const [waiting] = await tq<RowDataPacket[]>(cid, `
      SELECT COUNT(*) AS n FROM funnel_requests
       WHERE state IN ('held','booked') AND answered_at IS NULL`);

    const [expiring] = await tq<RowDataPacket[]>(cid, `
      SELECT COUNT(*) AS n FROM funnel_requests
       WHERE state = 'held' AND hold_until IS NOT NULL
         AND hold_until < DATE_ADD(NOW(), INTERVAL 4 HOUR)`);

    return {
      tab,
      waiting: Number(waiting?.n ?? 0),
      expiring: Number(expiring?.n ?? 0),
      canAnswer: ctx.caps.manageLeads,
      requests: rows.map(r => ({
        ...r,
        answers: r.answers ? safeJson(String(r.answers)) : []
      }))
    };
  });

  /**
   * Confirm, move or decline.
   *
   * Confirming does not re-book anything: the appointment has existed since the
   * submission, which is what made the hold real. It lifts the provisional
   * note, stamps who answered, and tells the customer.
   */
  app.post('/api/web-requests/:id/:action', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const cid = ctx.company!.id;
    const id = Number((req.params as { id: string }).id);
    const action = String((req.params as { action: string }).action);

    const r = await tqOne<RowDataPacket>(cid, 'SELECT * FROM funnel_requests WHERE id = ?', [id]);
    if (!r) return reply.code(404).send({ error: 'That request is gone.' });
    if (r.answered_at) return reply.code(409).send({ error: 'Somebody has already answered that one.' });

    const stamp = ['answered_at = NOW()', 'answered_by = ?', 'answered_name = ?'];
    const stampVals: unknown[] = [ctx.user.id, ctx.user.name];

    if (action === 'confirm') {
      await texec(cid, `UPDATE funnel_requests SET state = 'confirmed', hold_until = NULL,
        conflicted_at = NULL, ${stamp.join(', ')} WHERE id = ?`, [...stampVals, id]);

      if (r.appointment_id) {
        await texec(cid, `UPDATE appointments SET note = ? WHERE id = ?`,
          ['Booked from the website · confirmed by ' + ctx.user.name, r.appointment_id]);
        pushAppointment(cid, Number(r.appointment_id), 'save').catch(() => {});
      }
      if (r.lead_id) {
        await texec(cid, `UPDATE leads SET state = 'appraisal_booked' WHERE id = ? AND state = 'new'`,
          [r.lead_id]);
        await logLead(cid, Number(r.lead_id), ctx.user.id, ctx.user.name,
          'Drop-off confirmed. The slot is theirs.');
      }

      /* The second letter. Only for a drop-off — an estimate was confirmed the
         moment it was booked and a second email saying so is noise. */
      if (r.purpose === 'drop' && !Number(r.suppressed) && r.email) {
        const settings = await funnelSettings(cid);
        void sendCustomerLetter(cid, {
          eventKey: 'drop_confirmed', to: String(r.email), name: String(r.customer_name),
          vehicle: String(r.vehicle_text ?? ''),
          date: isoDay(r.starts_at as Date), time: wallTime(r.starts_at as Date),
          shopName: ctx.company!.name, replyTo: settings.replyTo
        }).catch(() => undefined);
      }

      await clearMark(cid, r);
      return { ok: true, state: 'confirmed' };
    }

    if (action === 'decline') {
      await texec(cid, `UPDATE funnel_requests SET state = 'declined', hold_until = NULL,
        ${stamp.join(', ')} WHERE id = ?`, [...stampVals, id]);

      /* Releasing the slot is the whole point of declining: the appointment is
         cancelled so the hour goes back on the board. The LEAD stays, because
         "we could not take that morning" is not "we do not want the work". */
      if (r.appointment_id) {
        await texec(cid, 'UPDATE appointments SET cancelled_at = NOW() WHERE id = ?', [r.appointment_id]);
        pushAppointment(cid, Number(r.appointment_id), 'cancel').catch(() => {});
      }
      if (r.lead_id) {
        await logLead(cid, Number(r.lead_id), ctx.user.id, ctx.user.name,
          `Website request for ${isoDay(r.starts_at as Date)} declined and the slot released. ` +
          `The lead is still open — somebody has to ring them.`);
        await texec(cid, `UPDATE leads SET state = 'new' WHERE id = ? AND state = 'appraisal_booked'`,
          [r.lead_id]);
      }

      await clearMark(cid, r);
      /* Deliberately no email. A decline is a phone call from the shop — see
         QUEUE.md; the customer was never promised one for this. */
      return { ok: true, state: 'declined', tellThem: true };
    }

    if (action === 'note') {
      /* Answering the mark without confirming or declining: the common case
         where the submission was a question about a car already in the bay. */
      await texec(cid, `UPDATE funnel_requests SET ${stamp.join(', ')} WHERE id = ?`,
        [...stampVals, id]);
      await clearMark(cid, r);
      return { ok: true, state: String(r.state) };
    }

    return reply.code(400).send({ error: 'Unknown action.' });
  });

  /** The times the desk could move it to — the shop's, not the public's. */
  app.get('/api/web-requests/:id/times', async (req, reply) => {
    const ctx = requireCompany(req, reply);
    if (!ctx) return;
    if (!ctx.caps.manageLeads) return reply.code(403).send({ error: 'Not permitted' });

    const r = await tqOne<RowDataPacket>(ctx.company!.id,
      'SELECT purpose FROM funnel_requests WHERE id = ?',
      [Number((req.params as { id: string }).id)]);
    if (!r) return reply.code(404).send({ error: 'That request is gone.' });

    return {
      days: await publicSlots(ctx.company!.id, ctx.company!.timezone,
        r.purpose === 'drop' ? 'drop' : 'estimate', 14)
    };
  });
}

/* --------------------------------------------------------------- helpers */

async function mintKey(companyId: number, userId: number): Promise<string> {
  const key = newPublicKey();
  await mexec('INSERT INTO funnel_keys (public_key, company_id, created_by) VALUES (?, ?, ?)',
    [key, companyId, userId]);
  return key;
}

/**
 * What the shop's web person pastes.
 *
 * Written to survive the two platforms a shop's site is actually on —
 * WordPress and HighLevel — without being wired for either: the script is
 * async and finds its own target, so a page builder that moves it, runs it
 * before the div exists, or includes it twice still ends up with one form.
 */
function snippetFor(key: string): string {
  return `<div id="easyshop-form" data-campaign="website"></div>\n` +
    `<script src="${config.appUrl}/f.js" data-key="${key}" ` +
    `data-target="#easyshop-form" async></` + `script>`;
}

/**
 * The red mark on a file clears by ANSWERING the request, with no clock. A
 * mention escalates at 24 and 48 hours because it waits on one named person;
 * this waits on whoever picks the queue up, and nagging a shop about its own
 * queue twice a day is how a queue gets ignored.
 */
async function clearMark(companyId: number, r: RowDataPacket): Promise<void> {
  if (!r.ro_id) return;
  await texec(companyId, 'UPDATE repair_orders SET web_request_id = NULL WHERE id = ? AND web_request_id = ?',
    [r.ro_id, r.id]).catch(() => undefined);
}

async function logLead(
  companyId: number, leadId: number, userId: number, userName: string, body: string
): Promise<void> {
  await texec(companyId,
    `INSERT INTO lead_events (lead_id, kind, body, user_id, user_name) VALUES (?, 'auto', ?, ?, ?)`,
    [leadId, body.slice(0, 500), userId, userName]).catch(() => undefined);
}

function safeJson(s: string): Array<{ label: string; value: string }> {
  try { return JSON.parse(s); } catch { return []; }
}

function isoDay(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function wallTime(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(11, 16) : String(d).slice(11, 16);
}
