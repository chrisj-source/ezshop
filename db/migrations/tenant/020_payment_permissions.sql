-- 020 — payments are three permissions, not one.
--
-- Seeing what has been paid, taking a payment, and changing one after the fact
-- are three different answers in a shop. The desk that takes a check at the
-- counter is not always the desk allowed to rewrite one a week later.
--
--   payments      see = can see the balance and the receipts
--                 change = can record a payment
--   payment_edit  see = can edit or void a payment already recorded
--
-- Safe to run twice.
--
-- The defaults below match what the roles could already do with money, so
-- nobody loses a screen they had this morning: the owner holds everything,
-- accounting takes and edits, the front office takes, the estimator reads. Any
-- shop that wants it otherwise ticks the boxes on Roles & permissions — that is
-- the whole point of the caps being rows.

-- Owner: everything, always. The owner role is locked and cannot be reduced,
-- but the rows are written anyway so the screen shows them ticked.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'payments', 1, 1 FROM roles WHERE locked = 'owner'
ON DUPLICATE KEY UPDATE can_see = 1, can_change = 1;

INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'payment_edit', 1, 0 FROM roles WHERE locked = 'owner'
ON DUPLICATE KEY UPDATE can_see = 1;

-- Accounting: takes payments and may correct one.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'payments', 1, 1 FROM roles WHERE role_key = 'accounting'
ON DUPLICATE KEY UPDATE can_see = 1, can_change = 1;

INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'payment_edit', 1, 0 FROM roles WHERE role_key = 'accounting'
ON DUPLICATE KEY UPDATE can_see = 1;

-- Front office: takes payments. Editing one is deliberately not theirs by
-- default — a shop that wants it can tick it.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'payments', 1, 1 FROM roles WHERE role_key = 'front_office'
ON DUPLICATE KEY UPDATE can_see = 1, can_change = 1;

-- Estimator: reads the balance, because they are asked about it. No taking.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT role_key, 'payments', 1, 0 FROM roles WHERE role_key = 'estimator'
ON DUPLICATE KEY UPDATE can_see = 1;

-- Anyone the shop has already trusted with repair-order totals can at least SEE
-- what has been paid. It is the same money, one screen over, and a balance that
-- is invisible to the person being asked about it is just a phone call to
-- somebody else.
INSERT INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT rc.role_key, 'payments', 1, 0
  FROM role_caps rc
 WHERE rc.cap_key = 'ro_totals' AND rc.can_see = 1
ON DUPLICATE KEY UPDATE can_see = 1;
