-- 030 — mark a lead won by hand, and link a lead to a file that already exists.
--
-- Converting is the ordinary route and it writes the repair order itself. What
-- it cannot do is the common case: the customer turns up, somebody at the desk
-- opens a file for them, and the lead is left sitting in "contacted" with no
-- way in — converting would write a SECOND file for the same car.
--
-- So: won can be set by hand, and a lead can be pointed at a file somebody
-- else already opened. `ro_link_kind` is how the two are told apart afterwards,
-- because "this lead became RO 41207" and "we wrote RO 41207 and then noticed
-- the lead" are different facts and the close-rate reader should be able to see
-- which is which.
--
-- One ADD COLUMN per statement — a multi-clause ALTER is atomic, so one column
-- already present would discard its siblings.

ALTER TABLE leads ADD COLUMN won_by_hand TINYINT(1) NOT NULL DEFAULT 0
  COMMENT 'won was set at the desk, not by a conversion';
ALTER TABLE leads ADD COLUMN won_by_user_id BIGINT UNSIGNED NULL;
ALTER TABLE leads ADD COLUMN won_by_name VARCHAR(120) NULL;
ALTER TABLE leads ADD COLUMN won_at DATETIME NULL
  COMMENT 'when it was marked won by hand; settled_at is the state stamp';
ALTER TABLE leads ADD COLUMN win_note VARCHAR(255) NULL;
ALTER TABLE leads ADD COLUMN ro_link_kind ENUM('converted','linked') NULL
  COMMENT 'converted = this lead wrote the file; linked = the file already existed';
ALTER TABLE leads ADD COLUMN ro_linked_at DATETIME NULL;
ALTER TABLE leads ADD COLUMN ro_linked_by BIGINT UNSIGNED NULL;

-- Every lead that already carries a file got there by converting, which is the
-- only route that existed before this migration.
UPDATE leads SET ro_link_kind = 'converted' WHERE ro_id IS NOT NULL AND ro_link_kind IS NULL;

-- A file answers to one lead. Enforced here rather than in the route alone, so
-- two people working two duplicate leads cannot both point at RO 41207.
CREATE UNIQUE INDEX uq_lead_ro ON leads (ro_id);

-- ---------------------------------------------------------------- permission
--
-- Owner only by default. Marking a lead won by hand skips the conversion, which
-- is the step that writes the file and the one the close rate is measured off,
-- so it starts with the person who owns the numbers and the shop ticks it
-- outward from there — estimator and front office are the usual second and
-- third, deliberately NOT granted here.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'win_lead', 1, 0 FROM roles WHERE locked = 'owner'
ON DUPLICATE KEY UPDATE can_see = 1;
