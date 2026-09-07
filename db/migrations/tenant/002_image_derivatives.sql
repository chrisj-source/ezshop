-- 002 — image derivatives
-- Photos are resized on the phone before upload; the drawer shows a small
-- thumbnail and only fetches the full image when someone opens it.
ALTER TABLE documents
  ADD COLUMN thumb_key   VARCHAR(255) NULL AFTER storage_key,
  ADD COLUMN width       INT          NULL AFTER mime_type,
  ADD COLUMN height      INT          NULL AFTER width,
  ADD COLUMN is_image    TINYINT(1)   NOT NULL DEFAULT 0 AFTER height;

UPDATE documents SET is_image = 1 WHERE mime_type LIKE 'image/%';

CREATE INDEX ix_doc_images ON documents (ro_id, is_image, created_at);
