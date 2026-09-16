-- 024 — shop hours, as a table rather than a guess.
--
-- The shop already knew which DAYS it was shut (`closed_days`, a comma-separated
-- list of day names) and nothing about what TIME it opened. That was enough for
-- the drop-capacity screen, which only counts days, and not enough for anything
-- that measures elapsed working time — the sales onboarding clock, and the
-- scheduler refusing a booking at 9pm.
--
-- One row per weekday. `dow` follows MySQL's DAYOFWEEK() - 1, so 0 = Sunday
-- through 6 = Saturday, which is what the queries can compare against without
-- arithmetic anybody has to think about.
--
-- A closed day keeps its times rather than nulling them: a shop that shuts
-- Saturdays for winter and reopens in spring gets its hours back rather than
-- retyping them.

CREATE TABLE IF NOT EXISTS shop_hours (
  dow         TINYINT UNSIGNED NOT NULL COMMENT '0 = Sunday … 6 = Saturday',
  open_time   TIME    NOT NULL DEFAULT '08:00:00',
  close_time  TIME    NOT NULL DEFAULT '17:00:00',
  closed      TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (dow)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Monday to Friday, eight to five, weekend off. A shop that works differently
-- changes it in Admin › Settings; this is only a starting point.
INSERT INTO shop_hours (dow, open_time, close_time, closed) VALUES
  (0, '08:00:00', '17:00:00', 1),
  (1, '08:00:00', '17:00:00', 0),
  (2, '08:00:00', '17:00:00', 0),
  (3, '08:00:00', '17:00:00', 0),
  (4, '08:00:00', '17:00:00', 0),
  (5, '08:00:00', '17:00:00', 0),
  (6, '08:00:00', '12:00:00', 1)
ON DUPLICATE KEY UPDATE dow = dow;

-- Carry across whatever the shop already told us. `closed_days` stays readable
-- so nothing that reads it breaks today, but this table is now the truth and
-- the settings screen writes both.
UPDATE shop_hours h
   JOIN (SELECT setting_value AS v FROM shop_settings WHERE setting_key = 'closed_days') s
   SET h.closed = 1
 WHERE LOCATE(
   CASE h.dow WHEN 0 THEN 'sunday' WHEN 1 THEN 'monday' WHEN 2 THEN 'tuesday'
              WHEN 3 THEN 'wednesday' WHEN 4 THEN 'thursday' WHEN 5 THEN 'friday'
              ELSE 'saturday' END,
   LOWER(s.v)) > 0;

-- And the reverse: a day NOT named in closed_days is open, so a shop that had
-- already set Saturday as a working day keeps it.
UPDATE shop_hours h
   JOIN (SELECT setting_value AS v FROM shop_settings WHERE setting_key = 'closed_days') s
   SET h.closed = 0
 WHERE s.v <> '' AND LOCATE(
   CASE h.dow WHEN 0 THEN 'sunday' WHEN 1 THEN 'monday' WHEN 2 THEN 'tuesday'
              WHEN 3 THEN 'wednesday' WHEN 4 THEN 'thursday' WHEN 5 THEN 'friday'
              ELSE 'saturday' END,
   LOWER(s.v)) = 0;
