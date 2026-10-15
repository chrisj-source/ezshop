-- 040 — a promise added after the sales commission was paid.
-- The change is held out of the commission formula and put to owner and
-- accounting, who decide whether to take it off this week's sales pay.

CREATE TABLE IF NOT EXISTS commission_reviews (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL COMMENT 'the salesperson who was paid',
  paid_line_id    BIGINT UNSIGNED NOT NULL COMMENT 'the paid commission line it is about',
  from_cents      BIGINT        NOT NULL,
  to_cents        BIGINT        NOT NULL,
  delta_cents     BIGINT        NOT NULL COMMENT 'to - from. Kept out of the formula for good',
  rate_pct        DECIMAL(6,3)  NOT NULL DEFAULT 0,
  raised_by       BIGINT UNSIGNED NULL,
  raised_by_name  VARCHAR(120)  NULL,
  raised_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decision        ENUM('adjust','none') NULL,
  adjust_cents    BIGINT        NULL COMMENT 'signed; what went on sales pay',
  line_id         BIGINT UNSIGNED NULL COMMENT 'the manual adjustment it wrote',
  decided_by      BIGINT UNSIGNED NULL,
  decided_by_name VARCHAR(120)  NULL,
  decided_at      DATETIME      NULL,
  note            VARCHAR(255)  NULL,
  KEY ix_crev_ro (ro_id, decided_at),
  CONSTRAINT fk_crev_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE commission_lines ADD COLUMN IF NOT EXISTS manual TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'written by a person, never touched by reconcile';
