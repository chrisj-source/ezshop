-- 037 — status update texts, and who hears about a reply.
--
-- sms_templates: one row per update. The trigger_key is ours and fixed — it is
-- what lib/sms-status.ts binds to statuses and lanes — and the wording is the
-- shop's. Defaults written 1 Oct 2026, each one text (160 characters) with the
-- STOP line on a typical file. Seven are on, which keeps a normal file inside
-- the 4-8 messages per vehicle published in the SMS terms. The lane updates are
-- written but off: with them on a normal file goes past that figure.
--
-- INSERT IGNORE, because provisioning replays migrations: a shop's edited
-- wording must never be put back to ours.

CREATE TABLE IF NOT EXISTS sms_templates (
  trigger_key  VARCHAR(32)  NOT NULL PRIMARY KEY,
  label        VARCHAR(80)  NOT NULL,
  note         VARCHAR(160) NOT NULL DEFAULT '',
  body         VARCHAR(480) NOT NULL,
  enabled      TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order   INT          NOT NULL DEFAULT 0,
  updated_by   BIGINT UNSIGNED NULL,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sms_templates (trigger_key, label, note, body, enabled, sort_order) VALUES
('arrived', 'Vehicle Arrived', 'Intake', 'Hi [ first name ], thank you for trusting us with your [ vehicle ]. Check-in is complete. We will text you as the repair moves along.', 1, 10),
('est_sent', 'Estimate / Supplement Sent', 'Insurance files, first estimate only', 'Hi [ first name ], the estimate for your [ vehicle ] has gone to your insurance. We will let you know when it is approved.', 0, 20),
('supp_needed', 'Supplement Needed', 'Back to Estimate / Supplement Needed after the first approval', 'Hi [ first name ], we found more damage on your [ vehicle ] and are contacting your insurance. We will reach out to explain what is next.', 1, 30),
('approved', 'Estimate / Supplement Approved', 'First approval only', 'Good news [ first name ], the repair on your [ vehicle ] is approved. We are ordering parts and scheduling the work.', 1, 40),
('parts_ordered', 'Parts Ordered', '', 'Hi [ first name ], parts for your [ vehicle ] are on order. We will start as soon as they arrive.', 0, 50),
('parts_backordered', 'Parts Backordered', '', 'Hi [ first name ], a part for your [ vehicle ] is backordered. We are on it and will update you. Questions: [ shop phone ].', 1, 60),
('lane_pdr', 'PDR', 'Entering the PDR lane', 'Hi [ first name ], your [ vehicle ] is in PDR. Our technicians are working the dents out now.', 0, 70),
('lane_body', 'Body', 'Entering the Body lane', 'Hi [ first name ], your [ vehicle ] is in body repair.', 0, 80),
('lane_paint', 'Paint', 'Entering Prep or Paint', 'Hi [ first name ], your [ vehicle ] is in paint.', 0, 90),
('lane_reassembly', 'Reassembly', 'Entering the Reassembly lane', 'Hi [ first name ], your [ vehicle ] is being put back together.', 0, 100),
('sublet', 'At Sublet', '', 'Hi [ first name ], your [ vehicle ] is at a partner shop for part of the repair and comes back to us after.', 0, 110),
('lane_buff', 'Buff', 'Entering the Buff lane', 'Hi [ first name ], your [ vehicle ] is in buff, the finishing step after paint.', 0, 120),
('detail', 'Final Detail', 'Final Detail, or the Detail lane', 'Hi [ first name ], your [ vehicle ] is being detailed. Almost there.', 0, 130),
('final_qc', 'Final QC', '', 'Hi [ first name ], your [ vehicle ] is in final quality check. Almost there.', 0, 140),
('payment', 'Payment verification', 'Payment Verified status', 'Hi [ first name ], repairs on your [ vehicle ] are complete. We are verifying payment, which must be done before it can be released.', 1, 150),
('contacted', 'Customer Contacted', 'Ready group', 'Hi [ first name ], your [ vehicle ] is ready. We will reach out soon to schedule pickup. Questions: [ shop phone ].', 0, 160),
('ready', 'Vehicle Ready', '', 'Hi [ first name ], your [ vehicle ] is ready for pickup at [ shop name ]. Call [ shop phone ] to set a time.', 1, 170),
('picked', 'Picked Up', '', 'Thank you [ first name ], enjoy your [ vehicle ]. Call [ shop phone ] if anything needs a second look.', 1, 180);

-- Who is told when a customer texts back. 'file_owner' is the estimator on the
-- file, or whoever opened it when no estimator is assigned; every other key is
-- a role. Defaults as given 1 Oct 2026.
CREATE TABLE IF NOT EXISTS sms_reply_routing (
  target       VARCHAR(40)  NOT NULL PRIMARY KEY,
  enabled      TINYINT(1)   NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sms_reply_routing (target, enabled) VALUES
('file_owner', 1), ('front_office', 1), ('production_manager', 1), ('owner', 1);
