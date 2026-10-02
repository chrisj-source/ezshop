-- 012 — reading a shop's own invoicing database (decided 2 Oct 2026).
--
-- For Extreme Hail & Collision first, and only shops switched on in platform
-- admin. The invoicing tool (PHP, hosted elsewhere) stays where it is; we read
-- its database hourly with a READ-ONLY login and record, per invoice, when it
-- was generated, sent and paid. Nothing is ever written to that database.
--
-- One row per shop. A location has its own row: its own connection and its own
-- company id inside the tool — nothing is shared across the group.
--
-- The password is sealed under CREDENTIALS_KEY (lib/secretbox.ts) and never
-- sent back to a screen, the same rule as the Twilio token.

CREATE TABLE IF NOT EXISTS company_invoice_sources (
  company_id        BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  host              VARCHAR(190)  NOT NULL,
  port              INT           NOT NULL DEFAULT 3306,
  db_name           VARCHAR(64)   NOT NULL,
  db_user           VARCHAR(80)   NOT NULL,
  password_sealed   VARCHAR(512)  NOT NULL,
  tool_company_id   INT UNSIGNED  NOT NULL COMMENT 'companies.id inside the invoicing tool',
  use_tls           TINYINT(1)    NOT NULL DEFAULT 1,
  enabled           TINYINT(1)    NOT NULL DEFAULT 1,
  last_sync_at      DATETIME      NULL,
  last_ok_at        DATETIME      NULL,
  last_error        VARCHAR(255)  NULL,
  last_count        INT           NULL,
  updated_by        BIGINT UNSIGNED NULL,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cis_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO features (feature_key, label, description, is_core, is_available, requires_key, default_on, sort_order)
VALUES ('extinv', 'External invoices', 'Reads the shop''s own invoicing database hourly: generated, sent and paid on each file.', 0, 1, NULL, 0, 16)
ON DUPLICATE KEY UPDATE label = VALUES(label), description = VALUES(description);
