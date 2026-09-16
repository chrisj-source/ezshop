-- 027 — automatic chase messages on a lead nobody has touched.
--
-- Decided 15 Sep 2026. The leads screen already FLAGGED a quiet lead; nothing
-- ever told anybody. A flag only works for somebody already looking at the
-- screen, which is the person least likely to need telling.
--
-- Two clocks, because two kinds of lead:
--
--   * a lead written on the SALES screen — 12 hours. Somebody stood in front
--     of the customer and the car is expected; it is waiting on an onboarding
--     call that should already have happened.
--   * everything else — 72 hours, which is the same three days the on-screen
--     flag already uses, so the row turning red and the message going out are
--     the same moment rather than two numbers that drift apart.
--
-- Both in HOURS and both on the actual clock, not shop hours: the same call as
-- the onboarding clock and the mention reminder.
--
-- Who hears about it: the person who OWNS the lead, and FRONT OFFICE. The owner
-- because it is theirs; front office because a lead with no owner, or an owner
-- who is off, still has to be somebody's problem.

ALTER TABLE leads ADD COLUMN chase_notified_at DATETIME NULL
  COMMENT 'the automatic chase message went out. Cleared when the lead is chased.';

ALTER TABLE leads ADD KEY ix_lead_chase (state, deleted_at, chase_notified_at, received_at);

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('lead_chase_hours', '72')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- A shop that already took this migration when the default was 48 gets moved,
-- but only if nobody has since chosen their own figure.
UPDATE shop_settings SET setting_value = '72'
 WHERE setting_key = 'lead_chase_hours' AND setting_value = '48';
