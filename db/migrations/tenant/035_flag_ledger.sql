-- Flags pay on the week of the flag date, and a trade can be flagged in parts.
-- One ADD COLUMN per statement (see CLAUDE.md, schema drift).

ALTER TABLE ro_labour ADD COLUMN partial TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ro_flag_entries (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id         BIGINT UNSIGNED NOT NULL,
  position_key  VARCHAR(24)   NOT NULL,
  user_id       BIGINT UNSIGNED NULL,
  display_name  VARCHAR(120)  NULL,
  basis         ENUM('hours','flat','ems','pct') NOT NULL,
  hours         DECIMAL(7,2)  NOT NULL DEFAULT 0 COMMENT 'the change, not the total',
  rate_cents    BIGINT        NOT NULL DEFAULT 0,
  cost_cents    BIGINT        NOT NULL DEFAULT 0 COMMENT 'the change, not the total',
  partial       TINYINT(1)    NOT NULL DEFAULT 0,
  flag_at       DATETIME      NOT NULL COMMENT 'the date the person gave',
  counts_at     DATETIME      NOT NULL COMMENT 'what payroll windows on',
  source        VARCHAR(16)   NOT NULL DEFAULT 'flag' COMMENT 'flag, close, backfill, backfill_paid',
  backfill_key  VARCHAR(80)   NULL,
  entered_by    BIGINT UNSIGNED NULL,
  entered_by_name VARCHAR(120) NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_flag_backfill (backfill_key),
  KEY ix_flag_counts (counts_at),
  KEY ix_flag_ro (ro_id, position_key, user_id),
  CONSTRAINT fk_flag_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What was already paid, dated inside the week it was paid in.
INSERT IGNORE INTO ro_flag_entries
  (ro_id, position_key, user_id, basis, hours, rate_cents, cost_cents,
   flag_at, counts_at, source, backfill_key, entered_by_name)
SELECT pc.ro_id, pc.position_key, pc.user_id, pc.basis, pc.hours, pc.rate_cents, pc.cost_cents,
       pr.cutoff_at, pr.cutoff_at, 'backfill_paid',
       CONCAT('paid:', pc.run_id, ':', pc.user_id, ':', pc.ro_id, ':', pc.position_key),
       'migration 035'
  FROM payroll_run_cars pc
  JOIN payroll_runs pr ON pr.id = pc.run_id AND pr.paid_at IS NOT NULL;

-- Whatever is flagged and not yet paid, on its flag date — or just after the last
-- paid week that already covered part of it. Never a claw-back from here: a
-- trade paid more than it now stands at is left for a person to look at.
INSERT IGNORE INTO ro_flag_entries
  (ro_id, position_key, user_id, display_name, basis, hours, rate_cents, cost_cents,
   partial, flag_at, counts_at, source, backfill_key, entered_by_name)
SELECT l.ro_id, l.position_key, l.user_id, l.display_name, l.basis,
       l.hours - COALESCE(p.hours, 0), l.rate_cents, l.cost_cents - COALESCE(p.cost, 0),
       0, l.flagged_at,
       CASE WHEN p.last_cut IS NULL THEN l.flagged_at
            ELSE GREATEST(l.flagged_at, p.last_cut + INTERVAL 1 SECOND) END,
       'backfill', CONCAT('open:', l.ro_id, ':', l.position_key), 'migration 035'
  FROM ro_labour l
  LEFT JOIN (
    SELECT ro_id, position_key, user_id, SUM(cost_cents) AS cost, SUM(hours) AS hours,
           MAX(counts_at) AS last_cut
      FROM ro_flag_entries WHERE source = 'backfill_paid'
     GROUP BY ro_id, position_key, user_id
  ) p ON p.ro_id = l.ro_id AND p.position_key = l.position_key AND p.user_id = l.user_id
 WHERE l.flagged_at IS NOT NULL AND l.user_id IS NOT NULL
   AND (p.ro_id IS NULL OR l.cost_cents - p.cost > 0);
