-- 042 — fill in Date picked up on files marked Picked Up before a0.8.9.
-- The board only stamped it at the terminal status, so Picked Up left the
-- box empty. Only EMPTY boxes are filled — a date somebody typed is kept.
-- Date used: the most recent move into Picked Up in the file's history.

UPDATE repair_orders r
JOIN (
  SELECT ro_id, MAX(created_at) AS at
  FROM ro_status_history WHERE to_slot = 'deliver.pickup' GROUP BY ro_id
) h ON h.ro_id = r.id
SET r.closed_at = h.at
WHERE r.closed_at IS NULL;

-- Sitting in Picked Up with no history row for it (imported or moved before
-- history was kept): the time it went into that status.
UPDATE repair_orders
SET closed_at = status_since
WHERE closed_at IS NULL AND status_slot = 'deliver.pickup' AND status_since IS NOT NULL;

-- Files taken to File Closed before a0.8.9 got the CLOSE time in this box, not
-- the pick-up. Where history shows a move into Picked Up, and the box holds the
-- moment of a move into a terminal status (within a minute — the stamp was
-- written in the same request), it was the machine's, so it is replaced with
-- the pick-up. A date that matches no terminal move was typed, and is kept.
UPDATE repair_orders r
JOIN (
  SELECT ro_id, MAX(created_at) AS at
  FROM ro_status_history WHERE to_slot = 'deliver.pickup' GROUP BY ro_id
) p ON p.ro_id = r.id
SET r.closed_at = p.at
WHERE r.closed_at IS NOT NULL
  AND r.closed_at <> p.at
  AND p.at <= r.closed_at
  AND EXISTS (
    SELECT 1 FROM ro_status_history h JOIN statuses s ON s.slot_id = h.to_slot
    WHERE h.ro_id = r.id AND s.is_terminal = 1
      AND ABS(TIMESTAMPDIFF(SECOND, h.created_at, r.closed_at)) <= 60
  );
