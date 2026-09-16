-- 007 — backfill membership_roles from memberships.role.
--
-- `membership_roles` (master/002) made "what roles does this person hold" a set
-- rather than one column, and every read was written with a fallback to the old
-- `memberships.role` — except the pay-plan screen, which read the new table
-- alone.
--
-- That mattered because NOTHING WRITES THE NEW TABLE except the admin People
-- screen. The provisioner writes `memberships.role` for the owner it creates;
-- the demo seeder writes it for all sixteen of its crew. So on any shop whose
-- people arrived by provisioning or by the nightly demo reset,
-- `membership_roles` was empty, and the pay-plan screen rendered no people at
-- all: no plan could be created, so no commission ledger row could exist, so
-- the commission report was empty, so closing a file appeared to flag nobody.
-- One cause, four symptoms, reported from a demo on 15 Sep 2026.
--
-- The route now has the same fallback as everywhere else, but a fallback is a
-- workaround. This makes the data right, so every screen that reads roles —
-- the roles admin's "how many people hold this", the status-setup owner
-- pickers, anything written later — sees the truth without needing to know
-- about the old column.
--
-- Safe to run twice: INSERT IGNORE against the unique key, and it only ever
-- adds a row where the person has none. A shop that has since used the People
-- screen already has correct rows and is untouched.

INSERT IGNORE INTO membership_roles (user_id, company_id, role_key)
SELECT m.user_id, m.company_id, m.role
  FROM memberships m
 WHERE m.role IS NOT NULL
   AND m.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM membership_roles mr
      WHERE mr.user_id = m.user_id AND mr.company_id = m.company_id
   );
