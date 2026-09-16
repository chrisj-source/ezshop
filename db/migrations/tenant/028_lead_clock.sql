-- 028 — one clock for a quiet lead.
--
-- Two settings described the same thing and could disagree:
--
--   lead_followup_days   the on-screen flag. 3 by default.
--   lead_chase_hours     the automatic message. 72 by default.
--
-- At their defaults they are the same moment, which is why 72 was chosen. But
-- a shop changing one and not the other gets a row that turns red on Tuesday
-- and a message that goes out on Thursday, and no way to tell which is "the"
-- setting. That is a support call waiting to happen.
--
-- `lead_chase_hours` is now the only one. Hours rather than days because the
-- sales clock is already in hours (12) and a shop should be able to say "one
-- working day" without inventing a fraction.
--
-- A shop that had customised the days figure keeps its own number, converted.
-- A shop that never touched it lands on 72 either way.

UPDATE shop_settings s
   JOIN (SELECT setting_value AS days FROM shop_settings
          WHERE setting_key = 'lead_followup_days') d
   SET s.setting_value = CAST(d.days AS UNSIGNED) * 24
 WHERE s.setting_key = 'lead_chase_hours'
   AND d.days REGEXP '^[0-9]+$'
   AND CAST(d.days AS UNSIGNED) BETWEEN 1 AND 90
   -- Only when the shop actually chose something other than the old default.
   AND d.days <> '3';

-- `lead_followup_days` is left in place rather than dropped: it costs one row,
-- and deleting a setting an older build might still read is how a deploy that
-- gets rolled back turns into a shop with no follow-up flag at all. It is no
-- longer read by anything.
