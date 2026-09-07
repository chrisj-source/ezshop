-- 011 — shop-configurable permissions, sales pay plans, and total loss.
--
-- Three queued items, one migration. Roles stop being a hard-coded list in
-- `permissions.ts` and become rows a shop owns; commission stops being one
-- number on a person and becomes a plan plus a ledger; and a totalled car gets
-- its own flag, its own pay, and the head of the board.

-- ===========================================================================
-- Roles a shop owns
-- ===========================================================================
--
-- `membership_roles` in the master DB already stores (user, company, role_key)
-- with role_key as a plain string, so custom keys need nothing there. This is
-- the per-shop definition of what those keys mean.
--
-- `locked` is structural, not cosmetic: 'owner' because the platform, the
-- scheduler and the calendar key off it, 'tech' because the lane rules hang off
-- trades. Both are still renameable — label is the shop's, role_key is ours.
CREATE TABLE roles (
  role_key      VARCHAR(32)   NOT NULL PRIMARY KEY,
  label         VARCHAR(64)   NOT NULL,
  rank_order    INT           NOT NULL DEFAULT 100 COMMENT 'lower ranks higher; picks the primary role. ties break by label',
  locked        ENUM('none','owner','tech') NOT NULL DEFAULT 'none',
  own_only      TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'only sees work assigned to them',
  is_custom     TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'added by the shop, not shipped',
  note          VARCHAR(255)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_roles_rank (rank_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per role per capability. Absent means no. `can_change` is only read
-- for the capabilities that split (money, leads, paperwork, reports, pay plans);
-- everywhere else `can_see` is the whole answer.
CREATE TABLE role_caps (
  role_key      VARCHAR(32)   NOT NULL,
  cap_key       VARCHAR(32)   NOT NULL,
  can_see       TINYINT(1)    NOT NULL DEFAULT 0,
  can_change    TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (role_key, cap_key),
  CONSTRAINT fk_role_caps_role FOREIGN KEY (role_key) REFERENCES roles(role_key) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles (role_key, label, rank_order, locked, own_only, is_custom, note) VALUES
  ('owner',              'Owner',              10, 'owner', 0, 0,
   'Holds everything and cannot be reduced. Only the original owner adds or removes owners.'),
  ('accounting',         'Accounting',          20, 'none', 0, 0, NULL),
  ('estimator',          'Estimator',           30, 'none', 0, 0, NULL),
  ('production_manager', 'Production manager',  40, 'none', 0, 0, NULL),
  ('parts_manager',      'Parts manager',       50, 'none', 0, 0, NULL),
  ('front_office',       'Front office',        60, 'none', 0, 0, NULL),
  ('salesperson',        'Salesperson',         70, 'none', 1, 0,
   'Sees their own leads and their own files.'),
  ('technician',         'Technician',          80, 'tech',  1, 0,
   'Locked because the lane rules hang off trades. Renameable, and can be given anything on the list.')
ON DUPLICATE KEY UPDATE label = label;

-- The defaults the hard-coded lists in permissions.ts carried, written out. The
-- owner row is every capability; the seed below is generated from the same
-- table `permissions.ts` keeps as its pre-migration fallback.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change) VALUES
  -- owner: everything
  ('owner','ro_totals',1,1),('owner','parts_money',1,1),('owner','labour_money',1,1),
  ('owner','commission',1,1),('owner','sees_all',1,1),('owner','edit_ro',1,1),
  ('owner','any_status',1,1),('owner','total_loss',1,1),('owner','void_ro',1,1),
  ('owner','close_ro',1,1),('owner','unclose',1,1),('owner','leads',1,1),
  ('owner','del_lead',1,1),('owner','paperwork',1,1),('owner','del_doc',1,1),
  ('owner','imports',1,1),('owner','assign',1,1),('owner','parts',1,1),
  ('owner','sublet',1,1),('owner','reports',1,1),('owner','money_reports',1,1),
  ('owner','pay_plans',1,1),('owner','admin',1,1),('owner','perms',1,1),
  -- accounting: the books
  ('accounting','ro_totals',1,1),('accounting','parts_money',1,0),('accounting','labour_money',1,0),
  ('accounting','commission',1,1),('accounting','sees_all',1,0),('accounting','close_ro',1,1),
  ('accounting','unclose',1,1),('accounting','leads',1,0),('accounting','paperwork',1,1),
  ('accounting','reports',1,1),('accounting','money_reports',1,0),('accounting','pay_plans',1,1),
  -- estimator: writes the file, sees all of the money
  ('estimator','ro_totals',1,1),('estimator','parts_money',1,1),('estimator','labour_money',1,1),
  ('estimator','commission',1,0),('estimator','sees_all',1,0),('estimator','edit_ro',1,1),
  ('estimator','any_status',1,1),('estimator','total_loss',1,1),('estimator','close_ro',1,0),
  ('estimator','leads',1,1),('estimator','del_lead',1,1),('estimator','paperwork',1,1),
  ('estimator','del_doc',1,1),('estimator','imports',1,1),('estimator','assign',1,1),
  ('estimator','parts',1,1),('estimator','sublet',1,1),('estimator','reports',1,0),
  ('estimator','money_reports',1,0),
  -- production manager: runs the shop floor, no money but the hours
  ('production_manager','labour_money',1,0),('production_manager','sees_all',1,0),
  ('production_manager','edit_ro',1,1),('production_manager','any_status',1,1),
  ('production_manager','total_loss',1,0),('production_manager','paperwork',1,1),
  ('production_manager','imports',1,1),('production_manager','assign',1,1),
  ('production_manager','parts',1,1),('production_manager','sublet',1,1),
  ('production_manager','reports',1,0),
  -- parts manager: the parts money and nothing else's
  ('parts_manager','parts_money',1,1),('parts_manager','sees_all',1,0),
  ('parts_manager','paperwork',1,0),('parts_manager','parts',1,1),('parts_manager','sublet',1,1),
  -- front office
  ('front_office','ro_totals',1,0),('front_office','sees_all',1,0),('front_office','edit_ro',1,1),
  ('front_office','any_status',1,1),('front_office','close_ro',1,1),('front_office','leads',1,1),
  ('front_office','del_lead',1,0),('front_office','paperwork',1,1),
  -- salesperson: own work only, own leads
  ('salesperson','sees_all',1,0),('salesperson','leads',1,1),('salesperson','paperwork',1,0),
  -- technician: own cars, and the hours on them
  ('technician','sees_all',1,0),('technician','labour_money',1,0)
ON DUPLICATE KEY UPDATE can_see = VALUES(can_see), can_change = VALUES(can_change);

-- The shop-wide tech visibility setting is now the Technician role's own_only
-- tick. Carry whatever the shop had chosen across, then leave the old setting
-- in place: nothing reads it after this, and deleting it loses the record of
-- what they had.
UPDATE roles SET own_only = COALESCE(
  (SELECT setting_value <> '0' FROM shop_settings WHERE setting_key = 'tech_sees_own_only'), 1)
WHERE role_key = 'technician';

-- ===========================================================================
-- Total loss
-- ===========================================================================
--
-- A flag on the file, not a status: the board synthesises the `00` lane above
-- Body from this column, so a shop reconfiguring its status board cannot break
-- it, the file keeps whatever slot it was in, and the assignments stay exactly
-- where they were — the car simply stops appearing in a technician's own list.
ALTER TABLE repair_orders
  ADD COLUMN total_loss_at   DATETIME NULL COMMENT 'own flag, like void. sorts to lane 00' AFTER paid_at,
  ADD COLUMN total_loss_by   BIGINT UNSIGNED NULL AFTER total_loss_at,
  ADD COLUMN total_loss_note VARCHAR(255) NULL AFTER total_loss_by;

CREATE INDEX ix_ro_total_loss ON repair_orders (total_loss_at);

-- Costs a pay plan can deduct that the file had nowhere to keep. Parts and
-- sublet already have their columns and are read from those.
ALTER TABLE repair_orders
  ADD COLUMN rental_cost_cents    BIGINT NOT NULL DEFAULT 0 AFTER sublet_cost_cents,
  ADD COLUMN towing_cost_cents    BIGINT NOT NULL DEFAULT 0 AFTER rental_cost_cents,
  ADD COLUMN materials_cost_cents BIGINT NOT NULL DEFAULT 0 AFTER towing_cost_cents,
  ADD COLUMN discount_cents       BIGINT NOT NULL DEFAULT 0 AFTER materials_cost_cents,
  ADD COLUMN shortpay_cents       BIGINT NOT NULL DEFAULT 0 AFTER discount_cents;

-- ===========================================================================
-- The triggers the commission report reads
-- ===========================================================================
--
-- Four stamps per file. They fire on the event itself, immediately, and the pay
-- ledger keys on them rather than reading status history back. The same stamps
-- are what the SMS work will hang off later, which is why they are their own
-- table and not four more columns.
CREATE TABLE ro_triggers (
  ro_id          BIGINT UNSIGNED NOT NULL,
  trigger_key    ENUM('arrived','approval','car_gone','file_closed') NOT NULL,
  fired_at       DATETIME      NOT NULL COMMENT 'when the event happened, not when the row was written',
  fired_by       BIGINT UNSIGNED NULL,
  fired_by_name  VARCHAR(120)  NULL,
  source         ENUM('auto','manual') NOT NULL DEFAULT 'auto',
  corrected_at   DATETIME      NULL COMMENT 'set when someone fixed a wrong stamp',
  note           VARCHAR(255)  NULL,
  PRIMARY KEY (ro_id, trigger_key),
  KEY ix_trig_fired (trigger_key, fired_at),
  CONSTRAINT fk_trig_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Files already in the system get the stamps their dates imply, so the first
-- commission report is not empty and does not have to be back-filled by hand.
INSERT INTO ro_triggers (ro_id, trigger_key, fired_at, source, note)
  SELECT id, 'arrived', opened_at, 'auto', 'back-filled from date in'
    FROM repair_orders WHERE opened_at IS NOT NULL
ON DUPLICATE KEY UPDATE fired_at = fired_at;

INSERT INTO ro_triggers (ro_id, trigger_key, fired_at, source, note)
  SELECT id, 'approval', approved_at, 'auto', 'back-filled from date approved'
    FROM repair_orders WHERE approved_at IS NOT NULL
ON DUPLICATE KEY UPDATE fired_at = fired_at;

INSERT INTO ro_triggers (ro_id, trigger_key, fired_at, source, note)
  SELECT id, 'car_gone', delivered_at, 'auto', 'back-filled from date completed'
    FROM repair_orders WHERE delivered_at IS NOT NULL
ON DUPLICATE KEY UPDATE fired_at = fired_at;

INSERT INTO ro_triggers (ro_id, trigger_key, fired_at, source, note)
  SELECT id, 'file_closed', COALESCE(close_date, closed_at), 'auto', 'back-filled from close'
    FROM repair_orders WHERE close_date IS NOT NULL OR closed_at IS NOT NULL
ON DUPLICATE KEY UPDATE fired_at = fired_at;

-- ===========================================================================
-- Sales pay plans
-- ===========================================================================
--
-- One plan per person. `mode` is the whole fork: 'net' takes the ticked costs
-- out of the approval amount first, 'flat' is a percentage of the approval as
-- written. A totalled car pays `tl_amount_cents` and no commission at all.
CREATE TABLE pay_plans (
  user_id           BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'master users.id',
  mode              ENUM('net','flat') NOT NULL DEFAULT 'net',
  rate_pct          DECIMAL(6,3)  NOT NULL DEFAULT 0,
  pay_when          ENUM('approval','car_gone','file_closed') NOT NULL DEFAULT 'file_closed',
  drop_on           TINYINT(1)    NOT NULL DEFAULT 0,
  drop_fee_cents    BIGINT        NOT NULL DEFAULT 0 COMMENT 'paid out when the car arrives',
  drop_recover      TINYINT(1)    NOT NULL DEFAULT 1 COMMENT 'comes back out of the commission',
  tl_amount_cents   BIGINT        NOT NULL DEFAULT 0 COMMENT 'what a total loss pays instead of a commission',
  tl_pay_drop       TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'pay the drop regardless on a total loss',
  active            TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by        BIGINT UNSIGNED NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What comes out before the percentage. Rows only exist for ticked costs.
CREATE TABLE pay_plan_deductions (
  user_id       BIGINT UNSIGNED NOT NULL,
  deduct_key    VARCHAR(24)   NOT NULL COMMENT 'parts, sublet, rental, tax, materials, towing, discount, shortpay',
  PRIMARY KEY (user_id, deduct_key),
  CONSTRAINT fk_ppd_plan FOREIGN KEY (user_id) REFERENCES pay_plans(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- The ledger
-- ===========================================================================
--
-- Every figure the shop owes a salesperson, one row per event per file. Lines
-- are recomputed whenever a trigger fires or a plan changes — but a line that
-- has been PAID is never rewritten. What changes after payment lands as an
-- 'adjustment' row against the next period, positive or negative, which is what
-- makes a Tuesday mistake found on Wednesday harmless.
CREATE TABLE commission_lines (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL COMMENT 'the salesperson',
  kind            ENUM('drop','commission','total_loss','recovery','adjustment') NOT NULL,
  amount_cents    BIGINT        NOT NULL COMMENT 'signed. recovery and some adjustments are negative',
  basis_cents     BIGINT        NOT NULL DEFAULT 0 COMMENT 'what the percentage was taken of',
  rate_pct        DECIMAL(6,3)  NOT NULL DEFAULT 0,
  trigger_key     ENUM('arrived','approval','car_gone','file_closed') NULL COMMENT 'the stamp that released it',
  earned_at       DATETIME      NOT NULL COMMENT 'the trigger date — what the period is worked out from',
  period_end      DATE          NOT NULL COMMENT 'last day of the pay period it falls in',
  run_id          BIGINT UNSIGNED NULL,
  paid_at         DATETIME      NULL,
  paid_cents      BIGINT        NULL COMMENT 'what was actually handed over, as reported',
  supersedes_id   BIGINT UNSIGNED NULL COMMENT 'the paid line this adjustment corrects',
  note            VARCHAR(255)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_cl_person (user_id, period_end),
  KEY ix_cl_ro (ro_id, kind),
  KEY ix_cl_unpaid (paid_at, period_end),
  CONSTRAINT fk_cl_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row each time the report is run and paid. Running it is free and
-- repeatable; paying is what closes the lines.
CREATE TABLE commission_runs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  period_end    DATE          NOT NULL,
  run_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  run_by        BIGINT UNSIGNED NULL,
  run_by_name   VARCHAR(120)  NULL,
  paid_at       DATETIME      NULL,
  total_cents   BIGINT        NOT NULL DEFAULT 0,
  people        INT           NOT NULL DEFAULT 0,
  note          VARCHAR(255)  NULL,
  KEY ix_run_period (period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  -- Last day of the pay period. Shop-wide, never per person: books close this
  -- evening, the report runs the next day, the money goes out after that.
  ('pay_period_end', 'tuesday'),
  -- Used by the 'tax' deduction, which has no column on the file.
  ('sales_tax_rate', '8.25')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
