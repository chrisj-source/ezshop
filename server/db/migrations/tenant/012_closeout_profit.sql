-- 012 — the close-out sheet: what the shop made on the car.
--
-- Three parts. Labour rates on the person, so a close-out sheet can price hours
-- without anyone typing a rate. Deductible and rental on the file, settled in the
-- drawer while the car is in the shop rather than guessed at close. And the
-- close-out entries themselves — one row per assigned trade, whatever the desk
-- punched in.
--
-- The rule this all serves: the figures are owner-and-accounting only. Every
-- endpoint that returns them checks `viewPayPlans`, and the numbers are worked
-- out on the server so a browser that should not see them never receives them.

-- ===========================================================================
-- Labour rates on the person
-- ===========================================================================
--
-- A tech is paid by the hour, a flat rate per car, or — PDR only — a share of the
-- job. `rate_cents` carries the first two; `rate_pct` the third.
ALTER TABLE staff
  ADD COLUMN pay_basis   ENUM('hourly','flat','pct') NOT NULL DEFAULT 'hourly' AFTER efficiency,
  ADD COLUMN rate_cents  BIGINT NOT NULL DEFAULT 0 COMMENT 'per hour, or per car when flat' AFTER pay_basis,
  ADD COLUMN rate_pct    DECIMAL(6,3) NOT NULL DEFAULT 0 COMMENT 'PDR only: a share of the job' AFTER rate_cents;

-- ===========================================================================
-- The file: deductible and rental
-- ===========================================================================
--
-- The deductible is the shop's own call, never the insurer's — they may write a
-- $1,000 deductible and the shop collect $500 of it. What is not collected is
-- given away, and it comes off the profit and off the commission base.
ALTER TABLE repair_orders
  ADD COLUMN deductible_cents        BIGINT NOT NULL DEFAULT 0 COMMENT 'what the customer owes' AFTER discount_cents,
  ADD COLUMN deductible_collect      TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'are we collecting any of it' AFTER deductible_cents,
  ADD COLUMN deductible_charge_cents BIGINT NOT NULL DEFAULT 0 COMMENT 'what we are actually charging' AFTER deductible_collect,
  -- Provider and coverage are decided on the file. At close only the price can
  -- be touched.
  ADD COLUMN rental_provider VARCHAR(32) NULL COMMENT 'Avis, Budget, Enterprise, Hertz, Loaner' AFTER rental_cost_cents,
  ADD COLUMN rental_covered  TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'policy covers it, so there is reimbursement to chase' AFTER rental_provider,
  -- Marked on the sales pay side, per file. Off for a house deal, a re-write
  -- someone else closed, or a car nobody earns on.
  ADD COLUMN commission_payable TINYINT(1) NOT NULL DEFAULT 1 AFTER rental_covered,
  -- Paint materials: hours × the shop rate, or a flat figure when there are no
  -- paint hours to work from.
  ADD COLUMN materials_flat_cents BIGINT NOT NULL DEFAULT 0 COMMENT 'used when there are no paint hours' AFTER materials_cost_cents;

-- A deductible that was already recorded as deductible assistance keeps its
-- meaning: the shop wrote off the whole thing.
UPDATE repair_orders
   SET deductible_cents = discount_cents, deductible_collect = 0
 WHERE discount_cents > 0 AND deductible_cents = 0;

-- ===========================================================================
-- What was punched in at close
-- ===========================================================================
--
-- One row per assigned trade. `basis` is how the desk chose to enter it — hours
-- at the tech's rate, a flat dollar, the EMS estimate's own hours, or a share of
-- the job for PDR. `cost_cents` is the settled answer, written once so the closed
-- report and the close-out sheet can never disagree.
CREATE TABLE ro_labour (
  ro_id         BIGINT UNSIGNED NOT NULL,
  position_key  VARCHAR(24)   NOT NULL COMMENT 'pdr, body, paint, ri, detail',
  basis         ENUM('hours','flat','ems','pct') NOT NULL,
  hours         DECIMAL(7,2)  NOT NULL DEFAULT 0,
  rate_cents    BIGINT        NOT NULL DEFAULT 0 COMMENT 'the rate used, kept so history survives a rate change',
  rate_pct      DECIMAL(6,3)  NOT NULL DEFAULT 0,
  pct_after_costs TINYINT(1)  NOT NULL DEFAULT 0 COMMENT 'PDR: a share of what is left, not of the approval',
  cost_cents    BIGINT        NOT NULL DEFAULT 0,
  user_id       BIGINT UNSIGNED NULL COMMENT 'who it is owed to',
  display_name  VARCHAR(120)  NULL,
  entered_by    BIGINT UNSIGNED NULL,
  entered_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (ro_id, position_key),
  KEY ix_labour_user (user_id),
  CONSTRAINT fk_labour_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The settled profit, written at close. Kept rather than recomputed so a rate
-- change next month does not rewrite what last month made — and so the closed
-- report can show profit without redoing the arithmetic per row.
CREATE TABLE ro_profit (
  ro_id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  approval_cents    BIGINT NOT NULL DEFAULT 0,
  deductible_given_cents BIGINT NOT NULL DEFAULT 0,
  promises_cents    BIGINT NOT NULL DEFAULT 0,
  rental_cents      BIGINT NOT NULL DEFAULT 0 COMMENT 'what the shop carried, so nil on a covered rental',
  parts_cents       BIGINT NOT NULL DEFAULT 0,
  labour_cents      BIGINT NOT NULL DEFAULT 0,
  materials_cents   BIGINT NOT NULL DEFAULT 0,
  sublet_cents      BIGINT NOT NULL DEFAULT 0,
  sales_pay_cents   BIGINT NOT NULL DEFAULT 0,
  profit_cents      BIGINT NOT NULL DEFAULT 0,
  profit_pct        DECIMAL(6,2) NOT NULL DEFAULT 0 COMMENT 'of the approval amount',
  settled_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  settled_by        BIGINT UNSIGNED NULL,
  CONSTRAINT fk_profit_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  -- Paint materials, per paint hour.
  ('materials_rate_cents', '4200'),
  -- Under this, the close-out sheet says the profit is thin for this shop.
  ('thin_profit_pct', '25')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
