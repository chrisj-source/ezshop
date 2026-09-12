-- 019 — taking payments, paying techs a percentage, and flagging before close.
--
-- Three queued items, one migration.
--
--  1. `ro_payments` — money against a file. Paid stops being a flag somebody
--     sets and becomes the balance reaching zero. Built with the column names
--     the PHP invoicing app already uses (amount_cents, method, reference,
--     received_at, recorded_by) so the port lands on one table rather than two,
--     with a nullable invoice_id waiting for it.
--  2. `staff_pay_plans` — pay per job type. A body tech can be 12.5% of a
--     wholesale car with paint on it, 25% if it is body only, and flag hours on
--     anything with an estimate behind it. One row per person per job type.
--  3. Flagging — `ro_labour` gains a flag stamp, so the trades on a file are
--     settled while the car is still here instead of at the close.
--
-- Every statement here is written to be run twice. DDL does not roll back in
-- MariaDB, so a migration that fails halfway leaves the earlier statements
-- applied — `IF NOT EXISTS` and guarded UPDATEs are what make the retry clean
-- rather than a hand-repair job.

-- ===========================================================================
-- Payments
-- ===========================================================================
--
-- `ref_key` exists to enforce one rule: the same check or draft number may be
-- used on many files — one insurance draft often pays four — but not twice on
-- the same file, which is what catches a payment entered twice. It is NULL for
-- a method that carries no number, and MySQL allows any number of NULLs in a
-- unique index, so cash and card are unaffected.
CREATE TABLE IF NOT EXISTS ro_payments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  invoice_id      BIGINT UNSIGNED NULL COMMENT 'the invoicing port fills this; a receipt can sit against both',
  amount_cents    BIGINT        NOT NULL,
  method          ENUM('check','cash','card','draft','writeoff') NOT NULL,
  payer           ENUM('customer','insurer') NOT NULL DEFAULT 'customer',
  reference       VARCHAR(64)   NULL COMMENT 'check number or draft number; required for those two',
  note            VARCHAR(255)  NULL,
  received_at     DATE          NOT NULL,
  recorded_by     BIGINT UNSIGNED NULL,
  recorded_by_name VARCHAR(120) NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_at       DATETIME      NULL,
  voided_by       BIGINT UNSIGNED NULL,
  void_reason     VARCHAR(190)  NULL,
  ref_key VARCHAR(80)
    AS (IF(reference IS NULL OR reference = '' OR voided_at IS NOT NULL,
           NULL, CONCAT(method, ':', reference))) STORED,
  UNIQUE KEY uq_pay_ref (ro_id, ref_key),
  KEY ix_pay_ro (ro_id, received_at),
  KEY ix_pay_when (received_at),
  CONSTRAINT fk_pay_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What has been received, kept on the file so the board and the closed list can
-- read a balance without summing the payments table per row. Written by the
-- payment endpoints and by nothing else.
ALTER TABLE repair_orders
  ADD COLUMN IF NOT EXISTS paid_cents BIGINT NOT NULL DEFAULT 0
    COMMENT 'sum of live payments; paid is (paid_cents >= amount_cents)' AFTER paid;

-- Files already marked paid by hand keep their flag and get no payment rows.
-- The flag is what the old close wrote; inventing receipts for it would put
-- money in the record that nobody ever took.
UPDATE repair_orders SET paid_cents = amount_cents WHERE paid = 1 AND paid_cents = 0;

-- ===========================================================================
-- Pay plans, per job type
-- ===========================================================================
--
-- `job_type` is derived per file, not stored on it: wholesale when the client is
-- a wholesale account, insurance when there is a carrier or a claim behind it,
-- cash otherwise.
--
-- A percentage plan carries two figures because the shop pays two: one when the
-- file has paint on it and one when it is body only. A percentage runs off the
-- approved amount **after any parts we bought come out at cost** — a $450 car
-- with no parts pays 12.5% of $450; a $6,482.19 file carrying $1,900 of parts
-- runs off $4,582.19.
CREATE TABLE IF NOT EXISTS staff_pay_plans (
  user_id         BIGINT UNSIGNED NOT NULL,
  job_type        ENUM('wholesale','insurance','cash') NOT NULL,
  basis           ENUM('pct','hours','flat') NOT NULL DEFAULT 'hours',
  pct_paint       DECIMAL(6,3)  NOT NULL DEFAULT 0 COMMENT 'when the file has paint on it',
  pct_nopaint     DECIMAL(6,3)  NOT NULL DEFAULT 0 COMMENT 'body only',
  rate_cents      BIGINT        NOT NULL DEFAULT 0 COMMENT 'flag rate per hour, or the flat figure',
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED NULL,
  PRIMARY KEY (user_id, job_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Everyone on the floor starts on what they are already on, for all three job
-- types. Nothing changes until somebody sets a percentage, which is the point:
-- this migration must not move a single figure on its own.
-- INSERT IGNORE rather than ON DUPLICATE KEY UPDATE: MariaDB will not take an
-- ON DUPLICATE clause on an INSERT ... SELECT here, and "leave what is already
-- there alone" is exactly what IGNORE means.
INSERT IGNORE INTO staff_pay_plans (user_id, job_type, basis, pct_paint, pct_nopaint, rate_cents)
SELECT s.user_id, j.job_type,
       CASE WHEN s.pay_basis = 'flat' THEN 'flat'
            WHEN s.pay_basis = 'pct'  THEN 'pct'
            ELSE 'hours' END,
       CASE WHEN s.pay_basis = 'pct' THEN s.rate_pct ELSE 0 END,
       CASE WHEN s.pay_basis = 'pct' THEN s.rate_pct ELSE 0 END,
       s.rate_cents
  FROM staff s
  JOIN (SELECT 'wholesale' AS job_type UNION ALL
        SELECT 'insurance' UNION ALL
        SELECT 'cash') j;

-- ===========================================================================
-- Flagging
-- ===========================================================================
--
-- `ro_labour` already holds one row per assigned trade with a basis and a
-- settled figure; it was only ever written at close. Flagging writes the same
-- row while the car is still in the shop, so close-out reads what the shop
-- already agreed rather than asking for it at the worst possible moment.
--
-- `pct_base` generalises what `pct_after_costs` did for PDR alone: a percentage
-- is against the approval, or against the approval net of parts at cost, which
-- is what the tech plans use.
ALTER TABLE ro_labour
  ADD COLUMN IF NOT EXISTS pct_base ENUM('approval','after_parts') NOT NULL DEFAULT 'approval'
    AFTER pct_after_costs,
  ADD COLUMN IF NOT EXISTS flagged_at DATETIME NULL COMMENT 'set when the trade is flagged, cleared when it is unflagged',
  ADD COLUMN IF NOT EXISTS flagged_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS flagged_by_name VARCHAR(120) NULL;

ALTER TABLE ro_labour ADD KEY IF NOT EXISTS ix_labour_flagged (ro_id, flagged_at);

-- Rows written by a close that already happened are flagged, by definition:
-- the file settled on them.
UPDATE ro_labour l
  JOIN repair_orders r ON r.id = l.ro_id
   SET l.flagged_at = COALESCE(r.closed_at, l.entered_at)
 WHERE l.flagged_at IS NULL AND r.closed_at IS NOT NULL;

-- PDR's existing after-costs share keeps behaving exactly as it did.
UPDATE ro_labour SET pct_base = 'approval' WHERE basis = 'pct';
