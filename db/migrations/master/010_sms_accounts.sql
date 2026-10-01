-- 010 — a Twilio account per shop.
--
-- Decided 15 Sep 2026: a number per shop, so one shop's volume can only get its
-- own number flagged. Each shop brings its own Twilio account (Account SID and
-- Auth Token) and its own sender — a phone number, or a Messaging Service, which
-- is what an A2P 10DLC campaign is attached to.
--
-- The Auth Token is the only secret here. It is sealed with CREDENTIALS_KEY
-- (lib/secretbox.ts) and never returned to any screen once saved — the platform
-- page shows its last four characters and nothing else.
--
-- Lives in master, not the tenant database, because Twilio's inbound webhook
-- has to be resolved to a shop before there is a tenant to look in, and its
-- signature can only be checked with this token.

CREATE TABLE IF NOT EXISTS company_sms (
  company_id        BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  account_sid       CHAR(34)      NOT NULL COMMENT 'AC + 32 hex',
  auth_token_sealed VARCHAR(255)  NOT NULL COMMENT 'AES-256-GCM under CREDENTIALS_KEY',
  auth_token_last4  CHAR(4)       NOT NULL,
  sender_kind       ENUM('number','service') NULL,
  sender            VARCHAR(40)   NULL COMMENT '+1… or MG + 32 hex',
  account_name      VARCHAR(120)  NULL COMMENT 'friendly name Twilio reported at verify',
  verified_at       DATETIME      NULL COMMENT 'last time the credentials worked; cleared on any change',
  last_error        VARCHAR(255)  NULL,
  updated_by        BIGINT UNSIGNED NULL,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_csms_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Available to switch on, off by default. The toggle refuses until the shop's
-- account is verified and a sender is chosen (routes/platform.ts).
UPDATE features SET is_available = 1, default_on = 0,
  description = 'Texts to the vehicle owner from the shop''s own Twilio number. Needs the shop''s Twilio account and a registered 10DLC campaign.'
 WHERE feature_key = 'sms';
