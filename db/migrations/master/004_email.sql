-- 004 — email, per person.
--
-- Everybody already gets the in-app copy of a notification. This is the one
-- that also leaves the building, and it is **off until somebody asks for it**:
-- an inbox nobody wanted is how a shop decides to ignore all of it.
--
-- `last_email_at` is the throttle. A busy afternoon can raise a dozen
-- notifications for one person; a dozen emails about them is the same mistake
-- from the other end.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_opt_in TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'mirror notifications to email; off until they ask' AFTER phone,
  ADD COLUMN IF NOT EXISTS last_email_at DATETIME NULL
    COMMENT 'throttle stamp — one notification email per person per window';
