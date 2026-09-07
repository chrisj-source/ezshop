-- 016 — Retention: archive at one year, purge at ten.
--
-- The decision (30 Aug 2026): a closed file stays readable forever as far as the
-- shop is concerned, but its personal data has a ten-year outer limit, and after
-- one year it drops to archival — the record stays, the regenerable bulk goes.
--
-- Two stamps on the repair order rather than a separate table, because the
-- question "has this been archived / purged" is asked per file, on the file.
--
--   archived_at   derivatives (thumbnails, rendered PDF pages) dropped; the
--                 originals and the whole record still there. Reversible: open
--                 the file and the thumbnails are made again on demand.
--   purged_at     NOT reversible. Documents gone from disk, the insurance
--                 contact columns cleared, retail customer contact details
--                 cleared where no newer file exists. The accounting shell —
--                 RO number, dates, amounts, labour, who worked on it — stays,
--                 because that is a business record, not personal data.
--
-- Nothing runs until RETENTION_ENABLED=1 is set in .env. A retention sweeper
-- that deletes on first deploy, before anyone has looked at what it would take,
-- is how you lose a shop's photos.

ALTER TABLE repair_orders
  ADD COLUMN archived_at DATETIME NULL COMMENT 'derivatives dropped, record intact'
    AFTER closed_at,
  ADD COLUMN purged_at   DATETIME NULL COMMENT 'personal data erased, accounting shell kept'
    AFTER archived_at,
  ADD KEY ix_ro_retention (closed_at, archived_at, purged_at);

-- What the sweeper did, per run, so the shop can be told and so a purge is
-- itself auditable. Append only, like the audit log.
CREATE TABLE retention_runs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ran_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind            ENUM('archive','purge') NOT NULL,
  dry_run         TINYINT(1)    NOT NULL DEFAULT 1,
  files_touched   INT           NOT NULL DEFAULT 0,
  documents_gone  INT           NOT NULL DEFAULT 0,
  bytes_freed     BIGINT        NOT NULL DEFAULT 0,
  clients_cleared INT           NOT NULL DEFAULT 0,
  note            VARCHAR(255)  NULL,
  KEY ix_retention_ran (ran_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
