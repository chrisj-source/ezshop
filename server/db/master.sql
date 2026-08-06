-- Easy Shop — master (control plane) database
-- MariaDB 11 / MySQL 8.  Run once:  mysql -u es_app -p easyshop_master < db/master.sql
--
-- Holds: companies, their database location, feature flags, plans,
--        and ALL identity (users, memberships, sessions).
-- Does NOT hold: repair orders, leads, parts, documents. Those are per-tenant.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- Plans
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  code            VARCHAR(32)   NOT NULL PRIMARY KEY,
  label           VARCHAR(64)   NOT NULL,
  seat_limit      INT           NULL COMMENT 'NULL = unlimited',
  monthly_cents   INT           NOT NULL DEFAULT 0,
  sort_order      INT           NOT NULL DEFAULT 0,
  is_active       TINYINT(1)    NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO plans (code, label, seat_limit, monthly_cents, sort_order) VALUES
  ('trial',     'Trial',      5,    0,    1),
  ('starter',   'Starter',    10,   19900, 2),
  ('growth',    'Growth',     30,   39900, 3),
  ('multishop', 'Multi-shop', NULL, 79900, 4)
ON DUPLICATE KEY UPDATE label = VALUES(label);

-- ---------------------------------------------------------------------------
-- Companies (tenants)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug            VARCHAR(48)   NOT NULL COMMENT 'lowercase, used in the tenant db name',
  name            VARCHAR(160)  NOT NULL,
  city            VARCHAR(120)  NULL,
  state           VARCHAR(8)    NULL,
  timezone        VARCHAR(64)   NOT NULL DEFAULT 'America/Chicago',
  shop_type       ENUM('pdr','collision','both','detail') NOT NULL DEFAULT 'both',
  plan_code       VARCHAR(32)   NOT NULL DEFAULT 'trial',
  status          ENUM('trial','active','suspended','closed') NOT NULL DEFAULT 'trial',
  seats           INT           NOT NULL DEFAULT 5,
  owner_email     VARCHAR(190)  NULL,
  suspended_at    DATETIME      NULL,
  suspended_note  VARCHAR(255)  NULL,
  provisioned_at  DATETIME      NULL COMMENT 'when the tenant db was created and seeded',
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_companies_slug (slug),
  KEY ix_companies_status (status),
  CONSTRAINT fk_companies_plan FOREIGN KEY (plan_code) REFERENCES plans(code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Where each tenant's data lives.
-- secret_ref is a NAME, never a password. It resolves against the env/secret
-- store at connection time (TENANT_SECRET_<REF>).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_databases (
  company_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  db_host         VARCHAR(190)  NOT NULL DEFAULT '127.0.0.1',
  db_port         INT           NOT NULL DEFAULT 3306,
  db_name         VARCHAR(64)   NOT NULL,
  db_user         VARCHAR(64)   NOT NULL,
  secret_ref      VARCHAR(64)   NOT NULL DEFAULT 'DEFAULT',
  schema_version  INT           NOT NULL DEFAULT 0,
  migrated_at     DATETIME      NULL,
  read_only       TINYINT(1)    NOT NULL DEFAULT 0,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_company_db_name (db_name),
  CONSTRAINT fk_companydb_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Feature catalogue + per-company switches
-- requires_key encodes the dependency cascade (gcal needs scheduler, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS features (
  feature_key     VARCHAR(32)   NOT NULL PRIMARY KEY,
  label           VARCHAR(80)   NOT NULL,
  description     VARCHAR(400)  NOT NULL DEFAULT '',
  is_core         TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'cannot be switched off',
  is_available    TINYINT(1)    NOT NULL DEFAULT 1 COMMENT '0 = built but not shipped',
  requires_key    VARCHAR(32)   NULL,
  default_on      TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order      INT           NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO features (feature_key, label, description, is_core, is_available, requires_key, default_on, sort_order) VALUES
  ('board',   'Repair order board',    'The board, statuses and the RO drawer.',                                  1,1,NULL,1, 1),
  ('notif',   'Notification groups',   'In-app notifications routed by position or named list.',                  1,1,NULL,1, 2),
  ('parts',   'Parts tracking',        'Ordering, receipt, backorder and the parts gate on production lanes.',    0,1,NULL,1, 3),
  ('docs',    'Documents',             'Estimates, supplements and invoices filed against the repair order.',     0,1,NULL,1, 4),
  ('supp',    'Supplements & sublet',  'Supplement records with approval dates, and sublet vendor tracking.',     0,1,NULL,1, 5),
  ('ems',     'EMS import',            'CCC, Mitchell and Audatex export files imported onto repair orders.',     0,1,NULL,1, 6),
  ('sched',   'Scheduler',             'Drops, pickups, returns, estimate appointments and appraiser visits.',    0,1,NULL,1, 7),
  ('gcal',    'Google Calendar publish','One-way publish of the schedule to the shop calendar.',                  0,1,'sched',1, 8),
  ('leads',   'Leads',                 'Estimate requests and opportunities before they become a repair order.',  0,1,NULL,1, 9),
  ('mcheck',  'Mobile check-in',       'VIN scan, decode and intake photos from a phone at the door.',            0,1,NULL,1,10),
  ('msales',  'Mobile sales app',      'Reps write an opportunity on the road: name, phone, contract photo.',     0,1,'leads',1,11),
  ('clients', 'Wholesale clients',     'Dealer, hail company, auction and fleet accounts billed to the account.', 0,1,NULL,1,12),
  ('reports', 'Reports',               'Production, cycle time, flag hours and the financial reports.',           0,1,NULL,1,13),
  ('sms',     'SMS customer updates',  'Status texts to the vehicle owner. Needs a registered 10DLC brand.',      0,0,NULL,0,14),
  ('portal',  'Customer status page',  'A public link showing the customer where their car is.',                  0,0,NULL,0,15)
ON DUPLICATE KEY UPDATE label = VALUES(label), description = VALUES(description),
  is_core = VALUES(is_core), is_available = VALUES(is_available), requires_key = VALUES(requires_key);

CREATE TABLE IF NOT EXISTS company_features (
  company_id      BIGINT UNSIGNED NOT NULL,
  feature_key     VARCHAR(32)   NOT NULL,
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED NULL,
  PRIMARY KEY (company_id, feature_key),
  CONSTRAINT fk_cf_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_cf_feature FOREIGN KEY (feature_key) REFERENCES features(feature_key) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Identity. Every login in the product is here — platform owner, shop owner,
-- estimator, technician. The tenant DB stores work, not people.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email             VARCHAR(190)  NULL COMMENT 'NULL while a user is code-only',
  password_hash     VARCHAR(255)  NULL COMMENT 'argon2id',
  login_code        CHAR(8)       NULL COMMENT 'testing only — short code sign-in',
  login_code_expires DATETIME     NULL,
  name              VARCHAR(120)  NOT NULL,
  phone             VARCHAR(32)   NULL,
  is_platform_owner TINYINT(1)    NOT NULL DEFAULT 0,
  status            ENUM('active','disabled') NOT NULL DEFAULT 'active',
  must_change_pw    TINYINT(1)    NOT NULL DEFAULT 0,
  failed_logins     INT           NOT NULL DEFAULT 0,
  locked_until      DATETIME      NULL,
  last_login_at     DATETIME      NULL,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_code (login_code),
  KEY ix_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A user can belong to more than one company, with a different role in each.
CREATE TABLE IF NOT EXISTS memberships (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  company_id      BIGINT UNSIGNED NOT NULL,
  role            ENUM('owner','accounting','estimator','production_manager',
                       'parts_manager','front_office','salesperson','technician') NOT NULL,
  position_key    VARCHAR(24)   NULL COMMENT 'pdr, body, paint, ri, detail — technicians only',
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_membership (user_id, company_id),
  KEY ix_membership_company (company_id, status),
  CONSTRAINT fk_mem_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mem_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id              CHAR(43)      NOT NULL PRIMARY KEY COMMENT 'base64url of 32 random bytes',
  user_id         BIGINT UNSIGNED NOT NULL,
  company_id      BIGINT UNSIGNED NULL COMMENT 'the company this session is working in',
  impersonating   TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'platform owner dropped into a shop',
  ip              VARBINARY(16) NULL,
  user_agent      VARCHAR(255)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME      NOT NULL,
  revoked_at      DATETIME      NULL,
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expiry (expires_at),
  CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_sess_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash      CHAR(64)      NOT NULL PRIMARY KEY COMMENT 'sha256 of the emailed token',
  user_id         BIGINT UNSIGNED NOT NULL,
  expires_at      DATETIME      NOT NULL,
  used_at         DATETIME      NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_reset_user (user_id),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tokens the desktop EMS agent uses. One per shop computer, revocable.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id      BIGINT UNSIGNED NOT NULL,
  label           VARCHAR(120)  NOT NULL COMMENT 'which machine',
  token_hash      CHAR(64)      NOT NULL,
  last_seen_at    DATETIME      NULL,
  last_ip         VARBINARY(16) NULL,
  revoked_at      DATETIME      NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_agent_token (token_hash),
  KEY ix_agent_company (company_id),
  CONSTRAINT fk_agent_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Platform-level audit: company created, suspended, feature flipped, impersonation.
CREATE TABLE IF NOT EXISTS platform_audit (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id   BIGINT UNSIGNED NULL,
  company_id      BIGINT UNSIGNED NULL,
  action          VARCHAR(64)   NOT NULL,
  detail          JSON          NULL,
  ip              VARBINARY(16) NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_company (company_id, created_at),
  KEY ix_audit_actor (actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
