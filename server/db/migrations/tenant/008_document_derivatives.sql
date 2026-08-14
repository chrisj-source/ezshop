-- 008 — thumbnails for everything, and rendered PDF pages.
--
-- Uploads no longer have to arrive with their own thumbnail. The server makes
-- one for every photo and for page one of every PDF, on a queue, and the tile
-- stays out of the grid until it is ready.
--
-- HEIC is converted to JPEG and only the JPEG is kept — a HEIC nobody can open
-- in five years is worse than the disk it saves.

ALTER TABLE documents
  -- pending: queued. ready: thumb_key is good. failed: three tries, show a glyph.
  ADD COLUMN thumb_state  ENUM('pending','ready','failed','none') NOT NULL DEFAULT 'none'
    COMMENT 'none = nothing to make, e.g. a .txt' AFTER thumb_key,
  ADD COLUMN thumb_tries  TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER thumb_state,
  -- Rotation is display-only: the file on disk is never rewritten, so the
  -- original evidence photo stays exactly as the camera wrote it.
  ADD COLUMN rotation     SMALLINT NOT NULL DEFAULT 0 COMMENT '0, 90, 180, 270' AFTER height,
  ADD COLUMN page_count   SMALLINT UNSIGNED NULL COMMENT 'PDFs only' AFTER rotation,
  -- What the browser sent, when we converted it to something else.
  ADD COLUMN source_mime  VARCHAR(100) NULL AFTER mime_type,
  ADD COLUMN is_pdf       TINYINT(1) NOT NULL DEFAULT 0 AFTER is_image;

UPDATE documents SET is_pdf = 1 WHERE mime_type = 'application/pdf';

-- Everything already uploaded: a thumbnail if it could have one, and the
-- backfill will work through them. `npm run backfill-thumbs`
UPDATE documents
   SET thumb_state = CASE
     WHEN thumb_key IS NOT NULL THEN 'ready'
     WHEN is_image = 1 OR mime_type = 'application/pdf' THEN 'pending'
     ELSE 'none' END
 WHERE deleted_at IS NULL;

CREATE INDEX ix_doc_pending ON documents (thumb_state, id);

-- Pages of a PDF, rendered when somebody opens them and kept for thirty days
-- after they were last looked at. A twelve-page insurer estimate nobody opens
-- costs one page on disk, not twelve.
CREATE TABLE document_pages (
  document_id  BIGINT UNSIGNED  NOT NULL,
  page_no      SMALLINT UNSIGNED NOT NULL,
  storage_key  VARCHAR(255)     NOT NULL,
  width        INT              NULL,
  height       INT              NULL,
  size_bytes   INT UNSIGNED     NOT NULL DEFAULT 0,
  last_seen_at DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, page_no),
  KEY ix_pages_sweep (last_seen_at),
  CONSTRAINT fk_pages_doc FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
