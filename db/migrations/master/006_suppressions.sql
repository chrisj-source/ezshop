-- 006 — the platform-wide suppression list.
--
-- Per-shop suppression lives in each tenant database (tenant/021). This table
-- is the narrow exception: a HARD BOUNCE or a spam complaint is not a shop's
-- decision, it is the address telling the internet it does not exist or does
-- not want mail from us at all. Sending to it again costs every shop on the
-- platform its sending reputation, so it is blocked everywhere.
--
-- Decided 15 Sep 2026: per shop by default, platform-wide for bounces and
-- complaints only. Nothing a customer clicks lands here.

CREATE TABLE IF NOT EXISTS platform_suppressions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel      ENUM('email','sms') NOT NULL,
  destination  VARCHAR(190) NOT NULL
               COMMENT 'email lowercased and trimmed; sms as digits only',
  reason       ENUM('bounce','complaint','manual') NOT NULL
               COMMENT 'no unsubscribe here — an unsubscribe is per shop',
  detail       VARCHAR(255) NULL COMMENT 'what the provider said',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at  DATETIME NULL COMMENT 'set, never deleted — the history is the point',
  released_by  BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_platform_supp (channel, destination),
  KEY ix_platform_supp_live (channel, destination, released_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
