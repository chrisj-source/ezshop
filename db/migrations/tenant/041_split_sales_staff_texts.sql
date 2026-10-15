-- 041 — split sales, and texts to the shop's own people.
-- One ADD COLUMN per statement (CLAUDE.md: a multi-clause ALTER is atomic).

-- Salesperson 1 stays the 'sales' assignment. 2 and 3 and the percentages sit
-- beside it; NULL percentages mean no split (salesperson 1 at 100%).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_pct DECIMAL(5,2) NULL COMMENT 'salesperson 1 share; NULL = no split';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales2_user_id BIGINT UNSIGNED NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales2_pct DECIMAL(5,2) NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales3_user_id BIGINT UNSIGNED NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales3_pct DECIMAL(5,2) NULL;
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS sales_pct DECIMAL(5,2) NULL COMMENT 'salesperson 1 share; NULL = no split';
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS sales2_user_id BIGINT UNSIGNED NULL;
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS sales2_pct DECIMAL(5,2) NULL;
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS sales3_user_id BIGINT UNSIGNED NULL;
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS sales3_pct DECIMAL(5,2) NULL;

-- A person's own mobile, for texts the shop sends its staff. approval NULL =
-- the default (on for pay-plan editors), 1 on, 0 off.
CREATE TABLE IF NOT EXISTS staff_sms (
  user_id     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  phone       VARCHAR(10)   NULL COMMENT 'ten digits',
  approval    TINYINT(1)    NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO shop_settings (setting_key, setting_value) VALUES ('sms_staff_approval_on', '1');
INSERT IGNORE INTO shop_settings (setting_key, setting_value) VALUES ('sms_staff_approval_text', '[ro] is approved for [vehicle], total approval: [amount]');
