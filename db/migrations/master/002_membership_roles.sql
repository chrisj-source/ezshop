-- 002 — one person, several roles.
-- A small shop's owner writes estimates; the office manager does the books.
-- `memberships.role` stays for one release as the seed and the fallback; the
-- join table is the truth. What a user may do is the union of the roles they
-- hold; the highest-ranked one is their primary, which is what they are called
-- and who gets notified.
CREATE TABLE IF NOT EXISTS membership_roles (
  user_id     BIGINT UNSIGNED NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  role_key    ENUM('owner','accounting','estimator','production_manager',
                   'parts_manager','front_office','salesperson','technician') NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, company_id, role_key),
  KEY ix_mroles_company (company_id, role_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed every existing membership as its single role.
INSERT IGNORE INTO membership_roles (user_id, company_id, role_key)
  SELECT user_id, company_id, role FROM memberships;
