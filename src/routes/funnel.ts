import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { mq, mqOne } from '../db/master';
import { tqOne, texec, withTenantTx } from '../db/tenant';
import { scheduleGuards } from './scheduler';
import { notify } from '../notify';
import { sendMail, letter } from '../lib/mail';
import { isSuppressed, noteSuppressionHit, unsubscribeUrl } from '../lib/suppression';
import {
  funnelFields, funnelLetter, funnelSettings, hostOf, originAllowed,
  publicSlots, renderLetter, resolveKey, touchKey, LetterTokens
} from '../lib/funnel';
import { consentText, recordConsent } from '../lib/consent';

/**
 * The public half of web funnels: the form on the shop's own website.
 *
 * Unauthenticated by necessity — the person filling it in is a stranger with
 * no account and never will have one. Three things stand in for a session:
 *
 *   1. **The public key** says which shop. It is readable by anyone who views
 *      the page, so it authorises nothing on its own.
 *   2. **The domain allowlist** says whether this page may speak for that shop.
 *      That is the actual gate, and it is why a scraped key is worthless.
 *   3. **A honeypot and a per-IP limit** keep the volume honest.
 *
 * Nothing in the responses describes any of that. A line telling the customer
 * there is a hidden field a robot fills in tells the robot too — so the
 * honeypot is never named in the markup, the copy, or an error message.
 *
 * Held to WCAG 2.1 AA, for the same reason `checkin.html` is: it is a public
 * page a shop's customers fill in, so it is a Title III surface. The desk
 * screens behind it are not.
 */

const CORS_MAX_AGE = '600';

/** Per-IP, on top of the app-wide limiter — this one endpoint writes real work. */
const submitBuckets = new Map<string, { n: number; resetAt: number }>();
const SUBMIT_MAX = 5;
const SUBMIT_WINDOW = 10 * 60 * 1000;

function submitAllowed(ip: string): boolean {
  const now = Date.now();
  const b = submitBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    submitBuckets.set(ip, { n: 1, resetAt: now + SUBMIT_WINDOW });
    return true;
  }
  b.n += 1;
  return b.n <= SUBMIT_MAX;
}

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of submitBuckets) if (b.resetAt <= now) submitBuckets.delete(k);
}, 5 * 60 * 1000);
sweep.unref();

/**
 * Resolve key and origin together, because neither is worth anything alone.
 *
 * Every failure answers the same way — a flat 403 with one sentence. A form
 * that says "unknown key" and "domain not allowed" separately is a form that
 * tells somebody probing it which half to keep working on.
 */
async function gate(
  req: FastifyRequest, reply: FastifyReply
): Promise<{ companyId: number; publicKey: string; origin: string } | null> {
  const key = String((req.query as { k?: string }).k ?? (req.body as { k?: string })?.k ?? '');
  const origin = String(req.headers.origin ?? '');

  const resolved = await resolveKey(key);
  if (!resolved) { void refuse(reply); return null; }

  if (!(await originAllowed(resolved.companyId, origin))) {
    req.log.warn({ key, origin }, 'web funnel: origin not on the allowlist');
    void refuse(reply);
    return null;
  }

  allowOrigin(reply, origin);
  void touchKey(key);
  return { companyId: resolved.companyId, publicKey: key, origin };
}

function refuse(reply: FastifyReply): void {
  /* No allow-origin header on a refusal: the browser is meant to be unable to
     read this, and saying nothing is the honest answer to a page that has no
     business asking. */
  void reply.code(403).send({ error: 'This form is not set up for this website.' });
}

function allowOrigin(reply: FastifyReply, origin: string): void {
  /* Echoed, never '*': the answer is specific to one allowlisted page and a
     wildcard would let any site read a shop's availability. */
  reply.header('access-control-allow-origin', origin);
  reply.header('vary', 'Origin');
  reply.header('cache-control', 'no-store');
  /* The snippet sends no cookies and must not: this is a stranger's browser on
     somebody else's website, and a credentialed cross-origin request here
     would be a way to make a signed-in employee's session do something. */
  reply.header('access-control-allow-credentials', 'false');
}

