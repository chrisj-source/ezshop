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
 *
 * `publicPage` widens it for the marketing pages ONLY, because those load
 * Google Tag Manager. The CRM must not inherit that: every screen behind
 * sign-in holds a shop's customer records, and 'no third-party script can
 * load' is worth more there than analytics is anywhere.
 */
function csp(publicPage: boolean): string {
  const google = publicPage
    ? ['https://www.googletagmanager.com', 'https://www.google-analytics.com',
       'https://*.google-analytics.com', 'https://*.analytics.google.com']
    : [];

  return [
    "default-src 'self'",
    ["script-src 'self' 'unsafe-inline'", ...(publicPage ? ['https://www.googletagmanager.com'] : [])].join(' '),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    ["img-src 'self' data: blob:", ...google].join(' '),
    ["connect-src 'self'", ...google].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    /* The app must never be framed. The marketing pages must not be either —
       GTM's noscript iframe is a CHILD frame, which frame-src governs. */
    "frame-ancestors 'none'",
    publicPage ? "frame-src https://www.googletagmanager.com" : "frame-src 'none'",
    'upgrade-insecure-requests'
  ].join('; ');
}

/**
 * The public marketing site, and nothing else.
 *
 * Everything in Easy Shop was `noindex` until 15 Sep 2026, which was right when
 * every page was a shop's private records. The marketing pages have to be the
 * exception or they cannot rank — so the allowlist is explicit and narrow, and
 * anything not named here stays cloaked. A new CRM screen is invisible to
 * crawlers by default; a new marketing page has to be added here on purpose.
 *
 * Keep this in step with `web/robots.txt` and `web/sitemap.xml`.
 */
const PUBLIC_PAGES = new Set([
  '/', '/index.html',
  '/about.html',
  '/privacy.html',
  '/sms-terms.html',
  '/terms.html',
  '/robots.txt', '/sitemap.xml',
  '/site.css',
  '/consent.js',
  '/favicon.ico'
]);

/**
 * Public, but deliberately NOT indexed.
 *
 * `checkin.html` and `unsubscribe.html` need no sign-in, which is not the same
 * as wanting them in a search index — one is a shop's intake form and the other
 * is reached from a signed link. They stay cloaked with the CRM.
 */
function isPublicPage(url: string): boolean {
  const path = url.split('?')[0];
  /* The marketing pages' own images. A noindex header on an image keeps it out
     of image search and out of a rich result's thumbnail, so the screenshots
     have to be allowed alongside the pages that use them. */
  if (path.startsWith('/img/')) return true;
  /* The IndexNow key file. Bing fetches it to prove we own the domain, so it
     has to be reachable and must not be cloaked. */
  if (/^\/[a-f0-9]{8,64}\.txt$/i.test(path)) return true;
  return PUBLIC_PAGES.has(path);
}

/**
 * The booking snippet, and only it.
 *
 * Deliberately an exact match rather than a prefix: a prefix is how a folder
 * of internal scripts ends up loadable from anybody's website a year from now.
 */
function isEmbedScript(url: string): boolean {
  return url.split('?')[0] === '/f.js';
}

function applyHeaders(req: FastifyRequest, reply: FastifyReply): void {
  const isPublic = isPublicPage(req.url);
  reply.header('content-security-policy', csp(isPublic));
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'strict-origin-when-cross-origin');
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('permissions-policy', 'camera=(self), geolocation=(), microphone=()');

  /**
   * The one thing on this server that is MEANT to be loaded by another site.
   *
   * `f.js` is the booking snippet a shop pastes into its own website, so a
   * same-origin resource policy would block the only job it has. Nothing else
   * gets this: every other file here is a shop's records, and `same-origin`
   * stays the default precisely so a mistake fails closed.
   *
   * The script itself is public and carries nothing — the data it fetches is
   * gated per request by the key and the domain allowlist, not by who can
   * download the file.
   */
  reply.header('cross-origin-resource-policy',
    isEmbedScript(req.url) ? 'cross-origin' : 'same-origin');

  if (isPublic) {
    /* The marketing pages are meant to be found. `max-image-preview:large`
       lets Google use a full-size thumbnail in results, which is worth having
       and costs nothing. */
    reply.header('x-robots-tag', 'index, follow, max-image-preview:large, max-snippet:-1');
  } else {
    /* Everything else is a shop's records. Customer names must never turn up
       in a search index, whatever a crawler finds its way to. */
    reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
  }

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

  /**
   * The web funnel is the one exception, and it is exempt because it has a
   * STRICTER check of its own rather than a weaker one.
   *
   * These endpoints are posted to from the shop's own website, so a foreign
   * Origin is not the attack here — it is the entire point. What guards them
   * is the per-shop domain allowlist in `lib/funnel.ts`, which refuses a
   * request whose Origin the shop has not named, and refuses one with no
   * Origin at all. They also carry no session: `credentials: 'omit'` on the
   * snippet's side, and nothing in those routes reads a cookie.
   */
  if (req.url.startsWith('/api/f/')) return true;

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
  /**
   * The public booking form. Tighter than anything else here, because it is
   * the only endpoint a stranger can reach that writes a real appointment.
   * Generous enough for somebody filling the form in slowly and changing their
   * mind about the day twice; nowhere near enough to fill a week.
   */
  funnel: { max: 60, windowMs: 10 * 60 * 1000 },
  /** Anything that writes. Generous — a busy service writer saves constantly. */
  write: { max: 240, windowMs: 60 * 1000 },
  /** Everything else, mostly reads and thumbnails. The board polls. */
  read: { max: 1200, windowMs: 60 * 1000 }
} as const;

function bucketFor(req: FastifyRequest): keyof typeof LIMITS {
  if (req.url.startsWith('/api/auth/')) return 'auth';
  if (req.url.startsWith('/api/f/')) return 'funnel';
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
      /* The funnel's answer is deliberately generic. A robot reads whatever a
         person reads, so naming the window or the limit only helps whoever is
         pacing against it. */
      return reply.code(429).send({
        error: name === 'funnel'
          ? 'Try again in a minute.'
          : 'Too many requests. Give it a minute.'
      });
    }
  });
}
