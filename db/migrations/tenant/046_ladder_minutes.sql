-- 046 — the escalation ladder in minutes, so Internet can be 15m · 1h · 4h as decided.
-- The hour columns stay for older code paths; minutes win when set.
ALTER TABLE lead_lanes ADD COLUMN IF NOT EXISTS step1_min INT NULL;
ALTER TABLE lead_lanes ADD COLUMN IF NOT EXISTS step2_min INT NULL;
ALTER TABLE lead_lanes ADD COLUMN IF NOT EXISTS step3_min INT NULL;
UPDATE lead_lanes SET step1_min = 15,   step2_min = 60,   step3_min = 240  WHERE lane_key = 'internet' AND step1_min IS NULL AND step1_hours = 1 AND step2_hours = 2;
UPDATE lead_lanes SET step1_min = 60,   step2_min = 240,  step3_min = 1440 WHERE lane_key = 'phone'    AND step1_min IS NULL AND step1_hours = 24 AND step2_hours = 48;
UPDATE lead_lanes SET step1_min = 240,  step2_min = 1440, step3_min = 2880 WHERE lane_key = 'referral' AND step1_min IS NULL AND step1_hours = 24 AND step2_hours = 48;
UPDATE lead_lanes SET step1_min = 1440, step2_min = 2880, step3_min = 4320 WHERE lane_key IN ('walkin','field') AND step1_min IS NULL;
UPDATE lead_lanes SET step1_min = step1_hours * 60, step2_min = step2_hours * 60, step3_min = step3_hours * 60 WHERE step1_min IS NULL;

-- Which sales managers a lane's round robin goes to. NULL = all of them.
ALTER TABLE lead_lanes ADD COLUMN IF NOT EXISTS rr_users VARCHAR(400) NULL COMMENT 'comma list of user ids';
