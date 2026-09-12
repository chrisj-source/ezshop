-- 005 — which events are worth an email.
--
-- One switch for "email me" was the wrong shape. Eight kinds of notification go
-- through `notify()`, and they are not remotely equal: an assignment is worth
-- an interruption, a status change on somebody else's car is not. Left as one
-- switch, the honest response is to turn it off — and then the useful ones stop
-- arriving too.
--
-- So: a row per person per event, and **absent means off**. Switching email on
-- at all now turns on a small starting set rather than everything, and the rest
-- is theirs to choose.
--
-- `scope` exists for one event. `status.change` fires on every status move on
-- every file — dozens a day in a busy shop — so it carries a choice the others
-- do not need: every file, or only the ones this person is assigned to.
CREATE TABLE IF NOT EXISTS user_email_events (
  user_id     BIGINT UNSIGNED NOT NULL,
  event_key   VARCHAR(40)   NOT NULL,
  enabled     TINYINT(1)    NOT NULL DEFAULT 1,
  scope       ENUM('all','mine') NOT NULL DEFAULT 'mine'
              COMMENT 'status.change only: every file, or the ones they are on',
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, event_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Anyone who already switched email on gets the starting set, not the lot.
-- They asked for email when email meant everything, so the quiet default is
-- the safer reading of that consent.
INSERT IGNORE INTO user_email_events (user_id, event_key, enabled, scope)
SELECT u.id, e.k, 1, 'mine'
  FROM users u
  JOIN (SELECT 'assign.file' AS k UNION ALL
        SELECT 'supp.decision' UNION ALL
        SELECT 'age.red' UNION ALL
        SELECT 'sms.reply') e
 WHERE u.email_opt_in = 1;
