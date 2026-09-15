import { FastifyInstance } from 'fastify';
import { RowDataPacket } from 'mysql2/promise';
import { mqOne } from '../db/master';
import { texec } from '../db/tenant';
import {
  readUnsubscribeLink, release, suppress, suppressionState
} from '../lib/suppression';

/**
 * The public unsubscribe page's endpoints.
 *
 * No sign-in, deliberately. The person clicking the link in a status email is
 * often a vehicle owner who has never had an account and never will; asking
 * them to make one to stop being emailed is the thing this exists to avoid.
 *
 * Authority comes from the signature on the link (see lib/suppression), not
 * from a session, so these routes must be registered OUTSIDE the context
 * middleware's shop scoping — they already know which shop they are for.
 */
export async function registerUnsubscribe(app: FastifyInstance): Promise<void> {

  /** What the page shows before the person does anything. */
  app.get('/api/unsubscribe', async (req, reply) => {
    const link = readUnsubscribeLink(req.query as Record<string, unknown>);
    if (!link) return reply.code(400).send({ error: 'That link is not valid.' });

    const shop = await mqOne<RowDataPacket>(
      'SELECT name FROM companies WHERE id = ?', [link.companyId]).catch(() => null);

    const state = await suppressionState(link.channel, link.destination, link.companyId);

    return {
      shop: shop?.name ? String(shop.name) : 'this shop',
      channel: link.channel,
      /* Masked. The link is a URL that can end up in a browser history, a
         support ticket or a screenshot, and there is no reason for the page to
         print somebody's whole address back at them. */
      destination: mask(link.channel, link.destination),
      already: state.suppressed,
      /* A bounce is not something the person can undo by clicking. */
      locked: state.where === 'platform'
    };
  });

  /** Stop. One click, no confirmation step, no preference maze. */
  app.post('/api/unsubscribe', async (req, reply) => {
    const link = readUnsubscribeLink(req.query as Record<string, unknown>);
    if (!link) return reply.code(400).send({ error: 'That link is not valid.' });

    await suppress(link.companyId, link.channel, link.destination, {
      reason: link.channel === 'sms' ? 'stop' : 'unsubscribe',
      source: 'link',
      ip: req.ip
    });

    await texec(link.companyId,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (NULL, ?, 'suppression', 0, 'suppression.add', ?)`,
      ['the recipient', JSON.stringify({
        channel: link.channel, destination: link.destination, via: 'link', ip: req.ip
      })]).catch(() => undefined);

    return { ok: true, state: 'unsubscribed' };
  });

  /**
   * Back on. Reached only from this page, on a link the person is holding —
   * which is what makes it their consent rather than the shop's decision.
   */
  app.post('/api/unsubscribe/resubscribe', async (req, reply) => {
    const link = readUnsubscribeLink(req.query as Record<string, unknown>);
    if (!link) return reply.code(400).send({ error: 'That link is not valid.' });

    const state = await suppressionState(link.channel, link.destination, link.companyId);
    if (state.where === 'platform') {
      return reply.code(409).send({
        error: 'This address bounced as undeliverable, so it cannot be switched ' +
               'back on from here. Give the shop a working address instead.'
      });
    }

    await release(link.companyId, link.channel, link.destination, req.ip);

    await texec(link.companyId,
      `INSERT INTO audit_log (user_id, user_name, entity, entity_id, action, detail)
       VALUES (NULL, ?, 'suppression', 0, 'suppression.release', ?)`,
      ['the recipient', JSON.stringify({
        channel: link.channel, destination: link.destination, via: 'link', ip: req.ip
      })]).catch(() => undefined);

    return { ok: true, state: 'subscribed' };
  });
}

function mask(channel: 'email' | 'sms', d: string): string {
  if (channel === 'sms') return d.length > 4 ? `••• ••• ${d.slice(-4)}` : d;
  const at = d.indexOf('@');
  if (at < 1) return d;
  const user = d.slice(0, at), host = d.slice(at);
  if (user.length <= 2) return user[0] + '•••' + host;
  return user.slice(0, 2) + '•'.repeat(Math.min(user.length - 2, 6)) + host;
}
