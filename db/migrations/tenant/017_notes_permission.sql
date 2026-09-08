-- 017 — Notes and history get their own permission.
--
-- Notes were never a capability: anyone who could open a file could read its
-- notes and add to them. That made the block impossible to take away, and
-- equally impossible to give back — there was no tick for it on the
-- permissions screen, so a shop that wanted the floor out of the notes had no
-- way to say so, and no way to reverse it.
--
-- New capability: notes. See is the block, change is adding to it.
--
-- Seeded ON for every role that exists, see and change both, because that is
-- what every role had a moment ago. Nobody loses anything on this migration;
-- the point is that from here it can be turned off deliberately, per role, and
-- turned back on again.

INSERT IGNORE INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT r.role_key, 'notes', 1, 1 FROM roles r;
