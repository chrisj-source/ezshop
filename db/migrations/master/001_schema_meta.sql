-- 001 — schema bookkeeping for the master database
CREATE TABLE IF NOT EXISTS schema_meta (
  id             TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  version        INT          NOT NULL DEFAULT 1,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_meta (id, version) VALUES (1, 1)
  ON DUPLICATE KEY UPDATE version = version;
