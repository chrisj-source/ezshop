-- 009 — leads that go quiet.
--
-- A lead nobody has touched needs chasing, but a lead with an appointment on
-- the calendar does not — they are booked, that IS the follow-up. So the flag
-- is: nothing done for N days AND nothing on the schedule for them.
--
-- N is the shop's own number. Three days suits a shop that works its leads
-- hard; two weeks suits one that does not.
ALTER TABLE leads
  -- The follow-up clock. Reset by whoever says they chased it, so the lead goes
  -- quiet again for another N days rather than nagging every load.
  ADD COLUMN last_followup_at DATETIME NULL AFTER first_reply_at,
  ADD COLUMN followup_snooze_until DATE NULL COMMENT 'set by hand to hold it longer' AFTER last_followup_at;

-- Finding a lead's appointments is now on the hot path of the leads list.
CREATE INDEX ix_appt_lead ON appointments (lead_id, starts_at);

-- A chase and a booking are human actions, not the system talking, so the
-- history should be able to say which it was.
ALTER TABLE lead_events
  MODIFY COLUMN kind ENUM('note','auto','followup','appointment') NOT NULL DEFAULT 'note';

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  -- Days of silence before a lead is flagged for follow-up.
  ('lead_followup_days', '3'),
  -- How far ahead an appointment counts as "they are booked, leave them alone".
  ('lead_appointment_window_days', '30')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
