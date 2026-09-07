import 'dotenv/config';
import path from 'node:path';

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
  port: Number(process.env.PORT ?? 3000),
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',

  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: need('DB_USER'),
    password: need('DB_PASSWORD'),
    masterDb: process.env.MASTER_DB ?? 'easyshop_master',
    /**
     * TLS to MySQL. Off by default because the database is on loopback, where
     * it buys nothing. The tenant schema already allows a per-shop `db_host`
     * off-box, and the moment one is set this must be on — otherwise the
     * credential and every customer record cross a network in the clear.
     * DB_SSL=1 verifies the server certificate; DB_SSL=insecure skips
     * verification, which is for a self-signed managed database and nothing
     * else.
     */
    ssl: process.env.DB_SSL === '1' ? { rejectUnauthorized: true }
       : process.env.DB_SSL === 'insecure' ? { rejectUnauthorized: false }
       : undefined
  },

  cookieSecret: need('COOKIE_SECRET'),
  /**
   * The key every per-shop database password is computed from — see
   * lib/tenant-credentials.ts. Not an encryption key: nothing is encrypted with
   * it, so losing it costs an hour of resetting MySQL logins rather than any
   * data. Leaking it is worth what the old shared credential was worth.
   *
   * Optional, because a box where no shop has been migrated yet does not need
   * it. A shop whose secret_ref says DERIVED fails loudly without it.
   */
  tenantMasterSecret: process.env.TENANT_MASTER_SECRET ?? '',
  sessionDays: Number(process.env.SESSION_DAYS ?? 14),
  /**
   * Signed out after this many days of no requests, whatever the absolute
   * expiry says. A tablet left on a shop bench should not stay signed in for a
   * fortnight because nobody closed the tab.
   */
  sessionIdleDays: Number(process.env.SESSION_IDLE_DAYS ?? 1),
  agentTokenSalt: process.env.EMS_AGENT_TOKEN_SALT ?? '',

  storageDir: process.env.STORAGE_DIR ?? path.resolve(process.cwd(), 'storage'),

  /**
   * Redis, for the thumbnail queue. Unset and the app makes thumbnails inside
   * the upload request instead — slower for the person uploading, but it works.
   */
  redis: {
    url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
  },

  /**
   * Retention, decided 30 Aug 2026: archival at a year, hard limit at ten.
   *
   * `enabled` is off by default and must be set deliberately. Both passes run
   * either way — with it off they report what they would have done and write a
   * dry-run row, so the first real run is not also the first look.
   */
  retention: {
    enabled: process.env.RETENTION_ENABLED === '1',
    archiveMonths: Number(process.env.RETENTION_ARCHIVE_MONTHS ?? 12),
    purgeYears: Number(process.env.RETENTION_PURGE_YEARS ?? 10)
  },

  media: {
    /** Jobs at once. Two is right for a shop box; raise it if the box is idle. */
    concurrency: Number(process.env.MEDIA_CONCURRENCY ?? 2),
    /** Rendered PDF pages are dropped this long after they were last opened. */
    pageCacheDays: Number(process.env.PAGE_CACHE_DAYS ?? 30)
  },

  /**
   * Google Calendar, push only. Optional: with these unset the settings screen
   * says the server is not set up rather than offering a dead button.
   */
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? ''
  },

  /**
   * Tenant DB credentials are looked up by NAME, never stored in the master DB.
   * company_databases.secret_ref = 'DEFAULT' resolves TENANT_SECRET_DEFAULT.
   * Falls back to the app account's own password on a single-box install.
   *
   * 'DERIVED' does not come through here — it is computed per shop from
   * tenantMasterSecret; see lib/tenant-credentials.ts.
   */
  tenantSecret(ref: string): string {
    const v = process.env[`TENANT_SECRET_${ref.toUpperCase()}`];
    if (v) return v;
    if (ref.toUpperCase() === 'DEFAULT') return config.db.password;
    throw new Error(`No credential for secret_ref "${ref}". Set TENANT_SECRET_${ref.toUpperCase()} in .env`);
  }
};

export const COOKIE_NAME = 'es_sid';
