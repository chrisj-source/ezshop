-- 010 — closing a file, the sublet lane, and deleting a lead.
--
-- Three queued items, one migration.

-- ---------------------------------------------------------------- closing
--
-- `closed_at` already takes a file off the board, and the dates block calls it
-- "date picked up". Closing is a separate act with its own date, because the
-- close date is what the books are keyed on and it is set by hand: a car
-- finished in April and paid in May can be booked to either. So the close
-- carries its own columns and `close_date` is the flag for "closed properly".
ALTER TABLE repair_orders
  ADD COLUMN close_date  DATE     NULL COMMENT 'the books date, set and re-set by hand' AFTER closed_at,
  ADD COLUMN closed_by   BIGINT UNSIGNED NULL AFTER close_date,
  ADD COLUMN paid        TINYINT(1) NOT NULL DEFAULT 0 AFTER closed_by,
  ADD COLUMN paid_at     DATETIME NULL AFTER paid;

-- The closed board reads by date range and payment; the report groups by month
-- and week off the same column.
CREATE INDEX ix_ro_close_date ON repair_orders (close_date, paid);

-- ---------------------------------------------------------------- sublet lane
--
-- Sublet becomes a lane like body and paint, so a car out at a vendor is
-- somewhere on the board rather than parked in whatever status it left in.
SET @ra := COALESCE(
  (SELECT sort_order FROM lanes WHERE lane_key = 'reassembly'),
  (SELECT MAX(sort_order) FROM lanes),
  0);

UPDATE lanes SET sort_order = sort_order + 1 WHERE sort_order > @ra;

INSERT INTO lanes (lane_key, label, enabled, parts_gate, owner_role, module_tag, sort_order)
VALUES ('sublet', 'Sublet', 1, 'no', 'parts manager', 'sublet', @ra + 1)
ON DUPLICATE KEY UPDATE label = label;

SET @rg := COALESCE(
  (SELECT sort_order FROM status_groups WHERE group_id = 'lane_reassembly'),
  (SELECT MAX(sort_order) FROM status_groups),
  0);

UPDATE status_groups SET sort_order = sort_order + 1 WHERE sort_order > @rg;

INSERT INTO status_groups (group_id, label, sort_order, note) VALUES
  ('lane_sublet', 'Sublet', @rg + 1,
   'A car out at a vendor. The lane says where the car is; the sublet lines on the file say what is owed and to whom.')
ON DUPLICATE KEY UPDATE label = label;

-- Four statuses, in order. At Sublet is the only one that does not count toward
-- cycle time — the car is off site and the day is not the shop's.
INSERT INTO statuses
  (slot_id, group_id, lane_key, label, customer_label, kind, owner_role,
   age_yellow_hours, age_red_hours, module_tags, counts_toward_cycle, sort_order)
VALUES
  ('lane.sublet.awaiting', 'lane_sublet', 'sublet', 'Awaiting Sublet',
   'Waiting on outside work', 'queue',  'parts manager', 24,  48, 'sublet', 1, 1),
  ('lane.sublet.at',       'lane_sublet', 'sublet', 'At Sublet',
   'Out for outside work',   'queue',  'parts manager', 48,  96, 'sublet', 0, 2),
  ('lane.sublet.working',  'lane_sublet', 'sublet', 'Working Sublet',
   'Outside work under way', 'active', 'parts manager', 48,  96, 'sublet', 1, 3),
  ('lane.sublet.complete', 'lane_sublet', 'sublet', 'Sublet Complete',
   'Outside work done',      'complete','parts manager', 24,  48, 'sublet', 1, 4)
ON DUPLICATE KEY UPDATE label = label;

-- ---------------------------------------------------------------- lead delete
--
-- Soft, like a void: off the list and out of the response clock, but the record,
-- its notes and its history stay, and it can be restored.
ALTER TABLE leads
  ADD COLUMN deleted_at    DATETIME NULL AFTER settled_at,
  ADD COLUMN deleted_by    BIGINT UNSIGNED NULL AFTER deleted_at,
  ADD COLUMN delete_reason VARCHAR(64) NULL AFTER deleted_by;

CREATE INDEX ix_lead_deleted ON leads (deleted_at);

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  -- Who may close a file is a role question, not a setting; this is only the
  -- default close date offered by the modal: 'today' or 'delivered'.
  ('close_date_default', 'today')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
