-- 039 — invoices read from the shop's own invoicing database (master 012).
-- A copy of what the tool said at the last read, keyed on the tool's own id.
-- Never edited here; the next read overwrites it.

CREATE TABLE IF NOT EXISTS external_invoices (
  ext_id          INT UNSIGNED  NOT NULL PRIMARY KEY COMMENT 'invoices.id in the tool',
  number          VARCHAR(32)   NOT NULL,
  profile         VARCHAR(40)   NULL,
  client_name     VARCHAR(160)  NULL,
  vehicle         VARCHAR(160)  NULL,
  vin             VARCHAR(24)   NULL,
  stock           VARCHAR(40)   NULL,
  invoice_date    DATE          NULL,
  due_date        DATE          NULL,
  total_cents     BIGINT        NOT NULL DEFAULT 0,
  paid_cents      BIGINT        NOT NULL DEFAULT 0,
  status          VARCHAR(8)    NOT NULL COMMENT 'open, paid or void, as the tool has it',
  generated_at    DATETIME      NULL,
  sent_at         DATETIME      NULL,
  paid_at         DATE          NULL COMMENT 'last payment received',
  ro_id           BIGINT UNSIGNED NULL,
  match_how       VARCHAR(12)   NULL COMMENT 'vin, ro, manual',
  synced_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_extinv_ro (ro_id),
  KEY ix_extinv_number (number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
