-- 023 — the sales screen's own rules, as shop settings.
--
-- From the demo, 15 Sep 2026. A lead written on the road is not the same animal
-- as one taken at the counter: somebody has been stood in front of the customer
-- with a phone, the car is expected, and an onboarding call has to happen
-- quickly or the whole thing goes cold. So the sales screen asks for more and
-- chases faster.
--
-- All four are SETTINGS rather than constants, because a shop that does not
-- work that way should be able to turn them off without a deploy. Owner-only to
-- change, like every other row in this table.
--
--   sales_require_address   the address is mandatory on the sales screen.
--                           Deliberately NOT mandatory at check-in or on the
--                           board: a car arriving at the door must never be
--                           blocked because nobody asked for a zip code, and
--                           plenty of wholesale vehicles have no retail
--                           customer at all.
--
--   sales_require_drop      a drop appointment must be booked, or the customer
--                           must be marked as self-delivering. "I'll bring it
--                           sometime" is how a sold job becomes a lost one.
--
--   sales_onboard_red_hours hours before an un-chased sales lead goes red.
--                           Twelve by default, against the normal lead clock's
--                           three DAYS, because this one is waiting on a call
--                           that should already have happened.
--
--   sales_onboard_clock     'actual' — real elapsed hours, decided 15 Sep 2026.
--                           Not shop hours: a Friday evening sale needs the
--                           call on Saturday, and a clock that politely waits
--                           for Monday defeats the point. Kept as a setting so
--                           the decision is visible and reversible rather than
--                           buried in code.

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('sales_require_address',   '1'),
  ('sales_require_drop',      '1'),
  ('sales_onboard_red_hours', '12'),
  ('sales_onboard_clock',     'actual')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
