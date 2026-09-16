-- 026 — tagging somebody in a note.
--
-- From the demo, 15 Sep 2026. Write a note on a file, tag a person, they get it
-- in their inbox, and the file carries a red mark until it is answered.
--
-- ONE ROW PER MENTION, not per file. Two people tagged is two rows, each
-- clearing when that person writes; the file's mark goes when the last one
-- does. A per-file flag could not express "Ray answered, Denise has not".
--
-- WHAT CLEARS IT, decided with the shop: the tagged person opens the file AND
-- LEAVES A NOTE. Opening alone does not count — "I saw it" is not "I dealt with
-- it", and a marker that clears on a glance is a marker nobody trusts. The note
-- is the evidence, and it is already the thing the next person reads.
--
-- `cleared_note_id` records WHICH note did it, so the history reads as a
-- question and an answer rather than a flag that blinked off.
--
-- The clock is ACTUAL hours, not shop hours (decided the same day, same
-- reasoning as the sales onboarding clock): a Friday evening mention needs
-- answering on Saturday, and a clock that waits for Monday is not a reminder.

CREATE TABLE IF NOT EXISTS ro_mentions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id          BIGINT UNSIGNED NOT NULL,
  note_id        BIGINT UNSIGNED NOT NULL COMMENT 'the note that did the tagging',
  user_id        BIGINT UNSIGNED NOT NULL COMMENT 'who was tagged',
  by_user_id     BIGINT UNSIGNED NULL     COMMENT 'who tagged them',
  by_user_name   VARCHAR(120)  NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Answered: they wrote a note on this file.
  cleared_at     DATETIME      NULL,
  cleared_note_id BIGINT UNSIGNED NULL,

  -- The 24-hour nudge. Stamped so it goes out once and not on every sweep.
  reminded_at    DATETIME      NULL,

  KEY ix_mention_open (ro_id, cleared_at),
  KEY ix_mention_person (user_id, cleared_at),
  -- The sweeper's query: open, un-reminded, oldest first.
  KEY ix_mention_due (cleared_at, reminded_at, created_at),
  CONSTRAINT fk_mention_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The two numbers, so a shop can change them without a deploy. Hours, because
-- a mention is answered in hours or it is not being answered.
INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('mention_remind_hours', '24'),
  ('mention_overdue_hours', '48')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- A mention is its own notification event, so it can be switched on and off
-- separately from the board's chatter.
ALTER TABLE notifications
  MODIFY COLUMN event_key VARCHAR(40) NOT NULL;
