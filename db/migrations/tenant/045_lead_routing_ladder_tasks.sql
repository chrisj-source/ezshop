-- 045 — who a new lead goes to, the escalation ladder, notification groups,
-- teams, and callbacks (the one task a person makes). One ADD COLUMN per statement.

CREATE TABLE IF NOT EXISTS notify_groups (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(80)   NOT NULL,
  system_key  VARCHAR(32)   NULL COMMENT 'sales_managers: follows the capability, not edited by hand',
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ngroup_sys (system_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notify_group_members (
  group_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (group_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO notify_groups (name, system_key) VALUES ('Sales managers', 'sales_managers')
ON DUPLICATE KEY UPDATE name = name;

-- One row per pipeline lane (lib/pipeline.ts LANES).
CREATE TABLE IF NOT EXISTS lead_lanes (
  lane_key        VARCHAR(16)   NOT NULL PRIMARY KEY,
  route_mode      ENUM('managers_rr','group_rr','person','writer') NOT NULL DEFAULT 'managers_rr',
  route_group_id  BIGINT UNSIGNED NULL,
  route_user_id   BIGINT UNSIGNED NULL,
  rr_last_user_id BIGINT UNSIGNED NULL,
  step1_hours     INT           NOT NULL DEFAULT 24 COMMENT 'step 1 is always the lead owner',
  step2_hours     INT           NOT NULL DEFAULT 48,
  step2_group_id  BIGINT UNSIGNED NULL COMMENT 'NULL = sales managers',
  step3_hours     INT           NOT NULL DEFAULT 72 COMMENT 'step 3 tells the owner',
  chase_quote_days INT          NOT NULL DEFAULT 3,
  statuses_off    VARCHAR(400)  NULL COMMENT 'comma list of lane statuses switched off',
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO lead_lanes (lane_key, route_mode, step1_hours, step2_hours, step3_hours, chase_quote_days) VALUES
  ('internet', 'managers_rr', 1, 2, 6, 2),
  ('walkin',   'managers_rr', 48, 96, 144, 3),
  ('phone',    'managers_rr', 24, 48, 96, 3),
  ('referral', 'managers_rr', 24, 48, 96, 3),
  ('field',    'writer',      24, 48, 96, 3)
ON DUPLICATE KEY UPDATE lane_key = lane_key;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS esc_step TINYINT NOT NULL DEFAULT 0 COMMENT 'ladder step reached since the last touch';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS esc_step_at DATETIME NULL;

CREATE TABLE IF NOT EXISTS teams (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(80)   NOT NULL,
  manager_user_id  BIGINT UNSIGNED NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS team_members (
  user_id   BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'a person is in one team',
  team_id   BIGINT UNSIGNED NOT NULL,
  KEY ix_tm_team (team_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_callbacks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NULL COMMENT 'whose task',
  due_at      DATETIME      NOT NULL,
  note        VARCHAR(255)  NULL,
  done_at     DATETIME      NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cb_open (done_at, due_at),
  KEY ix_cb_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
