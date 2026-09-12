-- 003 — platform roles, and the demo shop.
--
-- Two things a platform needs that a single is_platform_owner flag cannot say.
--
-- **Root is the break-glass account.** It cannot be removed or demoted, it can
-- manage platform admins, and it cannot sign in at all unless ROOT_ENABLED=1 is
-- set on the box and the service restarted. The day it is used is the day
-- something has gone wrong — an admin to remove, or worse — so every root
-- sign-in lands in the platform audit and the screen says so while it lasts.
--
-- **Platform admins** run the platform day to day: shops, features, entering a
-- shop, resetting a shop owner's password. They cannot see or manage other
-- admins, and they cannot delete a shop — only suspend one.
--
-- `is_platform_owner` stays as it is and is kept in step, so nothing that reads
-- it has to change on the same day.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS platform_role ENUM('none','admin','root') NOT NULL DEFAULT 'none'
    COMMENT 'none | admin (runs the platform) | root (break-glass, ROOT_ENABLED only)'
    AFTER is_platform_owner;

UPDATE users SET platform_role = 'admin'
 WHERE is_platform_owner = 1 AND platform_role = 'none';

ALTER TABLE users ADD KEY IF NOT EXISTS ix_users_platform (platform_role);

-- ---------------------------------------------------------------------------
-- The demo shop
-- ---------------------------------------------------------------------------
--
-- A real shop, seeded with real-looking work, reset nightly at 2am Central and
-- from a button on the platform screen. It is marked here rather than guessed
-- at by slug, so the reset job can never take a live shop by mistake — the job
-- refuses to run against a company without this flag.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_demo TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'seeded, resettable, and never a real shop' AFTER status,
  ADD COLUMN IF NOT EXISTS demo_reset_at DATETIME NULL
    COMMENT 'when the seed was last put back';
