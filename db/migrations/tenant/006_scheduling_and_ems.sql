-- 006 — the insurance an import already knew, time an employee is off,
-- and the shop's Google Calendar link.

-- ---------------------------------------------------------------- EMS carry
-- The parser reads all of this and the upload response showed it, but the row
-- kept only the claim number, so it vanished the moment the drawer was
-- reopened from the database. Keep what the estimate actually said.
ALTER TABLE ems_imports
  ADD COLUMN insurer_name      VARCHAR(190) NULL AFTER claim_number,
  ADD COLUMN policy_number     VARCHAR(64)  NULL AFTER insurer_name,
  ADD COLUMN deductible_cents  BIGINT       NULL AFTER policy_number,
  ADD COLUMN deductible_waived TINYINT(1)   NOT NULL DEFAULT 0 AFTER deductible_cents,
  ADD COLUMN date_of_loss      DATE         NULL AFTER deductible_waived,
  ADD COLUMN adjuster          VARCHAR(120) NULL AFTER date_of_loss,
  ADD COLUMN estimator         VARCHAR(120) NULL AFTER adjuster,
  ADD COLUMN vehicle_color     VARCHAR(48)  NULL AFTER vehicle_text,
  ADD COLUMN plate             VARCHAR(16)  NULL AFTER vehicle_color,
  ADD COLUMN plate_state       VARCHAR(8)   NULL AFTER plate,
  ADD COLUMN mileage           INT          NULL AFTER plate_state;

-- ------------------------------------------------------ employee time off
-- Separate from bookings on purpose: this is not an appointment type, it is a
-- layer over the week saying a person is not available. A block is a date
-- range; leaving the times null means the whole of those days.
CREATE TABLE employee_time_off (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  display_name  VARCHAR(120)  NOT NULL COMMENT 'copied so the block reads right if the person leaves',
  starts_on     DATE          NOT NULL,
  ends_on       DATE          NOT NULL COMMENT 'inclusive',
  start_time    TIME          NULL COMMENT 'null = from the start of the day',
  end_time      TIME          NULL COMMENT 'null = to the end of the day',
  reason        VARCHAR(120)  NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_name  VARCHAR(120)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at  DATETIME      NULL,
  KEY ix_off_span (starts_on, ends_on),
  KEY ix_off_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who the appointment belongs to, so a booking can collide with time off or
-- with another booking for the same person.
ALTER TABLE appointments
  ADD COLUMN assigned_user_id BIGINT UNSIGNED NULL AFTER created_by,
  ADD COLUMN override_note VARCHAR(255) NULL
    COMMENT 'what was overridden when this was booked over a conflict';

CREATE INDEX ix_appt_assigned ON appointments (assigned_user_id, starts_at);

-- --------------------------------------------------------- Google Calendar
-- One connection per shop, authorised once by the owner. Push only: we write
-- appointments out to Google and never read anything back.
CREATE TABLE calendar_connections (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider       VARCHAR(24)   NOT NULL DEFAULT 'google',
  calendar_id    VARCHAR(190)  NULL COMMENT 'which calendar appointments land on',
  calendar_name  VARCHAR(190)  NULL,
  account_email  VARCHAR(190)  NULL,
  access_token   TEXT          NULL,
  refresh_token  TEXT          NULL,
  expires_at     DATETIME      NULL,
  state          ENUM('connected','error','disconnected') NOT NULL DEFAULT 'connected',
  last_error     VARCHAR(255)  NULL,
  last_push_at   DATETIME      NULL,
  connected_by   BIGINT UNSIGNED NULL,
  connected_name VARCHAR(120)  NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cal_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
