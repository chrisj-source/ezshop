-- 003 — documents attached to a lead
-- A rep photographs a signed contract before any repair order exists, so those
-- files hang off the lead and move across when it converts.
CREATE TABLE IF NOT EXISTS lead_documents (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id         BIGINT UNSIGNED NOT NULL,
  label           VARCHAR(190)  NOT NULL,
  storage_key     VARCHAR(255)  NOT NULL,
  thumb_key       VARCHAR(255)  NULL,
  mime_type       VARCHAR(96)   NULL,
  width           INT           NULL,
  height          INT           NULL,
  size_bytes      BIGINT        NOT NULL DEFAULT 0,
  uploaded_by     BIGINT UNSIGNED NULL,
  uploaded_name   VARCHAR(120)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      DATETIME      NULL,
  KEY ix_leaddoc_lead (lead_id, created_at),
  CONSTRAINT fk_leaddoc_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
