-- 044 — the lead pipeline (1c): a status per lead, read against its lane.
-- The lane comes from the source; the status is the coloured code on the row.
-- Junk, Unqualified and Vendor are parked: out of every column.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipe_status VARCHAR(32) NULL COMMENT 'lib/pipeline.ts; NULL = the lane''s first status';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipe_status_at DATETIME NULL;
CREATE INDEX IF NOT EXISTS ix_leads_pipe ON leads (pipe_status);
