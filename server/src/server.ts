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
import { purgeExpiredSessions } from './auth/session';

async function main(): Promise<void> {
  const app = Fastify({
    logger: config.isProd
      ? { level: 'info' }
      : { level: 'debug', transport: { target: 'pino-pretty' } },
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024
  });

  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 12 }
  });

  const webRoot = path.join(__dirname, '..', 'web');
  if (fs.existsSync(webRoot)) {
    await app.register(fstatic, { root: webRoot, prefix: '/' });
  }

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

  app.get('/api/health', async () => {
    const [r] = await master().query('SELECT 1 AS ok');
    return { ok: true, db: Array.isArray(r) && r.length > 0, env: config.env, time: new Date().toISOString() };
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    req.log.error(err);
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
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

  await app.listen({ port: config.port, host: '127.0.0.1' });
  app.log.info(`Easy Shop listening on 127.0.0.1:${config.port}`);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void (async () => {
        app.log.info('shutting down');
        await app.close();
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
