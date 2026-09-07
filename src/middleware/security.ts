import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';

/**
 * Security headers, an origin check, and a rate limiter.
 *
 * All three are hand-rolled and dependency-free on purpose: this runs as one
 * Node process on one box, so an in-process counter is the honest shape. The
 * day Easy Shop runs behind two app servers, the limiter has to move to Redis
 * (the queue is already there) — until then a Map is not a shortcut, it is the
 * right size.
 */

/* ------------------------------------------------------------------ headers */

/**
 * The pages carry inline <script> and inline style throughout, so script-src
 * has to allow 'unsafe-inline' — which means this CSP is not an XSS backstop.
 * What it does buy: no third-party script can load, no one can frame the app,
 * no form can post off-site, and injected <img>/<iframe> cannot phone home.
 * Getting to a nonce CSP means touching every page in server/web; queued.
 */
function csp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    'upgrade-insecure-requests'
  ].join('; ');
}

function applyHeaders(req: FastifyRequest, reply: FastifyReply): void {
  reply.header('content-security-policy', csp());
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'strict-origin-when-cross-origin');
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header('permissions-policy', 'camera=(self), geolocation=(), microphone=()');

  /* Nothing here is public. Shops' customer names should never turn up in a
     search index, whatever a crawler finds its way to. */
  reply.header('x-robots-tag', 'noindex, nofollow, noarchive');

  /* Two years, subdomains included. Only in production — sending this from a
     dev box pins localhost to HTTPS in your browser for two years. */
  if (config.isProd) {
    reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
  }

  /* The API answers are per-user by definition. */
  if (req.url.startsWith('/api/')) {
    reply.header('cache-control', 'no-store');
    reply.header('vary', 'Cookie');
  }
}

/* ------------------------------------------------------------- origin check */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF, without a token.
 *
 * The session cookie is SameSite=Lax, which already stops a cross-site form
 * from POSTing with credentials in every browser we support. Lax is kept rather
 * than Strict because Strict also drops the cookie on the top-level GET that
 * Google sends the user back on after calendar consent — the user lands looking
 * signed out. So the belt to Lax's braces is this: a state-changing request
 * that declares a foreign Origin is refused.
 *
 * A request with no Origin at all is allowed through. Same-origin XHR always
 * sends one; what does not are curl, the odd old client, and server-to-server
 * calls — none of which is the attack this defends against, because a browser
 * cannot be made to omit it.
 */
function originOk(req: FastifyRequest): boolean {
  if (!WRITE_METHODS.has(req.method)) return true;

  const origin = req.headers.origin;
  if (!origin) return true;

  const allowed = new Set<string>();
  try { allowed.add(new URL(config.appUrl).origin); } catch { /* unset in dev */ }
  const host = req.headers.host;
  if (host) {
    allowed.add(`https://${host}`);
    if (!config.isProd) allowed.add(`http://${host}`);
  }
  return allowed.has(origin);
}

/* ------------------------------------------------------------ rate limiting */

interface Window { count: number; resetAt: number; }

const buckets = new Map<string, Window>();

const LIMITS = {
  /** Sign-in, password reset, login codes. Per IP, on top of the per-account lockout. */
  auth: { max: 20, windowMs: 15 * 60 * 1000 },
  /** Anything that writes. Generous — a busy service writer saves constantly. */
  write: { max: 240, windowMs: 60 * 1000 },
  /** Everything else, mostly reads and thumbnails. The board polls. */
  read: { max: 1200, windowMs: 60 * 1000 }
} as const;

function bucketFor(req: FastifyRequest): keyof typeof LIMITS {
  if (req.url.startsWith('/api/auth/')) return 'auth';
  return WRITE_METHODS.has(req.method) ? 'write' : 'read';
}

function hit(key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const w = buckets.get(key);
  if (!w || w.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  w.count += 1;
  if (w.count > max) return { ok: false, retryAfter: Math.ceil((w.resetAt - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, w] of buckets) if (w.resetAt <= now) buckets.delete(k);
}, 60_000);
sweeper.unref();

/* ------------------------------------------------------------------ install */

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    applyHeaders(req, reply);

    if (!originOk(req)) {
      req.log.warn({ origin: req.headers.origin, url: req.url }, 'cross-origin write refused');
      return reply.code(403).send({ error: 'Request blocked. Reload the page and try again.' });
    }

    /* Static files are not counted — a page pulls a dozen of them and the board
       is one page load with forty thumbnails behind it. */
    if (!req.url.startsWith('/api/')) return;

    const name = bucketFor(req);
    const { max, windowMs } = LIMITS[name];
    const r = hit(`${name}:${req.ip}`, max, windowMs);
    if (!r.ok) {
      reply.header('retry-after', String(r.retryAfter));
      return reply.code(429).send({ error: 'Too many requests. Give it a minute.' });
    }
  });
}
