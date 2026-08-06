import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { config } from './config';
import { closeMaster, master } from './db/master';
import { closeAllTenants } from './db/tenant';
import { registerContext } from './middleware/context';
import { registerAuth } from './auth/routes';
import { registerPlatform } from './routes/platform';
import { registerBoard } from './routes/board';
import { registerRepairOrders } from './routes/ro';
import { registerShopConfig } from './routes/config';
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

  app.get('/api/health', async () => {
    const [r] = await master().query('SELECT 1 AS ok');
    return { ok: true, db: Array.isArray(r) && r.length > 0, env: config.env, time: new Date().toISOString() };
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(code).send({ error: code === 500 ? 'Something went wrong.' : err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'No such endpoint' });
    const index = path.join(webRoot, 'index.html');
    if (fs.existsSync(index)) return reply.type('text/html').send(fs.createReadStream(index));
    return reply.code(404).send({ error: 'Not found' });
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
