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
      req.log.error({ err: sent.error }, 'demo request could not be sent');
      return reply.code(502).send({
        error: 'Something went wrong sending that. Call 401-203-5823 and we will pick it up.'
      });
    }

    return { ok: true };
  });
}
