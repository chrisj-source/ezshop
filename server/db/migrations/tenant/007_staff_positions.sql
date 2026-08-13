-- 007 — a trade is a set, not a column.
-- A painter who also does body, a PDR tech who does body and paint. Role is
-- what a person may see and do; the trade is what they work, and small shops
-- have people who work two or three. `staff.position_key` stays as the seed and
-- as the person's listed trade; the join table is what the dropdowns and
-- canMoveTo read.
CREATE TABLE staff_positions (
  user_id      BIGINT UNSIGNED NOT NULL,
  position_key VARCHAR(24)  NOT NULL,
  sort_order   INT          NOT NULL DEFAULT 0 COMMENT 'lane order; the first is the trade they are listed under',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, position_key),
  KEY ix_sp_position (position_key),
  CONSTRAINT fk_sp_staff FOREIGN KEY (user_id) REFERENCES staff(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_position FOREIGN KEY (position_key) REFERENCES positions(position_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed each person's current single position.
INSERT IGNORE INTO staff_positions (user_id, position_key, sort_order)
  SELECT user_id, position_key, 0 FROM staff WHERE position_key IS NOT NULL;

-- A short count on receiving is qty_received against qty; the enum already
-- carries 'partial'. Nothing to add for the ordering modal — vendor_id,
-- po_number, ordered_at and eta are all on parts_lines already.
