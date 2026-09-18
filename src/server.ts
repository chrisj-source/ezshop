import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { config } from './config';
import { closeMaster, master } from './db/master';
import { closeAllTenants } from './db/tenant';
import { registerContext } from './middleware/context';
import { registerSecurity } from './middleware/security';
import { runRetention } from './jobs/retention';
import { registerAuth } from './auth/routes';
import { registerPlatform } from './routes/platform';
import { registerBoard } from './routes/board';
import { registerRepairOrders } from './routes/ro';
import { registerShopConfig } from './routes/config';
import { registerNotifications } from './routes/notifications';
import { registerDocuments } from './routes/documents';
import { registerParts } from './routes/parts';
import { registerAdmin } from './routes/admin';
import { registerCheckin } from './routes/checkin';
import { registerClients } from './routes/clients';
import { registerEms } from './routes/ems';
import { registerLeads } from './routes/leads';
import { registerScheduler } from './routes/scheduler';
import { registerReports } from './routes/reports';
import { registerClosed } from './routes/closed';
import { registerSales } from './routes/sales';
import { registerRoles } from './routes/roles';
import { registerPay } from './routes/pay';
import { registerTotalLoss } from './routes/totalloss';
import { registerCloseout } from './routes/closeout';
import { registerAudit } from './routes/audit';
import { registerPayroll } from './routes/payroll';
import { registerCalendar } from './routes/gcal';
import { registerMoney } from './routes/money';
import { registerUnsubscribe } from './routes/unsubscribe';
import { registerDemoRequests } from './routes/demo';
import { registerFunnelPublic } from './routes/funnel';
import { registerFunnelAdmin } from './routes/funnel-admin';
import { purgeExpiredSessions } from './auth/session';
import { startDemoReset } from './lib/demo';
import { startMentionReminders } from './jobs/mentions';
import { startLeadChase } from './jobs/leadchase';
import { startFunnelHolds } from './jobs/funnel-holds';
import { closeQueue, startWorker } from './queue';
import { makeDerivatives } from './jobs/derivatives';
import { prunePageCache } from './jobs/page-cache';
import { mediaTools } from './lib/media';

