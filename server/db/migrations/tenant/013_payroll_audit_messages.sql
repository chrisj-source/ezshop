-- 013 — payroll for the non-sales week, a readable audit log, and messages that
-- can be deleted.
--
-- Three things that all hang off records that already exist. Payroll reads
-- `ro_labour` — what the desk punched in at close — and never restates it.
-- The audit log is the table we have been writing to since the beginning; this
-- gives it the columns a reader needs. Messages are `notifications`, one row per
-- recipient already, which is exactly what a per-person delete and a future SMS
-- or email send both need.
--
-- One ALTER per column throughout: a multi-column ALTER is a single statement,
-- so one already-present column makes the runner skip the whole thing and the
-- rest never land.

-- ===========================================================================
-- Messages
-- ===========================================================================
--
-- Deleting is per recipient and never destroys anything. The row stays, the
-- person's list stops showing it, and the audit log keeps the fact that it was
-- sent. A message with three subscribers is three rows; one person deleting
-- theirs has no effect on the other two.
ALTER TABLE notifications ADD COLUMN deleted_at DATETIME NULL COMMENT 'hidden from this recipient, never removed';
ALTER TABLE notifications ADD COLUMN dispatch_state ENUM('app','queued','sent','failed') NOT NULL DEFAULT 'app'
  COMMENT 'the app row always exists; this is how the outside channels are going';

