-- 036 — every text, in and out.
--
-- One row per message. An outbound send that the gates refused is still a row
-- (state 'refused', with the reason) — "why was he not told" deserves an answer,
-- the same rule as suppression_hits. Rows are never deleted by the app.
--
-- trigger_key names the status update an automatic text was sent for, so the
-- same update is never sent twice on one file. Null on desk messages, replies
-- and tests. read_at is when somebody opened a reply on the file.

CREATE TABLE IF NOT EXISTS sms_messages (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  direction    ENUM('out','in') NOT NULL,
  ro_id        BIGINT UNSIGNED NULL,
  destination  VARCHAR(20)  NOT NULL COMMENT 'the customer''s number, ten digits',
  body         TEXT         NOT NULL,
  purpose      VARCHAR(24)  NOT NULL DEFAULT 'transactional' COMMENT 'transactional, marketing, test, reply',
  trigger_key  VARCHAR(32)  NULL,
  state        ENUM('queued','sent','delivered','failed','refused','received') NOT NULL,
  reason       VARCHAR(255) NULL COMMENT 'why refused or failed',
  twilio_sid   VARCHAR(40)  NULL,
  sent_by      BIGINT UNSIGNED NULL,
  sent_by_name VARCHAR(120) NULL,
  read_at      DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_sms_dest (destination, created_at),
  KEY ix_sms_ro (ro_id, created_at),
  KEY ix_sms_trigger (ro_id, trigger_key),
  UNIQUE KEY uq_sms_sid (twilio_sid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