async function main(): Promise<void> {
  const app = Fastify({
    logger: config.isProd
      ? { level: 'info' }
      : { level: 'debug', transport: { target: 'pino-pretty' } },
    /* Only the loopback proxy may set X-Forwarded-For. Trusting every hop lets
       anything that can reach the port forge the IP the limiter counts and the
       audit log records. */
    trustProxy: ['127.0.0.1', '::1'],
    bodyLimit: 8 * 1024 * 1024
  });

  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 60, fieldSize: 64 * 1024 }
  });

  const webRoot = path.join(__dirname, '..', 'web');
  if (fs.existsSync(webRoot)) {
    await app.register(fstatic, { root: webRoot, prefix: '/' });
  }

  await registerSecurity(app);
  await registerContext(app);
  await registerAuth(app);
  await registerPlatform(app);
  await registerBoard(app);
  await registerRepairOrders(app);
  await registerShopConfig(app);
  await registerNotifications(app);
  await registerDocuments(app);
  await registerParts(app);
  await registerAdmin(app);
  await registerCheckin(app);
  await registerClients(app);
  await registerEms(app);
  await registerLeads(app);
  await registerScheduler(app);
  await registerReports(app);
  await registerClosed(app);
  await registerSales(app);
  await registerRoles(app);
  await registerPay(app);
  await registerTotalLoss(app);
  await registerCloseout(app);
  await registerAudit(app);
  await registerPayroll(app);
  await registerCalendar(app);
  await registerMoney(app);
  /* Public and unauthenticated by design: the person clicking unsubscribe in a
     status email usually has no account. Authority is the signature on the
     link, not a session. */
  await registerUnsubscribe(app);
  /* The marketing site's demo form. Public: the sender has no account. */
  await registerDemoRequests(app);
  /* The website booking form. Public, cross-origin, and unauthenticated by
     necessity — it runs on the SHOP's own domain. A public key says which
     shop; the shop's domain allowlist says whether that page may use it. */
  await registerFunnelPublic(app);
  /* Its settings and the desk's queue, both behind sign-in. */
  await registerFunnelAdmin(app);

  app.get('/api/health', async () => {
    const [r] = await master().query('SELECT 1 AS ok');
    return { ok: true, db: Array.isArray(r) && r.length > 0, env: config.env, time: new Date().toISOString() };
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;

    /* Log the error, not the object graph around it. Fastify attaches the
       request to a thrown error, and `log.error(err)` walked into it and put
       request bodies — customer names, phone numbers, whole estimates — into
       journald, which is not a place with retention rules or access control.
       Message, stack and route: enough to find the bug, nothing personal. */
    req.log.error({
      err: { message: err.message, name: err.name, stack: err.stack, statusCode: code },
      method: req.method,
      route: req.routeOptions?.url ?? req.url.split('?')[0],
      userId: req.ctx?.user?.id ?? null,
      companyId: req.ctx?.company?.id ?? null
    }, 'request failed');

    reply.code(code).send({ error: code === 500 ? 'Something went wrong.' : err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'No such endpoint' });
    // Static pages are real files. A missing one is a 404, never a redirect
    // back to the index — that turns a typo into an infinite loop.
    return reply.code(404).type('text/html').send(
      '<!doctype html><meta charset="utf-8"><title>Not found</title>' +
      '<body style="background:#131c2e;color:#e7eaf2;font:400 14px system-ui;display:grid;' +
      'place-items:center;height:100vh;margin:0">' +
      '<div style="text-align:center"><p>That page does not exist.</p>' +
      '<p><a href="/board.html" style="color:#e5bf68">Back to the board</a></p></div>'
    );
  });

  const sweep = setInterval(() => { void purgeExpiredSessions().catch(() => {}); }, 6 * 3600 * 1000);
  sweep.unref();

  /* Retention. Runs daily, and with RETENTION_ENABLED unset it only reports —
     see jobs/retention.ts. First pass is an hour after boot rather than at
     boot, so a restart during shop hours does not spend its first minute
     walking every tenant's closed files. */
  const retention = setInterval(() => {
    void runRetention()
      .then(r => app.log.info({ retention: r }, config.retention.enabled
        ? 'retention pass complete'
        : 'retention dry run — set RETENTION_ENABLED=1 to act on it'))
      .catch(err => app.log.error({ err: { message: (err as Error).message } }, 'retention failed'));
  }, 24 * 3600 * 1000);
  retention.unref();

  /* Thumbnails are made behind the upload, in this same process — one service to
     start, one to watch. */
  const worker = startWorker(makeDerivatives, (msg, err) => {
    if (err) app.log.error({ err }, msg); else app.log.warn(msg);
  });

  const tools = await mediaTools();
  app.log.info(
    `media tools — sharp: ${tools.sharp ? 'yes' : 'no'}, ` +
    `heif-convert: ${tools.heifConvert ? 'yes' : 'no'}, mutool: ${tools.mutool ? 'yes' : 'no'}` +
    (tools.sharp && tools.mutool ? '' : ' (see INSTALL-MEDIA.md)')
  );

  /* The demo shop goes back to its seed at 2am Central. Checked on a timer
     rather than scheduled to the second, so a box that was asleep or
     restarting at 2am still gets its reset. */
  startDemoReset(app.log);

  /* Mentions that have gone unanswered. Hourly; the sweep decides what is due
     from each shop's own setting. */
  /**
   * Say out loud whether mail is on.
   *
   * `RESEND_API_KEY` defaults to an empty string, and `sendMail` then refuses
   * every message with "mail is switched off" — at SEND time, into a log
   * nobody is watching. The result is a box that looks healthy while every
   * notification, every password reset and every demo request silently goes
   * nowhere. That is exactly what happened: the first anybody knew was an empty
   * Resend dashboard.
   *
   * A subsystem that is off has to say so at boot.
   */
  if (!config.mail.apiKey) {
    app.log.error(
      'MAIL IS OFF — RESEND_API_KEY is not set in the environment. ' +
      'Nothing will send: no notifications, no password resets, no demo requests. ' +
      'Add it to /srv/easyshop/.env and restart.');
  } else {
    app.log.info({ from: config.mail.from, replyTo: config.mail.replyTo,
                   demoTo: config.mail.demoTo },
      'mail is on (Resend)');
  }

  startMentionReminders();

  /* Leads nobody has touched: 12 hours for a sales write-up, 48 for the rest. */
  startLeadChase();

  /* Website requests holding a slot nobody answered, and holds the shop's own
     hours no longer cover. Quarter-hourly. */
  startFunnelHolds();

  /* Rendered PDF pages nobody has opened in a month. */
  const pageSweep = setInterval(() => {
    void prunePageCache().catch(err => app.log.error({ err }, 'page cache sweep'));
  }, 12 * 3600 * 1000);
  pageSweep.unref();

  await app.listen({ port: config.port, host: '127.0.0.1' });
  app.log.info(`Easy Shop listening on 127.0.0.1:${config.port}`);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void (async () => {
        app.log.info('shutting down');
        await app.close();
        await worker?.close().catch(() => undefined);
        await closeQueue();
        await closeAllTenants();
        await closeMaster();
        process.exit(0);
      })();
    });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
