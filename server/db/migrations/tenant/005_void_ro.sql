-- 005 — voiding a repair order
-- A void is its own flag, not a status and not a hold: the file keeps the slot
-- it was in, the flag takes it off the board and pauses the cycle clock. The
-- number it held is released for reuse, so the row parks on a placeholder until
-- someone reopens it and it takes the next number in the sequence.
ALTER TABLE repair_orders
  ADD COLUMN voided_at   DATETIME NULL AFTER closed_at,
  ADD COLUMN voided_days INT NOT NULL DEFAULT 0
    COMMENT 'days spent voided, subtracted from days in shop',
  ADD COLUMN reopen_count INT NOT NULL DEFAULT 0;

CREATE INDEX ix_ro_voided ON repair_orders (voided_at);

-- One row per void, kept after a reopen so the void report can show what was
-- voided, why, by whom, and which of them came back.
CREATE TABLE ro_voids (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id             BIGINT UNSIGNED NOT NULL,
  ro_number         VARCHAR(32)   NOT NULL COMMENT 'number the file held when it was voided',
  reason            VARCHAR(48)   NOT NULL,
  note              VARCHAR(255)  NULL,
  status_slot       VARCHAR(64)   NULL COMMENT 'slot it was sitting in',
  amount_cents      BIGINT        NOT NULL DEFAULT 0,
  parts_cancelled   INT           NOT NULL DEFAULT 0,
  parts_flagged     INT           NOT NULL DEFAULT 0 COMMENT 'already ordered, flagged for return',
  voided_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by         BIGINT UNSIGNED NULL,
  voided_by_name    VARCHAR(120)  NULL,
  reopened_at       DATETIME      NULL,
  reopened_by       BIGINT UNSIGNED NULL,
  reopened_by_name  VARCHAR(120)  NULL,
  reopened_number   VARCHAR(32)   NULL COMMENT 'number it came back under',
  KEY ix_voids_ro (ro_id),
  KEY ix_voids_when (voided_at),
  CONSTRAINT fk_voids_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Parts already ordered against a voided file are flagged for return and stay
-- on the returns list until the desk clears each one.
ALTER TABLE parts_lines
  ADD COLUMN return_flagged_at DATETIME NULL AFTER received_at,
  ADD COLUMN return_cleared_at DATETIME NULL AFTER return_flagged_at;

CREATE INDEX ix_parts_returns ON parts_lines (return_flagged_at, return_cleared_at);
