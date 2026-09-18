-- 031 — web funnels: a form on the shop's own website, into Leads and the
-- scheduler. Decided 17 Sep 2026; the decisions are in QUEUE.md.
--
-- Three things this is NOT, because each was considered and rejected:
--
--   * Not a page we host. The snippet renders inline into the shop's own div
--     so it inherits their fonts and colours. Nothing here may assume a width.
--   * Not a Zapier client. Zapier bills per task and this is the shop's own
--     site; routing it through an automation would meter for nothing.
--   * Not a second availability engine. Public bookings go through the same
--     `scheduleGuards` a desk booking does. What this adds is a NARROWER public
--     window on top of the shop's real hours, never a wider one.
--
-- One ADD COLUMN per statement throughout — a multi-clause ALTER is atomic, so
-- one already-present column would discard its siblings.

-- ---------------------------------------------------------------- settings
--
-- One row, id = 1. A settings TABLE rather than more shop_settings keys because
-- half of this is colours and numbers that belong together and are read as a
-- unit by a public endpoint on every page load.
CREATE TABLE IF NOT EXISTS funnel_settings (
  id             TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  enabled        TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'off until the owner turns it on',
  offer_estimate TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'booked outright',
  offer_drop     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'requested, and held',
  hold_hours     SMALLINT     NOT NULL DEFAULT 24 COMMENT 'how long a requested slot is held',
  notice_hours   SMALLINT     NOT NULL DEFAULT 2
    COMMENT 'nothing may be booked closer to now than this. Public and desk share the day limit, so without it a stranger takes the last slot at 8:55 for a 9:00',
  -- Both are the owner's, so the form can match their theme. Warn-and-allow on
  -- contrast: see `contrast_ack_*` below.
  accent         CHAR(7)      NOT NULL DEFAULT '#2b2622' COMMENT 'submit button, selected day and time, focus ring',
  accent_ink     CHAR(7)      NOT NULL DEFAULT '#ffffff' COMMENT 'text ON the accent',
  contrast_ack_at   DATETIME  NULL COMMENT 'the owner was warned the pair fails and used it anyway',
  contrast_ack_by   BIGINT UNSIGNED NULL,
  contrast_ack_note VARCHAR(190) NULL COMMENT 'what it measured when they accepted',
  intro          VARCHAR(400) NULL COMMENT 'the line above the form; null uses the shipped one',
  reply_to       VARCHAR(190) NULL COMMENT 'where a customer reply goes; null uses the shop record',
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO funnel_settings (id) VALUES (1)
ON DUPLICATE KEY UPDATE id = id;

-- ----------------------------------------------------------------- domains
--
-- The allowlist. This is the whole security model for a public key: the key
-- says which shop, the Origin says whether this page may use it.
--
-- Stored as a bare host, lowercased, no scheme and no port. `www.` is NOT
-- assumed — a shop whose site answers on both has to name both, because
-- guessing which subdomains of theirs are theirs is not ours to do.
CREATE TABLE IF NOT EXISTS funnel_domains (
  host        VARCHAR(190) NOT NULL PRIMARY KEY COMMENT 'lowercase host only, no scheme, no port',
  added_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  added_by    BIGINT UNSIGNED NULL,
  last_seen_at DATETIME    NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------ public hours
--
-- What the PUBLIC may book, per weekday. This narrows `shop_hours`; it can
-- never widen it. A row that opens earlier than the shop does is clamped at
-- read time rather than refused at write time, because the shop's hours can
-- change afterwards and leave a stored row wider than it was when saved.
--
-- Absent row = that weekday follows the shop's hours exactly.
CREATE TABLE IF NOT EXISTS funnel_hours (
  dow         TINYINT UNSIGNED NOT NULL PRIMARY KEY COMMENT '0 = Sunday … 6 = Saturday',
  blocked     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'no public booking that weekday at all',
  open_time   TIME         NULL COMMENT 'null = the shop''s own open time',
  close_time  TIME         NULL COMMENT 'null = the shop''s own close time'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dated exceptions for the PUBLIC only — the shop is open, the form is not.
--
-- Deliberately separate from `shop_closures`: that table is the shop's real
-- calendar and holidays are regenerated into it each year. A date the owner
-- closed to the public is a marketing decision, not a closure, and must not be
-- swept up when next year's holidays are written.
CREATE TABLE IF NOT EXISTS funnel_blocks (
  on_date     DATE         NOT NULL PRIMARY KEY,
  label       VARCHAR(80)  NOT NULL DEFAULT 'No public booking',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by  BIGINT UNSIGNED NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------- the fields
--
-- The shop builds its own list. Name, phone and email can never be removed —
-- enforced in the route, not here, because a NOT NULL cannot express "these
-- three rows must exist".
--
-- `key_name` is ours for a built-in field and arbitrary for a custom question.
-- A custom question is ALWAYS optional: a shop that makes six of its own
-- required has built a form nobody finishes.
CREATE TABLE IF NOT EXISTS funnel_fields (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  key_name    VARCHAR(40)  NOT NULL,
  label       VARCHAR(120) NOT NULL,
  kind        ENUM('builtin','text','choice','yesno') NOT NULL DEFAULT 'builtin',
  options     VARCHAR(500) NULL COMMENT 'choice only: newline separated',
  purpose     ENUM('both','estimate','drop') NOT NULL DEFAULT 'both'
    COMMENT '"do you need a rental" matters on a drop-off and not on an estimate',
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  required    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'built-in fields only',
  sort_order  SMALLINT     NOT NULL DEFAULT 0,
  UNIQUE KEY uq_funnel_field (key_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The shipped list. ON DUPLICATE KEY UPDATE because provisioning replays
-- migrations and then seeds the shop-type template over the top — a plain
-- INSERT here is the bug that broke shop creation twice on 15 Sep 2026.
INSERT INTO funnel_fields (key_name, label, kind, purpose, enabled, required, sort_order) VALUES
  ('name',     'Your name',              'builtin', 'both',  1, 1, 10),
  ('phone',    'Phone',                  'builtin', 'both',  1, 1, 20),
  ('email',    'Email',                  'builtin', 'both',  1, 1, 30),
  ('contact',  'Best way to reach you',  'builtin', 'both',  1, 0, 40),
  ('vehicle',  'Year, make and model',   'builtin', 'both',  1, 0, 50),
  ('carrier',  'Insurance company',      'builtin', 'both',  1, 0, 60),
  ('claim',    'Claim number',           'builtin', 'both',  1, 0, 70),
  ('what',     'What happened',          'builtin', 'both',  1, 0, 80)
ON DUPLICATE KEY UPDATE label = VALUES(label), sort_order = VALUES(sort_order);

-- ---------------------------------------------------------- the submissions
--
-- The queue the desk works. One row per submission, whatever became of it.
--
-- `state` is the whole lifecycle:
--   booked     an estimate — the time is theirs, nothing to confirm
--   held       a drop-off — the slot is taken while somebody decides
--   confirmed  the desk said yes; the appointment is real
--   declined   the desk said no; the slot is released, the lead stays
--   lapsed     nobody acted inside hold_hours; released, desk told
--
-- A held slot COUNTS against the day's limit. Without that, two people hold the
-- same Tuesday morning and one of them is told no by a person rather than by
-- the form.
CREATE TABLE IF NOT EXISTS funnel_requests (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  purpose        ENUM('estimate','drop') NOT NULL,
  state          ENUM('booked','held','confirmed','declined','lapsed') NOT NULL,
  starts_at      DATETIME     NOT NULL COMMENT 'shop wall clock, like appointments.starts_at',
  hold_until     DATETIME     NULL COMMENT 'held only',
  appointment_id BIGINT UNSIGNED NULL,
  lead_id        BIGINT UNSIGNED NULL,
  client_id      BIGINT UNSIGNED NULL COMMENT 'set when they matched a past customer, and then no lead is raised',
  ro_id          BIGINT UNSIGNED NULL COMMENT 'their car is already in the bay — usually a question, not new work',
  customer_name  VARCHAR(160) NOT NULL,
  phone          VARCHAR(32)  NULL,
  email          VARCHAR(190) NULL,
  contact_pref   VARCHAR(40)  NULL,
  vehicle_text   VARCHAR(160) NULL,
  carrier        VARCHAR(120) NULL,
  claim_number   VARCHAR(64)  NULL,
  what_happened  VARCHAR(600) NULL,
  answers        TEXT         NULL COMMENT 'custom questions, JSON [{label,value}] — copied onto the file as a note when it converts',
  campaign       VARCHAR(60)  NULL,
  page_url       VARCHAR(400) NULL COMMENT 'the shop''s page it was submitted from',
  origin_host    VARCHAR(190) NULL,
  submit_ip      VARCHAR(64)  NULL,
  is_repeat      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'same phone inside a week — its own lead, flagged, never merged',
  conflicted_at  DATETIME     NULL COMMENT 'the hours changed under a held slot; left for a person',
  suppressed     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'the address had unsubscribed: carried, not refused, and no email sent',
  answered_at    DATETIME     NULL,
  answered_by    BIGINT UNSIGNED NULL,
  answered_name  VARCHAR(120) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_freq_state (state, created_at),
  KEY ix_freq_hold (state, hold_until),
  KEY ix_freq_phone (phone, created_at),
  CONSTRAINT fk_freq_appt FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
  CONSTRAINT fk_freq_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------ the letters
--
-- The wording is the SHOP's, per event, with merge tokens. Not one house email
-- with a shop name dropped into it.
CREATE TABLE IF NOT EXISTS funnel_emails (
  event_key   VARCHAR(40)  NOT NULL PRIMARY KEY COMMENT 'estimate_booked, drop_requested, drop_confirmed',
  subject     VARCHAR(190) NOT NULL,
  body        TEXT         NOT NULL,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The defaults, as written 17 Sep 2026. A shop may rewrite them; these are what
-- it starts with rather than an empty box.
INSERT INTO funnel_emails (event_key, subject, body) VALUES
  ('estimate_booked',
   'Your estimate appointment with [ shop name ]',
   'Thank you [ first name ] for reaching out to schedule an estimate appointment for [ appointment date ] at [ appointment time ]. We look forward to evaluating the damage and creating a plan to return your vehicle to pre-loss condition.'),
  ('drop_requested',
   'We have your drop-off request',
   'Thank you [ first name ] for scheduling an appointment to drop off your [ vehicle year ] [ vehicle make ] [ vehicle model ]. Our office will be confirming your appointment soon. Please expect an email or phone call to confirm.'),
  ('drop_confirmed',
   'Your drop-off is confirmed',
   'Your drop-off is confirmed for [ appointment date ] at [ appointment time ]. We will see you then at [ shop address ].')
ON DUPLICATE KEY UPDATE event_key = event_key;

-- Where the shop is and what its number is, for the letters. Not on the
-- company record, which carries the billing identity rather than the address a
-- customer drives to.
INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('shop_address', ''),
  ('shop_phone', '')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- --------------------------------------------------------------- the lead
--
-- Three new facts on a lead, all of them about where it came from. `source`
-- already exists and becomes 'web_form'; these say which page and which link.
ALTER TABLE leads ADD COLUMN campaign VARCHAR(60) NULL
  COMMENT 'the tag on the link the customer followed';
ALTER TABLE leads ADD COLUMN source_url VARCHAR(400) NULL
  COMMENT 'the shop''s own page it was submitted from';

-- ---------------------------------------------------------------- the mark
--
-- A submission about a car with an open file gets the red mark a mention gets
-- — but it clears by ANSWERING it in the queue, with no clock. A mention
-- escalates at 24 and 48 hours because it is waiting on one named person; this
-- is waiting on whoever picks it up, and nagging the shop about its own queue
-- twice a day is how a queue gets ignored.
ALTER TABLE repair_orders ADD COLUMN web_request_id BIGINT UNSIGNED NULL
  COMMENT 'an unanswered web submission about this car; cleared when the queue answers it';

-- ----------------------------------------------------------- permissions
--
-- Two capabilities, deliberately separate.
--
-- `web_forms` is the settings screen: the key, the domains, the public window,
-- the colours, the letters. Owner only — it changes what the public sees on the
-- shop's own website.
--
-- Answering the queue is NOT its own capability. Confirming a request books a
-- real appointment against a real lead, which is exactly `manage_leads`, and a
-- second switch beside it would only ever be set to the same value.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'web_forms', 1, 1 FROM roles WHERE locked = 'owner'
ON DUPLICATE KEY UPDATE can_see = 1, can_change = 1;
