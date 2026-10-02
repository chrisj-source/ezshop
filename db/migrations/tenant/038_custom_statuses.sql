-- 038 — statuses a shop adds itself (Admin › Statuses, or platform admin for them).
-- One ADD COLUMN per statement (see CLAUDE.md, schema drift).
--
-- is_custom marks a status the shop added. It is hidden, never deleted, the same
-- as a built-in one: a file's history points at its slot_id forever.
--
-- sms_templates.slot_id binds an added status's text to it directly. The
-- built-in updates keep their bindings in lib/sms-status.ts and leave it NULL.

ALTER TABLE statuses ADD COLUMN IF NOT EXISTS is_custom TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE statuses ADD COLUMN IF NOT EXISTS created_by BIGINT UNSIGNED NULL;

ALTER TABLE statuses ADD COLUMN IF NOT EXISTS created_at DATETIME NULL;

ALTER TABLE sms_templates ADD COLUMN IF NOT EXISTS slot_id VARCHAR(64) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_template_slot ON sms_templates (slot_id);
