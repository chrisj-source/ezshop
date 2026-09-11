-- 018 — three queued items.
--
--  1. A lead can carry an estimate written at the counter, with the figure.
--  2. Who a status change messages becomes rows a shop can edit, not a
--     position-and-event router nobody can see.
--  3. A parts line remembers the type the ESTIMATE called for alongside the
--     type actually ordered.

-- ===========================================================================
-- 1 · Estimate written on a lead
-- ===========================================================================
--
-- Two states, not one. `estimate_written` is the estimate written here at the
-- counter and it carries the figure; `estimate_sent` is the insurer one and
-- carries no amount of its own. Cash-pay work stops at written — only
-- insurance work reaches sent — so the lead needs to know who is paying, which
-- until now it never recorded.

ALTER TABLE leads
  MODIFY COLUMN state ENUM('new','contacted','estimate_written','estimate_sent',
                           'appraisal_booked','won','lost') NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS payer ENUM('cash','insurance') NOT NULL DEFAULT 'cash'
    COMMENT 'cash-pay stops at estimate_written; only insurance reaches estimate_sent',
  ADD COLUMN IF NOT EXISTS estimate_cents BIGINT NULL
    COMMENT 'what was quoted. Required to mark estimate_written; overwritten on a re-quote',
  ADD COLUMN IF NOT EXISTS estimate_written_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS estimate_written_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS estimate_note VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS estimate_requoted_at DATETIME NULL
    COMMENT 'last time the figure was replaced. The old figure is in lead_events';

-- An estimate event reads as its own thing in the lead's history, not as 'auto'.
ALTER TABLE lead_events
  MODIFY COLUMN kind ENUM('note','auto','followup','appointment','estimate')
    NOT NULL DEFAULT 'note';

-- Quoted dollars are asked for by state and by settled date, both.
ALTER TABLE leads
  ADD KEY IF NOT EXISTS ix_lead_quote (estimate_written_at, estimate_cents);

-- A lead already sitting in estimate_sent came from the old single state. It
-- keeps that state; nothing is invented about an amount nobody typed.
UPDATE leads SET payer = 'insurance'
 WHERE payer = 'cash' AND (state = 'estimate_sent' OR source = 'insurance');

-- ===========================================================================
-- 2 · Who a status change messages
-- ===========================================================================
--
-- One row per status per recipient. `slot_id` because slot ids are canonical —
-- renaming a status must not move who hears about it.
--
-- Two kinds of target. A 'role' row messages everyone holding that role. An
-- 'assigned' row messages the person assigned to that trade ON THIS FILE and
-- nobody else, which is what keeps a painter out of the disassembly traffic.
--   tech   → whoever is assigned body or R&I
--   pdr    → the assigned PDR tech
--   paint  → the assigned painter
--   detail → the assigned detail tech
--
-- A status with no rows messages nobody, deliberately. That is why the router
-- asks whether the table has ANY rows before it decides the grid governs: an
-- empty table means a shop has not migrated and the old NOTIF_GROUPS still
-- runs; a row anywhere means this grid is the answer, zero rows included.

