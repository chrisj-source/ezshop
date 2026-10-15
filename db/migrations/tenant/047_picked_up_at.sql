-- 047 — Date picked up gets its own column.
--
-- a0.8.9 stamped Picked Up into closed_at, but closed_at is half of what makes a
-- file CLOSED (open = close_date IS NULL AND closed_at IS NULL AND voided_at IS
-- NULL). Every picked-up car therefore dropped off the open board and out of
-- Awaiting close-out, and 042's backfill did the same to the old ones. The
-- pick-up date now lives in picked_up_at; closed_at goes back to meaning the
-- file reached its last status.

ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS picked_up_at DATETIME NULL COMMENT 'Date picked up — stamped at Picked Up';

-- Keep every date already shown in the box.
UPDATE repair_orders SET picked_up_at = closed_at WHERE picked_up_at IS NULL AND closed_at IS NOT NULL;

-- Put back the files a0.8.9 / 042 closed by mistake: not closed out, not voided,
-- and not sitting in a terminal status. These are exactly the cars awaiting
-- close-out.
UPDATE repair_orders r
JOIN statuses s ON s.slot_id = r.status_slot
SET r.closed_at = NULL
WHERE r.closed_at IS NOT NULL AND r.close_date IS NULL AND r.voided_at IS NULL AND s.is_terminal = 0;
