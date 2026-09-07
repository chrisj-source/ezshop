-- 015 — Wholesale accounts get their own permission.
--
-- Anyone who could write a repair order could also create and edit wholesale
-- accounts, because clients.ts checked edit_ro. A wholesale account is a billing
-- relationship — terms, who gets the invoice — so it belongs with the office,
-- not with whoever opens files. New capability: wholesale_clients.
--
-- Seeded on for the roles that were already trusted with shop settings or the
-- books, so nobody who is doing it today loses it. Every other role keeps
-- writing files and loses only the account setup, which is the point.

INSERT IGNORE INTO role_caps (role_key, cap_key, can_see, can_change)
SELECT r.role_key, 'wholesale_clients', 1, 1
  FROM roles r
 WHERE r.locked = 'owner'
    OR r.role_key = 'accounting'
    OR EXISTS (SELECT 1 FROM role_caps rc
                WHERE rc.role_key = r.role_key
                  AND rc.cap_key IN ('admin', 'perms')
                  AND rc.can_see = 1);
