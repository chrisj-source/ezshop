-- 033 — Internal notes.
--
-- A note whose first characters are "# " (hash, then a space) is internal: it
-- is written on the file like any other note and is only readable by roles that
-- hold the new `internal_notes` capability, by the person who wrote it, and by
-- anybody tagged in that one note.
--
-- Why a sigil and not a switch beside the box: the desk writes notes at speed,
-- often one-handed at the counter, and a note that needed a second deliberate
-- action to become internal would either be forgotten or ignored. A character
-- typed first costs nothing and is visible in the text afterwards.
--
-- Why the space is required: shops type "#1204 came in on the truck" meaning
-- the RO number, and that must stay an ordinary note. "# call the owner" is
-- internal, "#1204 came in" is not.
--
-- Anyone without the capability is shown NOTHING — no placeholder, no count, no
-- gap in the numbering. A greyed "1 hidden note" line tells the floor exactly
-- what it was not meant to know, which is the whole thing this avoids.

-- One ADD COLUMN per statement: a multi-clause ALTER is atomic, so one column
-- that is already there would discard its siblings.
ALTER TABLE ro_notes ADD COLUMN internal TINYINT(1) NOT NULL DEFAULT 0;

-- Read alongside ro_id on every file open.
ALTER TABLE ro_notes ADD KEY ix_notes_internal (ro_id, internal);

-- The capability. `can_see` is the whole answer — there is no separate right to
-- write one, because the author can always read their own.
--
-- Seeded for the owner (who holds everything), accounting, and any role the
-- shop has already trusted with shop settings or permissions. Deliberately NOT
-- seeded to the estimator or front office: this is the one capability where the
-- shop should have to tick it outward itself and know it did.
INSERT IGNORE INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT r.role_key, 'internal_notes', 1, 0
  FROM roles r
 WHERE r.locked = 'owner'
    OR r.role_key = 'accounting'
    OR EXISTS (SELECT 1 FROM role_caps rc
                WHERE rc.role_key = r.role_key
                  AND rc.cap_key IN ('admin', 'perms')
                  AND rc.can_see = 1);
