-- 014 — EMS contact capture, and the overwrite record.
--
-- The parser read the customer's phone and the insurer's details out of .ad1 and
-- then dropped them: ems_imports kept only customer_name, so the confirm screen
-- could not show a phone it was about to write. Keep what the estimate said.
--
-- Email is opportunistic. CCC 2.01 has no email field in .ad1; later writers do,
-- under several names. The parser tries them all and stores whatever it finds,
-- so the column exists for the files that carry one.

ALTER TABLE ems_imports
  ADD COLUMN customer_phone   VARCHAR(32)  NULL AFTER customer_name,
  ADD COLUMN customer_phone2  VARCHAR(32)  NULL AFTER customer_phone,
  ADD COLUMN customer_email   VARCHAR(190) NULL AFTER customer_phone2,
  ADD COLUMN customer_addr    VARCHAR(190) NULL AFTER customer_email,
  ADD COLUMN customer_city    VARCHAR(96)  NULL AFTER customer_addr,
  ADD COLUMN customer_state   VARCHAR(8)   NULL AFTER customer_city,
  ADD COLUMN customer_zip     VARCHAR(16)  NULL AFTER customer_state,
  ADD COLUMN insurer_phone    VARCHAR(32)  NULL AFTER insurer_name,
  ADD COLUMN adjuster_phone   VARCHAR(32)  NULL AFTER adjuster,
  ADD COLUMN adjuster_email   VARCHAR(190) NULL AFTER adjuster_phone;

-- A second number for the customer. CCC carries two (OWNR_PH1/PH2) and a shop
-- reaching somebody about their car wants both, not the first one only.
ALTER TABLE clients
  ADD COLUMN phone2 VARCHAR(32) NULL AFTER phone;

-- The adjuster's own contact details, off the estimate. adjuster was a name and
-- nothing else, so reaching them meant looking the claim up somewhere else.
ALTER TABLE repair_orders
  ADD COLUMN adjuster_phone VARCHAR(32)  NULL AFTER adjuster,
  ADD COLUMN adjuster_email VARCHAR(190) NULL AFTER adjuster_phone;

-- What an accepted import actually changed, field by field. The audit log carries
-- the same rows, but this one is scoped to the import so the screen can show
-- "this is what the last one overwrote" without searching the log.
CREATE TABLE ems_import_changes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  import_id   BIGINT UNSIGNED NOT NULL,
  ro_id       BIGINT UNSIGNED NULL,
  target      VARCHAR(32)  NOT NULL COMMENT 'ro | client | vehicle',
  field       VARCHAR(48)  NOT NULL,
  label       VARCHAR(96)  NOT NULL COMMENT 'what to call it on screen',
  old_value   VARCHAR(255) NULL,
  new_value   VARCHAR(255) NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_emschg_import (import_id),
  KEY ix_emschg_ro (ro_id),
  CONSTRAINT fk_emschg_import FOREIGN KEY (import_id) REFERENCES ems_imports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
