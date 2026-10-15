-- 043 — referrers, the referrer on a referral lead, and the referral payout list.
-- One ADD COLUMN per statement (CLAUDE.md). Seeds use INSERT ... ON DUPLICATE KEY.

CREATE TABLE IF NOT EXISTS referrers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind             ENUM('agent','adjuster','dealer','past_customer') NOT NULL,
  name             VARCHAR(160)  NOT NULL COMMENT 'the person, or the dealership',
  company          VARCHAR(160)  NULL COMMENT 'agency / carrier / dealership group',
  phone            VARCHAR(10)   NULL COMMENT 'ten digits',
  email            VARCHAR(190)  NULL,
  address          VARCHAR(190)  NULL,
  city             VARCHAR(90)   NULL,
  addr_state       VARCHAR(32)   NULL,
  zip              VARCHAR(16)   NULL,
  client_id        BIGINT UNSIGNED NULL COMMENT 'set when the referrer is an existing client',
  default_fee_cents BIGINT       NULL,
  payee_default    VARCHAR(160)  NULL COMMENT 'dealer: who the fee usually goes to (GM, service director...)',
  w9_on_file       TINYINT(1)    NOT NULL DEFAULT 0,
  note             VARCHAR(255)  NULL,
  active           TINYINT(1)    NOT NULL DEFAULT 1,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_ref_phone (phone),
  KEY ix_ref_email (email),
  KEY ix_ref_client (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS referrer_id BIGINT UNSIGNED NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_no_fee TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_fee_cents BIGINT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_payee VARCHAR(160) NULL COMMENT 'dealer fees: who it is paid to this time';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_tl_decision ENUM('pay','none') NULL COMMENT 'total loss: a manager decides';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_tl_by VARCHAR(120) NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_tl_at DATETIME NULL;
CREATE INDEX IF NOT EXISTS ix_leads_referrer ON leads (referrer_id);

-- One row per referral paid. Written when a money role marks it paid; the
-- payee and amount are copied, so a later edit never rewrites what was paid.
CREATE TABLE IF NOT EXISTS referral_payouts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id       BIGINT UNSIGNED NOT NULL,
  referrer_id   BIGINT UNSIGNED NOT NULL,
  ro_id         BIGINT UNSIGNED NULL,
  amount_cents  BIGINT        NOT NULL,
  payee         VARCHAR(160)  NOT NULL,
  earned_at     DATETIME      NULL,
  pay_date      DATE          NULL,
  method        VARCHAR(40)   NULL COMMENT 'check, cash, ...',
  reference     VARCHAR(60)   NULL COMMENT 'check number',
  note          VARCHAR(255)  NULL,
  paid_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_by       BIGINT UNSIGNED NULL,
  paid_by_name  VARCHAR(120)  NULL,
  UNIQUE KEY uq_payout_lead (lead_id),
  KEY ix_payout_referrer (referrer_id, paid_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sales manager: a capability, any number of people. Owner by default.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'sales_manager', 1, 0 FROM roles WHERE locked = 'owner'
ON DUPLICATE KEY UPDATE can_see = 1;
