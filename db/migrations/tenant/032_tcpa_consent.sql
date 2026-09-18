-- 032 — TCPA consent: the record that somebody agreed to be contacted.
--
-- Raised 17 Sep 2026, the day after the booking form shipped. The form was
-- collecting a phone number and promising contact, and nothing recorded that
-- the customer had agreed to any of it.
--
-- TWO KINDS, and conflating them is the mistake this schema exists to prevent:
--
--   * MARKETING consent is the ticked box. Express, written, revocable, and
--     under TCPA it **cannot be a condition of the sale** — so the booking
--     works whether or not it is ticked. The shop's own disclosure says as
--     much, and a required box would make the disclosure a lie.
--
--   * TRANSACTIONAL consent is implied by the act of booking, and is
--     deliberately NARROW: messages about the car they just booked, and
--     nothing after it is delivered. It is recorded as its own row rather than
--     assumed, so "why did we text this person" always has an answer.
--
-- A ROW IS NEVER DELETED and never edited. Revoking sets `revoked_at`. The
-- whole value of this table is that it says what was true at a moment, and a
-- table you can rewrite is not evidence.

-- ------------------------------------------------------------- the evidence
--
-- Keyed on the DESTINATION, like `suppressions` and for the same reason:
-- editing a client, deleting one, or re-importing an estimate must not change
-- what somebody consented to. A phone number is the thing that was consented
-- for.
--
-- `wording_shown` is the load-bearing column. "They ticked a box" is worth
-- very little on its own — what matters is what the box SAID at the time, and
-- the shop will reword it over the years. So the full text is copied in on
-- every row rather than referenced, because a reference would follow the edit.
CREATE TABLE IF NOT EXISTS consents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind           ENUM('marketing','transactional') NOT NULL,
  channel        ENUM('sms','email') NOT NULL,
  destination    VARCHAR(190) NOT NULL COMMENT 'normalised the same way suppressions are: digits, or lowercased address',
  granted        TINYINT(1)   NOT NULL COMMENT '0 is a real record — they were asked and declined',
  source         VARCHAR(32)  NOT NULL DEFAULT 'web_form',
  -- What they were actually shown. Copied, not referenced.
  wording_shown  TEXT         NULL,
  boxes_ticked   VARCHAR(255) NULL COMMENT 'which boxes, by key, as submitted',
  page_url       VARCHAR(400) NULL,
  submit_ip      VARCHAR(64)  NULL,
  user_agent     VARCHAR(255) NULL,
  -- The whole submission, so the record stands alone if the lead is later
  -- edited, converted, or purged under retention.
  submission     TEXT         NULL COMMENT 'JSON copy of what was submitted alongside',
  funnel_request_id BIGINT UNSIGNED NULL,
  -- Transactional only: the scope. A transactional consent is good for THIS
  -- car and expires when it goes out of the door, which is what keeps it from
  -- quietly becoming a standing permission.
  ro_id          BIGINT UNSIGNED NULL,
  appointment_id BIGINT UNSIGNED NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at     DATETIME     NULL,
  revoked_reason VARCHAR(64)  NULL COMMENT 'stop, unsubscribe, delivered, desk',
  KEY ix_consent_dest (channel, destination, kind, revoked_at),
  KEY ix_consent_req (funnel_request_id),
  KEY ix_consent_ro (ro_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------- the wording
--
-- The shop writes it. Their liability, their words — and their shop name in
-- it, which is one reason it cannot be ours.
--
-- It ships with the wording drafted 17 Sep 2026 as a STARTING POINT with the
-- shop name left blank, not as a default they can ignore: `body` must be
-- edited before the form will switch on. A blank box that refuses six attempts
-- while the shop guesses which four phrases we want is how a feature gets
-- written off as broken, and the draft already contains all four.
--
-- What is checked, loosely, on save:
--   · a way to opt out (STOP)
--   · a way to get help (HELP)
--   · that message and data rates may apply
--   · that consent is not a condition of purchase
--
-- Loose on purpose. "Text STOP to quit" has met the requirement; refusing it
-- because it does not match a template would teach shops to paste words they
-- have not read.
CREATE TABLE IF NOT EXISTS funnel_consent (
  id            TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  label         VARCHAR(190) NOT NULL DEFAULT 'Text me about my repair.'
                COMMENT 'the line beside the checkbox',
  body          TEXT         NULL COMMENT 'the disclosure. NULL means nobody has written it yet',
  privacy_url   VARCHAR(400) NULL COMMENT 'the SHOP''s own privacy policy',
  terms_url     VARCHAR(400) NULL COMMENT 'the SHOP''s own terms',
  approved_at   DATETIME     NULL COMMENT 'when the shop last saved it; the form will not run without this',
  approved_by   BIGINT UNSIGNED NULL,
  approved_name VARCHAR(120) NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The draft, with the shop name deliberately left as a blank to fill. Saving
-- it unchanged is refused by the route, so a shop cannot ship a form that
-- names nobody.
INSERT INTO funnel_consent (id, label, body) VALUES (1,
  'Text me about my repair.',
  'I agree to receive text messages from ______ at the number provided, including repair updates, estimate and appointment notifications, and occasional service messages. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.')
ON DUPLICATE KEY UPDATE id = id;

-- What the customer answered, on the request itself, so the queue can show it
-- without a join. The consent ROW is still the record; this is a convenience.
ALTER TABLE funnel_requests ADD COLUMN sms_consent TINYINT(1) NULL
  COMMENT 'NULL = asked before consent shipped; 0 = asked and declined; 1 = agreed';
ALTER TABLE funnel_requests ADD COLUMN consent_id BIGINT UNSIGNED NULL;