-- Every attempt to put a message in front of somebody, in-app included. SMS and
-- email become rows here rather than a parallel system: the message already
-- exists, addressed to a person, so a send is one more delivery on it.
CREATE TABLE notification_deliveries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notification_id BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL COMMENT 'denormalised: who it was for, so a purge of old messages leaves the trail',
  channel         ENUM('app','email','sms') NOT NULL,
  address         VARCHAR(190)  NULL COMMENT 'the email or number as it was at send time',
  state           ENUM('pending','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  provider_ref    VARCHAR(120)  NULL,
  error           VARCHAR(255)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at         DATETIME      NULL,
  KEY ix_deliv_note (notification_id),
  KEY ix_deliv_user (user_id, created_at),
  CONSTRAINT fk_deliv_note FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Everything already in the inbox was delivered in-app and nowhere else.
INSERT INTO notification_deliveries (notification_id, user_id, channel, state, created_at, sent_at)
SELECT id, user_id, 'app', 'sent', created_at, created_at FROM notifications;

-- ===========================================================================
-- Audit log
-- ===========================================================================
--
-- The table is old; what it lacked was everything a reader needs. `changes`
-- carries field-level before and after so a row can be read without knowing the
-- shape of `detail`. `actor_role` is the role held AT THE TIME, which is the
-- whole point of recording it — roles change. `sensitive` is money, deletes and
-- permission changes, marked at write time so the screen never has to guess.
ALTER TABLE audit_log ADD COLUMN actor_role VARCHAR(64) NULL COMMENT 'primary role label at the time';
ALTER TABLE audit_log ADD COLUMN area VARCHAR(32) NULL COMMENT 'what the reader filters on: money, parts, documents…';
ALTER TABLE audit_log ADD COLUMN ro_id BIGINT UNSIGNED NULL COMMENT 'the file this touched, when there is one';
ALTER TABLE audit_log ADD COLUMN label VARCHAR(190) NULL COMMENT 'one line, already written for a human';
ALTER TABLE audit_log ADD COLUMN changes JSON NULL COMMENT '[{field, from, to}]';
ALTER TABLE audit_log ADD COLUMN note VARCHAR(500) NULL COMMENT 'what the person wrote with the change, if anything';
ALTER TABLE audit_log ADD COLUMN sensitive TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE audit_log ADD COLUMN source VARCHAR(24) NOT NULL DEFAULT 'web' COMMENT 'web, mobile, ems, system';
ALTER TABLE audit_log ADD COLUMN client VARCHAR(190) NULL COMMENT 'user agent and address, as recorded';

ALTER TABLE audit_log ADD KEY ix_audit_when (created_at);
ALTER TABLE audit_log ADD KEY ix_audit_actor (user_id, created_at);
ALTER TABLE audit_log ADD KEY ix_audit_ro (ro_id, created_at);
ALTER TABLE audit_log ADD KEY ix_audit_sensitive (sensitive, created_at);

-- Old rows have no area and no label. Give them the ones their entity implies so
-- the screen reads as one list rather than a new list on top of a blank one.
UPDATE audit_log SET area = 'Repair order' WHERE area IS NULL AND entity = 'repair_order';
UPDATE audit_log SET area = 'Lead'         WHERE area IS NULL AND entity = 'lead';
UPDATE audit_log SET area = 'Money'        WHERE area IS NULL AND entity IN ('pay_plan', 'commission_run');
UPDATE audit_log SET area = 'Permissions'  WHERE area IS NULL AND entity IN ('role', 'staff');
UPDATE audit_log SET area = 'Setup'        WHERE area IS NULL AND entity IN ('status', 'time_off');
UPDATE audit_log SET area = 'Repair order' WHERE area IS NULL;
UPDATE audit_log SET ro_id = entity_id WHERE ro_id IS NULL AND entity = 'repair_order';
UPDATE audit_log SET sensitive = 1
 WHERE sensitive = 0 AND (area IN ('Money', 'Permissions')
    OR action IN ('void', 'delete', 'removed', 'close_undo', 'total_loss_undo'));

-- ===========================================================================
-- Payroll — the non-sales week
-- ===========================================================================
--
-- Sales has its own period and its own ledger. This is everyone else: the techs,
-- paid by the car or on a salary, closed out on the shop's chosen evening so
-- cheques can be cut the same night.
--
-- Two settings, both the shop's to change:
--   payroll_close_day  — the day the week closes on
--   payroll_cutoff     — the time on that day after which a file waits a week
INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('payroll_close_day', 'wednesday'),
  ('payroll_cutoff', '16:00')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- How a person is paid on this screen. Separate from `pay_basis`, which is how
-- their work is COSTED on a file — a tech on a salary is still costed at their
-- hourly rate in the close-out, because the file's profit is a different
-- question from what the person is owed.
ALTER TABLE staff ADD COLUMN pay_mode ENUM('per_car','salary') NOT NULL DEFAULT 'per_car';
ALTER TABLE staff ADD COLUMN salary_cents BIGINT NOT NULL DEFAULT 0 COMMENT 'per period, when pay_mode is salary';

-- A run is a period that has been settled. Re-running before it is paid is free;
-- once paid, the sheets in it are what was paid, and a later correction shows up
-- on the next period as its own line rather than rewriting this one.
CREATE TABLE payroll_runs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  period_end    DATE          NOT NULL,
  cutoff_at     DATETIME      NOT NULL COMMENT 'the exact moment the period closed',
  run_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  run_by        BIGINT UNSIGNED NULL,
  run_by_name   VARCHAR(120)  NULL,
  paid_at       DATETIME      NULL,
  total_cents   BIGINT        NOT NULL DEFAULT 0,
  people        INT           NOT NULL DEFAULT 0,
  UNIQUE KEY uq_payroll_period (period_end),
  KEY ix_payroll_paid (paid_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per person per run: what they were paid and on what basis, frozen.
-- The car list is rebuilt from `ro_labour` for an unpaid period and read from
-- `payroll_run_cars` once paid, so a paid sheet can be reprinted exactly.
CREATE TABLE payroll_run_people (
  run_id        BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  display_name  VARCHAR(120)  NULL,
  pay_mode      ENUM('per_car','salary') NOT NULL,
  salary_cents  BIGINT        NOT NULL DEFAULT 0,
  cars          INT           NOT NULL DEFAULT 0,
  hours         DECIMAL(8,2)  NOT NULL DEFAULT 0,
  total_cents   BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, user_id),
  CONSTRAINT fk_prp_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payroll_run_cars (
  run_id        BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  ro_id         BIGINT UNSIGNED NOT NULL,
  position_key  VARCHAR(24)   NOT NULL,
  basis         ENUM('hours','flat','ems','pct') NOT NULL,
  hours         DECIMAL(7,2)  NOT NULL DEFAULT 0,
  rate_cents    BIGINT        NOT NULL DEFAULT 0,
  cost_cents    BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, user_id, ro_id, position_key),
  KEY ix_prc_ro (ro_id),
  CONSTRAINT fk_prc_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reading the audit log is its own capability, so a shop can hand it to a
-- manager without handing over the rest of Admin. Nothing is granted here: the
-- owner already holds everything, and the shop ticks the rest.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'audit', 1, 0 FROM roles WHERE locked = 'owner'
ON DUPLICATE KEY UPDATE can_see = 1;