CREATE TABLE IF NOT EXISTS status_routes (
  slot_id       VARCHAR(48) NOT NULL,
  target_kind   ENUM('role','assigned') NOT NULL,
  target_key    VARCHAR(32) NOT NULL COMMENT 'role_key, or tech/pdr/paint/detail',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (slot_id, target_kind, target_key),
  KEY ix_sroute_slot (slot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The shipped default, joined against `statuses` so a shop only gets rows for
-- the statuses its own board actually carries — a PDR-only shop has no
-- lane.body.* slots and should get no lane.body.* routes.
INSERT IGNORE INTO status_routes (slot_id, target_kind, target_key)
SELECT s.slot_id, d.target_kind, d.target_key
FROM statuses s
JOIN (
  SELECT 'intake.arrived' AS slot_id, 'role' AS target_kind, 'owner' AS target_key UNION ALL
  SELECT 'intake.arrived','role','production_manager' UNION ALL
  SELECT 'intake.arrived','role','front_office' UNION ALL
  SELECT 'intake.auth','role','front_office' UNION ALL
  SELECT 'intake.claim','role','front_office' UNION ALL

  SELECT 'assess.awaiting','role','owner' UNION ALL
  SELECT 'assess.awaiting','role','production_manager' UNION ALL
  SELECT 'assess.scope.awaiting','role','estimator' UNION ALL
  SELECT 'assess.scope.working','role','estimator' UNION ALL
  SELECT 'assess.scope.complete','role','production_manager' UNION ALL
  SELECT 'assess.scope.complete','role','front_office' UNION ALL
  SELECT 'assess.teardown.awaiting','role','production_manager' UNION ALL
  SELECT 'assess.teardown.awaiting','assigned','tech' UNION ALL
  SELECT 'assess.teardown.working','role','production_manager' UNION ALL
  SELECT 'assess.teardown.working','assigned','tech' UNION ALL
  SELECT 'assess.teardown.complete','role','production_manager' UNION ALL
  SELECT 'assess.teardown.complete','role','estimator' UNION ALL
  SELECT 'est.needed','role','estimator' UNION ALL
  SELECT 'est.sent','role','front_office' UNION ALL
  SELECT 'est.awaiting','role','front_office' UNION ALL
  SELECT 'est.approved','role','estimator' UNION ALL
  SELECT 'est.approved','role','front_office' UNION ALL
  SELECT 'est.review','role','estimator' UNION ALL

  SELECT 'parts.needed','role','parts_manager' UNION ALL
  SELECT 'parts.ordered','role','production_manager' UNION ALL
  SELECT 'parts.awaiting','role','production_manager' UNION ALL
  SELECT 'parts.awaiting','assigned','tech' UNION ALL
  SELECT 'parts.backordered','role','production_manager' UNION ALL
  SELECT 'parts.backordered','assigned','tech' UNION ALL

  SELECT 'lane.pdr.awaiting','role','production_manager' UNION ALL
  SELECT 'lane.pdr.awaiting','assigned','pdr' UNION ALL
  SELECT 'lane.pdr.working','role','production_manager' UNION ALL
  SELECT 'lane.pdr.complete','role','production_manager' UNION ALL
  SELECT 'lane.pdr.supp.needed','role','estimator' UNION ALL
  SELECT 'lane.pdr.supp.sent','role','production_manager' UNION ALL
  SELECT 'lane.pdr.supp.sent','role','front_office' UNION ALL
  SELECT 'lane.pdr.supp.approved','role','production_manager' UNION ALL
  SELECT 'lane.pdr.supp.approved','role','estimator' UNION ALL

  SELECT 'lane.body.awaiting','role','production_manager' UNION ALL
  SELECT 'lane.body.awaiting','assigned','tech' UNION ALL
  SELECT 'lane.body.working','role','production_manager' UNION ALL
  SELECT 'lane.body.working','assigned','tech' UNION ALL
  SELECT 'lane.body.complete','role','production_manager' UNION ALL
  SELECT 'lane.body.supp.needed','role','estimator' UNION ALL
  SELECT 'lane.body.supp.sent','role','production_manager' UNION ALL
  SELECT 'lane.body.supp.sent','role','front_office' UNION ALL
  SELECT 'lane.body.supp.approved','role','production_manager' UNION ALL
  SELECT 'lane.body.supp.approved','role','estimator' UNION ALL

  SELECT 'lane.prep.awaiting','role','production_manager' UNION ALL
  SELECT 'lane.prep.awaiting','assigned','paint' UNION ALL
  SELECT 'lane.prep.awaiting','assigned','detail' UNION ALL
  SELECT 'lane.prep.working','role','production_manager' UNION ALL
  SELECT 'lane.prep.working','assigned','paint' UNION ALL
  SELECT 'lane.prep.working','assigned','detail' UNION ALL
  SELECT 'lane.prep.complete','role','production_manager' UNION ALL
  SELECT 'lane.prep.complete','assigned','paint' UNION ALL
  SELECT 'lane.prep.complete','assigned','detail' UNION ALL
  SELECT 'lane.prep.supp.needed','role','estimator' UNION ALL
  SELECT 'lane.prep.supp.sent','role','production_manager' UNION ALL
  SELECT 'lane.prep.supp.sent','role','front_office' UNION ALL
  SELECT 'lane.prep.supp.approved','role','production_manager' UNION ALL
  SELECT 'lane.prep.supp.approved','role','front_office' UNION ALL

  SELECT 'lane.paint.awaiting','role','production_manager' UNION ALL
  SELECT 'lane.paint.awaiting','assigned','paint' UNION ALL
  SELECT 'lane.paint.working','role','production_manager' UNION ALL
  SELECT 'lane.paint.working','assigned','paint' UNION ALL
  SELECT 'lane.paint.complete','role','production_manager' UNION ALL
  SELECT 'lane.paint.supp.needed','role','estimator' UNION ALL
  SELECT 'lane.paint.supp.sent','role','production_manager' UNION ALL
  SELECT 'lane.paint.supp.sent','role','front_office' UNION ALL
  SELECT 'lane.paint.supp.approved','role','production_manager' UNION ALL
  SELECT 'lane.paint.supp.approved','role','front_office' UNION ALL

  SELECT 'lane.reassembly.awaiting','role','production_manager' UNION ALL
  SELECT 'lane.reassembly.awaiting','assigned','tech' UNION ALL
  SELECT 'lane.reassembly.working','role','production_manager' UNION ALL
  SELECT 'lane.reassembly.working','assigned','tech' UNION ALL
  SELECT 'lane.reassembly.complete','role','production_manager' UNION ALL
  SELECT 'lane.reassembly.supp.needed','role','estimator' UNION ALL
  SELECT 'lane.reassembly.supp.sent','role','production_manager' UNION ALL
  SELECT 'lane.reassembly.supp.sent','role','front_office' UNION ALL
  SELECT 'lane.reassembly.supp.approved','role','production_manager' UNION ALL

  SELECT 'lane.sublet.awaiting','role','production_manager' UNION ALL
  SELECT 'lane.sublet.at','role','production_manager' UNION ALL
  SELECT 'lane.sublet.working','role','production_manager' UNION ALL
  SELECT 'lane.sublet.complete','role','production_manager' UNION ALL

  SELECT 'lane.buff.awaiting','role','production_manager' UNION ALL
  SELECT 'lane.buff.awaiting','assigned','detail' UNION ALL
  SELECT 'lane.buff.working','role','production_manager' UNION ALL
  SELECT 'lane.buff.working','assigned','detail' UNION ALL
  SELECT 'lane.buff.complete','role','production_manager' UNION ALL

  SELECT 'lane.detail.awaiting','role','production_manager' UNION ALL
  SELECT 'lane.detail.working','role','production_manager' UNION ALL
  SELECT 'lane.detail.complete','role','production_manager' UNION ALL

  -- qa.wash messages nobody, on purpose. It is the one status left silent.
  SELECT 'qa.qc','role','owner' UNION ALL
  SELECT 'qa.qc','role','production_manager' UNION ALL
  SELECT 'qa.detail','role','owner' UNION ALL
  SELECT 'qa.detail','role','production_manager' UNION ALL
  SELECT 'qa.qc.final','role','owner' UNION ALL
  SELECT 'qa.qc.final','role','production_manager' UNION ALL

  SELECT 'ready.payment','role','accounting' UNION ALL
  SELECT 'ready.payment','role','front_office' UNION ALL
  SELECT 'ready.contacted','role','owner' UNION ALL
  SELECT 'ready.contacted','role','front_office' UNION ALL
  SELECT 'ready.scheduled','role','owner' UNION ALL
  SELECT 'ready.scheduled','role','front_office' UNION ALL
  SELECT 'ready.vehicle','role','owner' UNION ALL
  SELECT 'ready.vehicle','role','production_manager' UNION ALL
  SELECT 'ready.vehicle','role','front_office' UNION ALL

  SELECT 'deliver.payment','role','owner' UNION ALL
  SELECT 'deliver.payment','role','front_office' UNION ALL
  SELECT 'deliver.pickup','role','owner' UNION ALL
  SELECT 'deliver.pickup','role','front_office' UNION ALL
  SELECT 'close.paperwork','role','owner' UNION ALL
  SELECT 'close.paperwork','role','accounting' UNION ALL
  SELECT 'close.paperwork','role','front_office' UNION ALL
  SELECT 'close.file','role','owner' UNION ALL
  SELECT 'close.file','role','accounting'
) AS d ON d.slot_id = s.slot_id;

-- A shop that renamed or added roles keeps only routes to roles it has. A role
-- deleted later is handled the same way by roles.ts, which repoints its rows.
DELETE r FROM status_routes r
 WHERE r.target_kind = 'role'
   AND NOT EXISTS (SELECT 1 FROM roles ro WHERE ro.role_key = r.target_key);

-- ===========================================================================
-- 3 · The type the estimate called for
-- ===========================================================================
--
-- `part_type` is what the shop is BUYING. The estimate may call for OEM and the
-- shop order aftermarket, or the reverse; both matter, so both are kept. The
-- EMS import fills the estimated column and never overwrites the ordered one.

ALTER TABLE parts_lines
  ADD COLUMN IF NOT EXISTS part_type_estimated
    ENUM('oem','aftermarket','used','recycled','reconditioned') NULL
    COMMENT 'what the estimate called for; part_type is what was ordered';

-- Every line that exists came off an estimate or was typed by hand, and in both
-- cases its current type is the only type anyone has ever recorded. Seeding the
-- estimated column from it is what makes "differs from the estimate" mean
-- something from here on rather than flagging the whole back catalogue.
UPDATE parts_lines SET part_type_estimated = part_type
 WHERE part_type_estimated IS NULL AND part_type IS NOT NULL;
