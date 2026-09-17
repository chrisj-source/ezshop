import { FastifyInstance } from 'fastify';
import { sendMail } from '../lib/mail';
import { config } from '../config';

/**
 * The demo request form on the marketing site.
 *
 * It used to be a `mailto:` link, which was a mistake worth writing down: a
 * mailto does **nothing at all** when the browser has no mail client
 * registered, and it fails silently. The visitor sees the page not react,
 * assumes it sent, and leaves. On the one form the site exists to collect,
 * that is lost business rather than a cosmetic bug.
 *
 * So it posts here and the server sends it, using the same Resend path
 * everything else uses. Public and unauthenticated by necessity — the whole
 * point is that the sender has no account.
 *
 * Nothing is stored. The request is an email to the inbox and no more: no
 * table, no row, nothing to breach, and the privacy policy can keep saying so.
 * If these ever need tracking, they should become leads in a real CRM rather
 * than a table nobody looks at.
 */
export async function registerDemoRequests(app: FastifyInstance): Promise<void> {

  /**
   * Is the mail path actually configured?
   *
   * `curl -s https://easyshopauto.com/api/demo-request/health` answers in one
   * line what otherwise takes a journalctl and a guess. It reports shape, never
   * the key itself.
   */
  app.get('/api/demo-request/health', async () => ({
    resendKey: config.mail.apiKey ? 'set (' + config.mail.apiKey.slice(0, 6) + '…)' : 'MISSING',
    from: config.mail.from || 'MISSING',
    to: config.mail.demoTo || 'MISSING',
    replyToDefault: config.mail.replyTo || 'MISSING'
  }));


  app.post('/api/demo-request', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;

    const clean = (v: unknown, max = 200): string =>
      String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

    /**
     * The honeypot. A field the stylesheet hides and a person therefore never
     * fills; a bot fills everything it finds. Cheaper than a captcha, invisible
     * to the visitor, and it costs a shop owner on a phone nothing.
     *
     * Answered with a cheerful 200 rather than an error: telling a bot it was
     * detected only teaches whoever wrote it.
     */
    if (clean(b.website)) return { ok: true };

    const name = clean(b.name, 120);
    const shop = clean(b.shop, 120);
    const email = clean(b.email, 190);
    const phone = clean(b.phone, 40);

    if (!name && !shop) {
      return reply.code(400).send({ error: 'Tell us at least your name or the shop name.' });
    }
    /* One way to reach them, or there is no point in the message. */
    if (!email && !phone) {
      return reply.code(400).send({
        error: 'An email address or a phone number, so we can get back to you.',
        field: 'email'
      });
    }
    if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: 'That email address does not look right.', field: 'email' });
    }

    const city = clean(b.city, 120);
    const current = clean(b.current, 160);

    const lines: string[] = [];
    if (name) lines.push(`Name: ${name}`);
    if (shop) lines.push(`Shop: ${shop}`);
    if (email) lines.push(`Email: ${email}`);
    if (phone) lines.push(`Phone: ${phone}`);
    if (city) lines.push(`City and state: ${city}`);
    if (current) lines.push(`Currently using: ${current}`);
    lines.push('');
    lines.push(clean(b.note, 4000) || '(no note)');

    const sent = await sendMail({
      /* The address the site advertises, not the automated-mail reply box. */
      to: config.mail.demoTo,
      subject: `Demo request${shop ? ' — ' + shop : name ? ' — ' + name : ''}`,
      text: lines.join('\n'),
      /* Their address, so hitting reply in the inbox answers the customer
         rather than the robot. Only when it is a real one. */
      replyTo: email || undefined,
      context: 'demo request'
    });

    if (!sent.ok) {
      /* The visitor is not told about our mail provider. They are told the
         thing they can act on, which is the phone number. */
      /* The provider's own words, at error level with the destination, because
         "something went wrong" in the browser is all the visitor should see and
         all I could see too when this first failed in front of the founder. */
      req.log.error({ err: sent.error, to: config.mail.demoTo, from: email },
        'demo request could not be sent');

      /**
       * The provider's own reason goes back to the browser.
       *
       * Normally a visitor should never see our infrastructure talking. But a
       * form that says "something went wrong" and nothing else is a form
       * nobody can fix without shell access, and this one failed twice in a
       * row with the reason sitting in a log file. Resend's message is a
       * sentence about configuration ("domain not verified", "you can only
       * send to your own address"), not customer data — so it is safe to show
       * and it is the only thing that ends the guessing.
       *
       * Worth removing once the form has been seen to work.
       */
      return reply.code(502).send({
        error: 'That did not send. Call 401-203-5823 and we will pick it up.',
        detail: sent.error || 'No reason given by the mail provider.'
      });
    }

    return { ok: true };
  });
}