export async function registerFunnelPublic(app: FastifyInstance): Promise<void> {

  /* Preflight. The snippet POSTs JSON, which is never a simple request. */
  app.options('/api/f/*', async (req, reply) => {
    const origin = String(req.headers.origin ?? '');
    const key = String((req.query as { k?: string }).k ?? '');
    const resolved = key ? await resolveKey(key) : null;

    if (resolved && await originAllowed(resolved.companyId, origin)) {
      allowOrigin(reply, origin);
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      reply.header('access-control-allow-headers', 'content-type');
      reply.header('access-control-max-age', CORS_MAX_AGE);
    }
    return reply.code(204).send();
  });

  /**
   * What the form draws itself from: which purposes are offered, which fields
   * to show, and the shop's colours.
   */
  app.get('/api/f/config', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return;

    const [settings, fields, shop] = await Promise.all([
      funnelSettings(g.companyId),
      funnelFields(g.companyId),
      mqOne<RowDataPacket>('SELECT name FROM companies WHERE id = ?', [g.companyId])
    ]);

    if (!settings.enabled) {
      return reply.code(404).send({ error: 'This form is not switched on yet.' });
    }
    if (!settings.offerEstimate && !settings.offerDrop) {
      return reply.code(404).send({ error: 'This form is not taking bookings right now.' });
    }

    /**
     * The consent block. Sent to the browser so the CHECKBOX shows the shop's
     * own words — and so the exact text on screen is the text we can record
     * afterwards. The form refuses to run without it, which is enforced when
     * the owner switches the form on.
     */
    const consent = await consentText(g.companyId);

    return {
      shop: shop?.name ? String(shop.name) : '',
      intro: settings.intro,
      accent: settings.accent,
      accentInk: settings.accentInk,
      holdHours: settings.holdHours,
      consent: consent && consent.body ? {
        label: consent.label,
        body: consent.body,
        privacyUrl: consent.privacyUrl,
        termsUrl: consent.termsUrl,
        /* Never required. TCPA does not let consent to marketing be a
           condition of the sale, and the shop's own disclosure says so — a
           required box would make that sentence a lie on their own website. */
        required: false
      } : null,
      purposes: [
        settings.offerEstimate
          ? { key: 'estimate', label: 'An estimate', sub: 'Bring it by, we look at it' } : null,
        settings.offerDrop
          ? { key: 'drop', label: 'Drop it off', sub: 'Leave it with us to start' } : null
      ].filter(Boolean),
      fields: fields.filter(f => f.enabled).map(f => ({
        key: f.key, label: f.label, kind: f.kind,
        options: f.options, purpose: f.purpose, required: f.required
      }))
    };
  });

  /** The days and hours a stranger may actually be offered. */
  app.get('/api/f/slots', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return;

    const q = req.query as { purpose?: string; days?: string };
    const purpose = q.purpose === 'drop' ? 'drop' : 'estimate';
    const days = Math.min(Math.max(Number(q.days ?? 14), 1), 30);

    const [settings, company] = await Promise.all([
      funnelSettings(g.companyId),
      mqOne<RowDataPacket & { timezone: string }>(
        'SELECT timezone FROM companies WHERE id = ?', [g.companyId])
    ]);

    if (!settings.enabled) return reply.code(404).send({ error: 'This form is not switched on yet.' });
    if (purpose === 'estimate' && !settings.offerEstimate) return { purpose, days: [] };
    if (purpose === 'drop' && !settings.offerDrop) return { purpose, days: [] };

    const list = await publicSlots(
      g.companyId, String(company?.timezone ?? 'America/Chicago'), purpose, days);

    /**
     * A day with nothing on it is not shown at all.
     *
     * The first version drew it greyed with "closed" or "full" under it, which
     * reads to a customer as a shop that is mostly shut — six tiles, two of
     * them usable. The desk still needs to know WHY a day is empty, so
     * `publicSlots` keeps returning the reason and the move-times list in the
     * queue still shows it; this is the public view only.
     */
    const open = list.filter(d => d.slots.length);

    return {
      purpose,
      requested: purpose === 'drop',
      holdHours: settings.holdHours,
      days: open,
      /* So the form can say something true when there is nothing at all,
         rather than drawing an empty row. */
      none: open.length === 0
    };
  });

  /**
   * The submission.
   *
   * An estimate is booked outright — the time is theirs. A drop-off is
   * requested, and the slot is HELD: it takes an appointment row immediately,
   * so it counts against the day's limit the same as anything else. Without
   * that, two people hold the same Tuesday morning and a person has to tell one
   * of them no.
   */
  app.post('/api/f/submit', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return;

    const b = (req.body ?? {}) as Record<string, unknown>;
    const clean = (v: unknown, max = 200): string =>
      String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

    /* Answered with a cheerful 200. Telling a bot it was spotted only teaches
       whoever wrote it. */
    if (clean(b.company_website)) return { ok: true, state: 'booked' };

    if (!submitAllowed(req.ip)) {
      reply.header('retry-after', '60');
      return reply.code(429).send({ error: 'Try again in a minute.' });
    }

    const [settings, company, fields] = await Promise.all([
      funnelSettings(g.companyId),
      mqOne<RowDataPacket & { name: string; timezone: string }>(
        'SELECT name, timezone FROM companies WHERE id = ?', [g.companyId]),
      funnelFields(g.companyId)
    ]);
    if (!settings.enabled) return reply.code(404).send({ error: 'This form is not switched on yet.' });

    const tz = String(company?.timezone ?? 'America/Chicago');
    const purpose = b.purpose === 'drop' ? 'drop' : 'estimate';
    if (purpose === 'estimate' && !settings.offerEstimate) {
      return reply.code(400).send({ error: 'Estimates are not bookable here.' });
    }
    if (purpose === 'drop' && !settings.offerDrop) {
      return reply.code(400).send({ error: 'Drop-offs are not bookable here.' });
    }

    const name = clean(b.name, 160);
    const phone = clean(b.phone, 32);
    const email = clean(b.email, 190).toLowerCase();
    const date = clean(b.date, 10);
    const time = clean(b.time, 5);

    if (!name) return reply.code(400).send({ error: 'We need your name.', field: 'name' });
    if (!phone) return reply.code(400).send({ error: 'We need a phone number.', field: 'phone' });
    if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: 'That email address does not look right.', field: 'email' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return reply.code(400).send({ error: 'Pick a day and a time.', field: 'time' });
    }

    /**
     * The slot is checked against what we would OFFER, not just against what
     * the scheduler would allow. The two are different on purpose: the public
     * window is narrower than the shop's, and a posted time that is legal for
     * the desk but outside the public window has come from somebody editing
     * the request rather than from the form.
     */
    const offered = await publicSlots(g.companyId, tz, purpose, 30);
    const day = offered.find(d => d.date === date);
    if (!day || !day.slots.includes(time)) {
      return reply.code(409).send({
        error: 'That time has just gone. Pick another and we will hold it.',
        field: 'time', taken: true
      });
    }

    const when = `${date} ${time}:00`;

    /* The same gate a desk booking passes. No override: a stranger on a website
       is not somebody the shop decided to make an exception for. */
    const guard = await scheduleGuards({
      cid: g.companyId, tz, kind: purpose === 'drop' ? 'drop' : 'estimate',
      when, durationMin: 30, assignedUserId: null, ignoreApptId: null,
      isOwner: false, override: false
    });
    if ('refuse' in guard) {
      return reply.code(409).send({
        error: 'That time has just gone. Pick another and we will hold it.',
        field: 'time', taken: true
      });
    }

    /* The rest of the form. Custom questions are whatever the shop added; they
       become their own rows on the lead and are copied onto the file as a note
       when it converts. */
    const vehicle = clean(b.vehicle, 160);
    const carrier = clean(b.carrier, 120);
    const claim = clean(b.claim, 64);
    const what = clean(b.what, 600);
    const contact = clean(b.contact, 40);
    const campaign = clean(b.campaign, 60) || null;
    const pageUrl = clean(b.pageUrl, 400) || null;

    const answers: Array<{ label: string; value: string }> = [];
    const custom = (b.answers ?? {}) as Record<string, unknown>;
    for (const f of fields) {
      if (f.kind === 'builtin' || !f.enabled) continue;
      if (f.purpose !== 'both' && f.purpose !== purpose) continue;
      const v = clean(custom[f.key], 300);
      if (v) answers.push({ label: f.label, value: v });
    }

    /**
     * Who they turn out to be. Three questions, in this order, and each one
     * changes what happens rather than just decorating the row.
     */
    const digits = phone.replace(/\D/g, '');

    /* 1. A returning customer — matched on phone, and only where they have a
          PAST FILE. A client row alone is not enough: an address typed into
          Clients once is not evidence this is the same person coming back. */
    const known = digits.length >= 7 ? await tqOne<RowDataPacket & { id: number; name: string }>(
      g.companyId, `
      SELECT c.id, c.name FROM clients c
       WHERE REPLACE(REPLACE(REPLACE(c.phone,'-',''),' ',''),'.','') LIKE ?
         AND EXISTS (SELECT 1 FROM repair_orders r WHERE r.client_id = c.id AND r.voided_at IS NULL)
       ORDER BY c.id LIMIT 1`, [`%${digits}%`]).catch(() => null) : null;

    /* 2. Their car is in the bay right now. Usually a question, not new work. */
    const openFile = digits.length >= 7 ? await tqOne<RowDataPacket & { id: number; ro_number: string }>(
      g.companyId, `
      SELECT r.id, r.ro_number FROM repair_orders r
        JOIN clients c ON c.id = r.client_id
       WHERE r.voided_at IS NULL AND r.closed_at IS NULL
         AND REPLACE(REPLACE(REPLACE(c.phone,'-',''),' ',''),'.','') LIKE ?
       ORDER BY r.id DESC LIMIT 1`, [`%${digits}%`]).catch(() => null) : null;

    /* 3. A repeat inside the week. Its own lead, flagged — somebody asking
          twice is a thing the shop should see, not something to tidy away. */
    const repeat = digits.length >= 7 ? await tqOne<RowDataPacket>(g.companyId, `
      SELECT id FROM funnel_requests
       WHERE phone IS NOT NULL
         AND REPLACE(REPLACE(REPLACE(phone,'-',''),' ',''),'.','') LIKE ?
         AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
       LIMIT 1`, [`%${digits}%`]).catch(() => null) : null;

    /* The address may have unsubscribed. It is CARRIED, not refused — this is
       the customer's own hand on the keyboard and the same call check-in makes.
       What follows is that they get no confirmation, so the form says "we will
       call" instead of promising an email it cannot send. It never says why:
       that is not the customer's business on a public page. */
    const suppressed = await isSuppressed('email', email, g.companyId);
    if (suppressed) {
      await noteSuppressionHit(g.companyId, 'email', email, 'typed on the website form');
    }

    const holdHours = settings.holdHours;
    const state = purpose === 'drop' ? 'held' : 'booked';

    /**
     * Consent, as it stood on the screen they were looking at.
     *
     * The wording is read from the database rather than taken from the browser
     * — a client that posts its own disclosure text could claim the customer
     * agreed to anything. What the browser is trusted for is the one thing only
     * it knows: whether the box was ticked.
     */
    const consent = await consentText(g.companyId);
    const smsConsent = b.smsConsent === true;

    const written = await withTenantTx(g.companyId, async (c) => {
      const [appt] = await c.query<ResultSetHeader>(`
        INSERT INTO appointments
          (kind, starts_at, duration_min, customer_name, vehicle_text, phone, note, created_by)
        VALUES (?, ?, 30, ?, ?, ?, ?, NULL)`,
        [purpose === 'drop' ? 'drop' : 'estimate', when, name, vehicle || null, phone || null,
         /* Provisional until somebody confirms it. Said on the card, because a
            service writer looking at Thursday needs to know which of these is
            a promise and which is a request. */
         purpose === 'drop' ? 'Requested from the website — not confirmed yet' : 'Booked from the website']);
      const apptId = appt.insertId;

      let leadId: number | null = null;

      /* A returning customer skips the lead: there is nothing to qualify and a
         leads row for somebody already in Clients is noise. The request still
         lands in the queue like everyone else's, because nothing else would
         put it in front of a person. */
      if (!known) {
        const [seq] = await c.query<RowDataPacket[]>(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(lead_number, 2) AS UNSIGNED)), 0) + 1 AS n FROM leads`);
        const num = 'L' + String(Number(seq[0].n ?? 1)).padStart(5, '0');
        const parts = name.split(/\s+/);

        const [l] = await c.query<ResultSetHeader>(`
          INSERT INTO leads
            (lead_number, source, state, first_name, last_name, phone, email,
             vehicle_text, damage_note, appointment_id, campaign, source_url)
          VALUES (?, 'web_form', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [num, purpose === 'estimate' ? 'appraisal_booked' : 'new',
           parts.length > 1 ? parts[0] : null, parts[parts.length - 1],
           phone || null, email || null, vehicle || null, what || null,
           apptId, campaign, pageUrl]);
        leadId = l.insertId;

        await c.query(
          `INSERT INTO lead_events (lead_id, kind, body, user_name) VALUES (?, 'auto', ?, 'the website form')`,
          [leadId, purpose === 'estimate'
            ? `Estimate booked from the website for ${date} at ${time}.`
            : `Drop-off requested from the website for ${date} at ${time}. ` +
              `Slot held for ${holdHours} hours.`]);

        if (carrier || claim) {
          await c.query(
            `INSERT INTO lead_events (lead_id, kind, body, user_name) VALUES (?, 'auto', ?, 'the website form')`,
            [leadId, [carrier ? `Insurance: ${carrier}` : null,
                      claim ? `Claim ${claim}` : null].filter(Boolean).join(' · ')]);
        }

        for (const a of answers) {
          await c.query(
            `INSERT INTO lead_events (lead_id, kind, body, user_name) VALUES (?, 'note', ?, 'the website form')`,
            [leadId, `${a.label}: ${a.value}`.slice(0, 500)]);
        }

        if (repeat) {
          await c.query(
            `INSERT INTO lead_events (lead_id, kind, body, user_name) VALUES (?, 'auto', ?, 'the website form')`,
            [leadId, 'A second request from this number inside a week. Kept as its own lead rather ' +
                     'than merged, so the shop can see somebody asked twice.']);
        }

        await c.query('UPDATE appointments SET lead_id = ? WHERE id = ?', [leadId, apptId]);
      }

      const [r] = await c.query<ResultSetHeader>(`
        INSERT INTO funnel_requests
          (purpose, state, starts_at, hold_until, appointment_id, lead_id, client_id, ro_id,
           customer_name, phone, email, contact_pref, vehicle_text, carrier, claim_number,
           what_happened, answers, campaign, page_url, origin_host, submit_ip,
           is_repeat, suppressed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [purpose, state, when,
         purpose === 'drop' ? new Date(Date.now() + holdHours * 3600_000) : null,
         apptId, leadId, known?.id ?? null, openFile?.id ?? null,
         name, phone || null, email || null, contact || null, vehicle || null,
         carrier || null, claim || null, what || null,
         answers.length ? JSON.stringify(answers) : null,
         campaign, pageUrl, hostOf(g.origin), req.ip,
         repeat ? 1 : 0, suppressed ? 1 : 0]);
      const requestId = r.insertId;

      /* Their car is already in the bay. The red mark a mention gets, and a
         note on the file — but it clears by ANSWERING it in the queue, with no
         clock. A mention escalates because it waits on one named person; this
         waits on whoever picks the queue up. */
      if (openFile) {
        await c.query('UPDATE repair_orders SET web_request_id = ? WHERE id = ?',
          [requestId, openFile.id]);
        await c.query(
          `INSERT INTO ro_notes (ro_id, kind, body, user_name) VALUES (?, 'auto', ?, 'the website form')`,
          [openFile.id,
           `${name} submitted the website form while this car is here — ` +
           `${purpose === 'drop' ? 'asking to drop off' : 'asking for an estimate'} ` +
           `on ${date} at ${time}. Usually a question rather than new work.`]);
      }

      /**
       * Two consent records, and they are not the same thing.
       *
       * The MARKETING one is whatever they ticked — including a decline, which
       * is written down deliberately: "we asked and they said no" is a
       * different fact from "nobody ever asked", and only one of them means
       * somebody should ring instead of text.
       *
       * The TRANSACTIONAL one is implied by the act of booking and is scoped
       * to this appointment, expiring when the car is delivered. Recorded
       * rather than assumed, so "why did we text this person" has an answer.
       */
      const consentId = await recordConsent(g.companyId, {
        kind: 'marketing', channel: 'sms', destination: phone,
        granted: smsConsent,
        source: 'web_form',
        wordingShown: consent?.body ?? null,
        boxesTicked: smsConsent ? 'sms_marketing' : '',
        pageUrl: pageUrl,
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? ''),
        submission: {
          name: name, phone: phone, email: email, vehicle: vehicle,
          purpose: purpose, date: date, time: time,
          carrier: carrier, claim: claim, what: what, contact: contact,
          answers: answers, campaign: campaign
        },
        funnelRequestId: requestId,
        appointmentId: apptId
      }, c);

      await recordConsent(g.companyId, {
        kind: 'transactional', channel: 'sms', destination: phone,
        granted: true, source: 'web_form',
        wordingShown: 'Implied by booking an appointment on the website. ' +
          'Covers messages about this appointment and this repair only, and lapses ' +
          'when the vehicle is delivered.',
        pageUrl: pageUrl, ip: req.ip,
        funnelRequestId: requestId, appointmentId: apptId
      }, c);

      await c.query('UPDATE funnel_requests SET sms_consent = ?, consent_id = ? WHERE id = ?',
        [smsConsent ? 1 : 0, consentId, requestId]);

      if (known) {
        /* No lead, so the trail goes on the request row and the appointment.
           There is deliberately no client-notes table to write to — a client
           record is who somebody is, not a running log. */
        await c.query('UPDATE appointments SET note = ? WHERE id = ?',
          [(purpose === 'drop'
            ? 'Requested from the website — not confirmed yet'
            : 'Booked from the website') + ' · returning customer', apptId]);
      }

      return { requestId, apptId, leadId };
    });

    /* ------------------------------------------------------------ telling people */

    const who = openFile
      ? `${name} — car already in the shop (RO ${openFile.ro_number})`
      : known ? `${name} — a returning customer` : name;

    void notify({
      companyId: g.companyId,
      event: 'web.request',
      leadId: written.leadId,
      roId: openFile?.id ?? null,
      title: purpose === 'drop'
        ? `Drop-off requested from the website — ${name}`
        : `Estimate booked from the website — ${name}`,
      body: `${who}. ${vehicle || 'Vehicle not given'} · ${date} at ${time}` +
        (purpose === 'drop' ? ` · held for ${holdHours} hours` : ''),
      directUserIds: await deskRecipients(g.companyId),
      dedupeKey: `web-request-${written.requestId}`
    }).catch(() => undefined);

    /* ------------------------------------------------------------ the letter */

    let emailed = false;
    if (!suppressed) {
      emailed = await sendCustomerLetter(g.companyId, {
        eventKey: purpose === 'estimate' ? 'estimate_booked' : 'drop_requested',
        to: email, name, vehicle, date, time,
        shopName: String(company?.name ?? ''), replyTo: settings.replyTo
      });
    }

    return {
      ok: true,
      state,
      /* What the form tells them. A suppressed address is never told why — it
         is simply given the version of the sentence that promises a call. */
      emailed,
      holdHours: purpose === 'drop' ? holdHours : null,
      when: { date, time }
    };
  });
}

/* --------------------------------------------------------------- helpers */

/**
 * Who hears about one arriving: the owner and the front office.
 *
 * Resolved from the master database because roles live there. There is
 * deliberately no third recipient — the answer said "whoever the lead is
 * assigned to", and a lead the website raised is assigned to nobody until
 * somebody picks it up. Inventing a rota to fill that gap would be a decision
 * nobody made.
 */
export async function deskRecipients(companyId: number): Promise<number[]> {
  const rows = await mq<RowDataPacket[]>(`
    SELECT DISTINCT m.user_id
      FROM memberships m
      LEFT JOIN membership_roles mr ON mr.user_id = m.user_id AND mr.company_id = m.company_id
     WHERE m.company_id = ? AND m.status = 'active'
       AND (mr.role_key IN ('owner','front_office') OR m.role IN ('owner','front_office'))`,
    [companyId]).catch(() => [] as RowDataPacket[]);
  return rows.map(r => Number(r.user_id)).filter(Boolean);
}

/**
 * One of the shop's own letters, filled in and sent.
 *
 * The wording belongs to the shop; this only supplies the values and the
 * envelope. The From line is "Their Shop via Easy Shop" on our verified domain
 * — the shop's name can only ever be the display name, because the address has
 * to be one Resend has signed for.
 */
export async function sendCustomerLetter(companyId: number, o: {
  eventKey: string; to: string; name: string; vehicle: string;
  date: string; time: string; shopName: string; replyTo: string | null;
}): Promise<boolean> {
  const tpl = await funnelLetter(companyId, o.eventKey);
  if (!tpl) return false;

  const shop = await mqOne<RowDataPacket>(
    'SELECT name FROM companies WHERE id = ?', [companyId]).catch(() => null);
  const addr = await tqOne<RowDataPacket>(companyId,
    `SELECT setting_value FROM shop_settings WHERE setting_key = 'shop_address'`).catch(() => null);
  const tel = await tqOne<RowDataPacket>(companyId,
    `SELECT setting_value FROM shop_settings WHERE setting_key = 'shop_phone'`).catch(() => null);

  const parts = o.name.trim().split(/\s+/);
  const vparts = o.vehicle.trim().split(/\s+/);

  const tokens: LetterTokens = {
    firstName: parts.length > 1 ? parts[0] : o.name,
    lastName: parts.length > 1 ? parts[parts.length - 1] : '',
    appointmentDate: prettyDate(o.date),
    appointmentTime: prettyTime(o.time),
    /* Best effort from one free-text box. Empty is honest, and an empty token
       drops its whole sentence rather than printing a gap. */
    vehicleYear: /^(19|20)\d{2}$/.test(vparts[0] ?? '') ? vparts[0] : '',
    vehicleMake: vparts.length > 1 ? vparts[1] : '',
    vehicleModel: vparts.length > 2 ? vparts.slice(2).join(' ') : '',
    shopName: String(shop?.name ?? o.shopName),
    shopAddress: String(addr?.setting_value ?? ''),
    shopPhone: String(tel?.setting_value ?? '')
  };

  const body = renderLetter(tpl.body, tokens);
  if (!body) return false;

  const subject = renderLetter(tpl.subject, tokens) || tpl.subject;
  const composed = letter(subject, [body], undefined, unsubscribeUrl(companyId, 'email', o.to));

  const sent = await sendMail({
    to: o.to, subject, text: composed.text, html: composed.html,
    shopName: tokens.shopName,
    /* A reply goes to the shop, never to us. */
    replyTo: o.replyTo || undefined,
    companyId, context: 'web form ' + o.eventKey
  });

  return sent.ok;
}

export function prettyDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

export function prettyTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${ap}`;
}
