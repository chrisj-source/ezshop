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
    masterDb: process.env.MASTER_DB ?? 'easyshop_master'
  },

  cookieSecret: need('COOKIE_SECRET'),
  sessionDays: Number(process.env.SESSION_DAYS ?? 14),
  agentTokenSalt: process.env.EMS_AGENT_TOKEN_SALT ?? '',

  storageDir: process.env.STORAGE_DIR ?? path.resolve(process.cwd(), 'storage'),

  /**
   * Tenant DB credentials are looked up by NAME, never stored in the master DB.
   * company_databases.secret_ref = 'DEFAULT' resolves TENANT_SECRET_DEFAULT.
   * Falls back to the app account's own password on a single-box install.
   */
  tenantSecret(ref: string): string {
    const v = process.env[`TENANT_SECRET_${ref.toUpperCase()}`];
    if (v) return v;
    if (ref.toUpperCase() === 'DEFAULT') return config.db.password;
    throw new Error(`No credential for secret_ref "${ref}". Set TENANT_SECRET_${ref.toUpperCase()} in .env`);
  }
};

export const COOKIE_NAME = 'es_sid';
