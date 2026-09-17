-- 029 — sublet as a scheduled movement, and who is carrying the car.
--
-- From the demo, 15 Sep 2026: book a return, a pickup or a sublet from inside
-- the file rather than going to the schedule screen and re-typing the car.
--
-- `pickup` and `return` already existed as appointment kinds. `sublet` did
-- not, even though the board has had a sublet lane since migration 010 — so a
-- car could be IN sublet with no record of when it went or when it is due back.
--
-- One ADD COLUMN per statement, per CLAUDE.md: a multi-clause ALTER is atomic,
-- so one already-present column discards its siblings.

ALTER TABLE appointments
  MODIFY COLUMN kind ENUM('drop','pickup','return','estimate','appraiser','sublet') NOT NULL;

-- Who is moving the car. A transporter on a pickup, the vendor on a sublet.
-- Free text rather than a join: a sublet vendor is often a shop down the road
-- that will never be a row in this database, and forcing one would mean nobody
-- fills it in.
ALTER TABLE appointments ADD COLUMN carrier VARCHAR(120) NULL
  COMMENT 'transport company or sublet vendor';

-- When a sublet is expected back. Only meaningful on kind = sublet; a null here
-- on a sublet is the honest "nobody knows yet" rather than a guess.
ALTER TABLE appointments ADD COLUMN due_back DATE NULL
  COMMENT 'sublet only: when the vendor says it is coming back';

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('cap_sublet', '0')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
