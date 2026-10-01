-- 011 — locations: a parent shop and the shops under it.
--
-- A location is a company like any other — own database, own login, own
-- everything. The group is what joins them, and it carries three things only:
-- who the parent is, who may read the locations' reports, and (later) the group
-- web form. One parent per group; a shop is in at most one group.

CREATE TABLE IF NOT EXISTS company_groups (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name               VARCHAR(160)  NOT NULL,
  parent_company_id  BIGINT UNSIGNED NOT NULL,
  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_group_parent (parent_company_id),
  CONSTRAINT fk_cg_parent FOREIGN KEY (parent_company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS group_id BIGINT UNSIGNED NULL AFTER plan_code;

-- Combined reports, granted person by person in the parent's settings. The
-- grant alone is enough: no membership at the location, no seat there. It
-- reaches reports and nothing else.
CREATE TABLE IF NOT EXISTS group_report_grants (
  group_id     BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  granted_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT fk_grg_group FOREIGN KEY (group_id) REFERENCES company_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_grg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
