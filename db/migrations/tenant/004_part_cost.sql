-- 004 — part cost, so gross profit on parts is real rather than inferred
-- `price_cents` is what the estimate pays; `cost_cents` is what the shop pays
-- the vendor. The difference is the margin every parts desk is judged on.
ALTER TABLE parts_lines
  ADD COLUMN cost_cents  BIGINT NOT NULL DEFAULT 0 AFTER price_cents,
  ADD COLUMN po_number   VARCHAR(48) NULL AFTER cost_cents,
  ADD COLUMN invoice_no  VARCHAR(48) NULL AFTER po_number;

CREATE INDEX ix_parts_po ON parts_lines (po_number);
