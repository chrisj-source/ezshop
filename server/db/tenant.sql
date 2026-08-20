-- Easy Shop — tenant (per-shop) database
-- The app runs this against a freshly created `es_<slug>` database when a
-- company is provisioned. Never run by hand except when testing.
--
-- user_id columns reference easyshop_master.users.id. They are plain BIGINTs
-- with no foreign key — cross-database FKs are not possible and not wanted.
-- Names are denormalised alongside so history survives a person leaving.

SET NAMES utf8mb4;

-- ===========================================================================
-- Shop configuration
-- ===========================================================================
CREATE TABLE shop_settings (
  setting_key     VARCHAR(64)   NOT NULL PRIMARY KEY,
  setting_value   TEXT          NULL,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('tech_sees_own_only', '1'),
  ('week_start', 'monday'),
  ('closed_days', 'sunday'),
  ('cap_drop', '6'), ('cap_pickup', '4'), ('cap_return', '5'),
  ('cap_estimate', '8'), ('cap_appraiser', '3');

-- Positions are platform-defined so reports line up across shops.
CREATE TABLE positions (
  position_key    VARCHAR(24)   NOT NULL PRIMARY KEY,
  label           VARCHAR(64)   NOT NULL,
  category        ENUM('production','management','office') NOT NULL,
  owner_role      VARCHAR(32)   NULL COMMENT 'which status owner_role this position fills',
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order      INT           NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO positions (position_key, label, category, owner_role, sort_order) VALUES
  ('pdr','PDR tech','production','pdr tech',1),
  ('body','Body tech','production','body tech',2),
  ('paint','Paint tech','production','paint tech',3),
  ('ri','R&I tech','production','r&i tech',4),
  ('detail','Detail tech','production','detail tech',5),
  ('prod','Production manager','management','production manager',6),
  ('est','Estimator','management','estimator',7),
  ('parts','Parts manager','management','parts',8),
  ('office','Front office','office','front office',9),
  ('sales','Salesperson','office',NULL,10);

-- Shop-side profile for a master user.
CREATE TABLE staff (
  user_id         BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'master users.id',
  display_name    VARCHAR(120)  NOT NULL,
  position_key    VARCHAR(24)   NULL,
  employee_code   VARCHAR(24)   NULL,
  efficiency      DECIMAL(4,2)  NULL COMMENT 'flagged hours produced per clocked hour',
  pay_basis       ENUM('hourly','flat','pct') NOT NULL DEFAULT 'hourly',
  rate_cents      BIGINT        NOT NULL DEFAULT 0 COMMENT 'per hour, or per car when flat',
  rate_pct        DECIMAL(6,3)  NOT NULL DEFAULT 0 COMMENT 'PDR only: a share of the job',
  commission_rate DECIMAL(5,2)  NULL,
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_staff_position (position_key, active),
  CONSTRAINT fk_staff_position FOREIGN KEY (position_key) REFERENCES positions(position_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Statuses, groups, lanes
-- ===========================================================================
CREATE TABLE status_groups (
  group_id        VARCHAR(24)   NOT NULL PRIMARY KEY,
  label           VARCHAR(80)   NOT NULL,
  sort_order      INT           NOT NULL DEFAULT 0,
  note            VARCHAR(500)  NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lanes (
  lane_key        VARCHAR(24)   NOT NULL PRIMARY KEY,
  label           VARCHAR(64)   NOT NULL,
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,
  parts_gate      ENUM('yes','warn','no') NOT NULL DEFAULT 'yes',
  owner_role      VARCHAR(32)   NOT NULL,
  module_tag      VARCHAR(24)   NULL,
  sort_order      INT           NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE statuses (
  slot_id             VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT 'canonical, fixed. automations bind here',
  group_id            VARCHAR(24)  NOT NULL,
  lane_key            VARCHAR(24)  NULL,
  label               VARCHAR(120) NOT NULL COMMENT 'shop editable',
  customer_label      VARCHAR(120) NULL COMMENT 'wording for the portal and texts',
  kind                ENUM('milestone','queue','active','complete') NOT NULL,
  owner_role          VARCHAR(32)  NOT NULL,
  owner_is_override   TINYINT(1)   NOT NULL DEFAULT 0,
  age_yellow_hours    INT          NULL,
  age_red_hours       INT          NULL,
  follow_up_hours     INT          NULL,
  module_tags         VARCHAR(120) NULL,
  default_next        VARCHAR(64)  NULL,
  counts_toward_cycle TINYINT(1)   NOT NULL DEFAULT 1,
  is_terminal         TINYINT(1)   NOT NULL DEFAULT 0,
  notify_customer     TINYINT(1)   NOT NULL DEFAULT 0,
  visible             TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order          INT          NOT NULL DEFAULT 0,
  KEY ix_status_group (group_id, sort_order),
  KEY ix_status_owner (owner_role),
  CONSTRAINT fk_status_group FOREIGN KEY (group_id) REFERENCES status_groups(group_id),
  CONSTRAINT fk_status_lane FOREIGN KEY (lane_key) REFERENCES lanes(lane_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Clients and vehicles
-- ===========================================================================
CREATE TABLE clients (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind            ENUM('retail','wholesale','insurance') NOT NULL,
  wholesale_type  ENUM('dealer','hail','auction','fleet') NULL,
  name            VARCHAR(190)  NOT NULL,
  contact_name    VARCHAR(120)  NULL,
  phone           VARCHAR(32)   NULL,
  email           VARCHAR(190)  NULL,
  address         VARCHAR(255)  NULL,
  city            VARCHAR(120)  NULL,
  state           VARCHAR(8)    NULL,
  zip             VARCHAR(16)   NULL,
  terms           VARCHAR(48)   NULL COMMENT 'wholesale: Net 30, per event, on delivery',
  is_drp          TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'insurance only',
  adjuster_desk   VARCHAR(120)  NULL,
  platform_locked TINYINT(1)    NOT NULL DEFAULT 0,
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_clients_kind (kind, active),
  KEY ix_clients_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE vehicles (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id       BIGINT UNSIGNED NULL,
  vin             VARCHAR(24)   NULL,
  year            SMALLINT      NULL,
  make            VARCHAR(64)   NULL,
  model           VARCHAR(96)   NULL,
  color           VARCHAR(64)   NULL,
  plate           VARCHAR(16)   NULL,
  plate_state     VARCHAR(8)    NULL,
  mileage         INT           NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_vehicles_vin (vin),
  KEY ix_vehicles_client (client_id),
  CONSTRAINT fk_vehicle_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Repair orders
-- ===========================================================================
CREATE TABLE repair_orders (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_number         VARCHAR(32)   NOT NULL,
  client_id         BIGINT UNSIGNED NULL,
  vehicle_id        BIGINT UNSIGNED NULL,
  insurer_client_id BIGINT UNSIGNED NULL COMMENT 'clients row of kind=insurance',
  ro_type           ENUM('repair','wholesale','warranty') NOT NULL DEFAULT 'repair',
  repair_path       ENUM('pdr','conventional','both','undecided') NOT NULL DEFAULT 'undecided',
  status_slot       VARCHAR(64)   NULL,
  status_since      DATETIME      NULL,
  on_hold           TINYINT(1)    NOT NULL DEFAULT 0,
  hold_reason       VARCHAR(48)   NULL,
  hold_owner        ENUM('shop','insurance','customer') NULL,
  hold_since        DATETIME      NULL,
  suspended_from    VARCHAR(64)   NULL COMMENT 'slot to return to on release',
  claim_number      VARCHAR(64)   NULL,
  policy_number     VARCHAR(64)   NULL,
  date_of_loss      DATE          NULL,
  adjuster          VARCHAR(120)  NULL,
  amount_cents      BIGINT        NOT NULL DEFAULT 0,
  deductible_cents  BIGINT        NOT NULL DEFAULT 0,
  deductible_waived TINYINT(1)    NOT NULL DEFAULT 0,
  parts_cost_cents  BIGINT        NOT NULL DEFAULT 0,
  sublet_cost_cents BIGINT        NOT NULL DEFAULT 0,
  rental_cost_cents BIGINT        NOT NULL DEFAULT 0,
  towing_cost_cents BIGINT        NOT NULL DEFAULT 0,
  materials_cost_cents BIGINT     NOT NULL DEFAULT 0,
  discount_cents    BIGINT        NOT NULL DEFAULT 0,
  shortpay_cents    BIGINT        NOT NULL DEFAULT 0,
  deductible_cents  BIGINT        NOT NULL DEFAULT 0 COMMENT 'what the customer owes',
  deductible_collect TINYINT(1)   NOT NULL DEFAULT 1,
  deductible_charge_cents BIGINT  NOT NULL DEFAULT 0 COMMENT 'what we are actually charging',
  rental_provider   VARCHAR(32)   NULL COMMENT 'Avis, Budget, Enterprise, Hertz, Loaner',
  rental_covered    TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'policy covers it, so there is reimbursement to chase',
  commission_payable TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'marked on the sales pay side, per file',
  materials_flat_cents BIGINT     NOT NULL DEFAULT 0 COMMENT 'used when there are no paint hours',
  labor_hours       DECIMAL(7,2)  NOT NULL DEFAULT 0,
  target_days       INT           NULL,
  promised_at       DATE          NULL,
  opened_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at       DATETIME      NULL,
  delivered_at      DATETIME      NULL,
  closed_at         DATETIME      NULL,
  close_date        DATE          NULL COMMENT 'the books date, set and re-set by hand',
  closed_by         BIGINT UNSIGNED NULL,
  paid              TINYINT(1)    NOT NULL DEFAULT 0,
  paid_at           DATETIME      NULL,
  total_loss_at     DATETIME      NULL COMMENT 'own flag, like void. the board draws lane 00 from it',
  total_loss_by     BIGINT UNSIGNED NULL,
  total_loss_note   VARCHAR(255)  NULL,
  voided_at         DATETIME      NULL COMMENT 'own flag, not a status and not a hold',
  voided_days       INT           NOT NULL DEFAULT 0 COMMENT 'days spent voided, subtracted from days in shop',
  reopen_count      INT           NOT NULL DEFAULT 0,
  created_by        BIGINT UNSIGNED NULL,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ro_number (ro_number),
  KEY ix_ro_open (closed_at, status_slot),
  KEY ix_ro_close_date (close_date, paid),
  KEY ix_ro_total_loss (total_loss_at),
  KEY ix_ro_voided (voided_at),
  KEY ix_ro_client (client_id),
  KEY ix_ro_vehicle (vehicle_id),
  CONSTRAINT fk_ro_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
  CONSTRAINT fk_ro_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
  CONSTRAINT fk_ro_status FOREIGN KEY (status_slot) REFERENCES statuses(slot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per void, kept after a reopen so the void report can show what was
-- voided, why, by whom, and which of them came back. The file itself is the
-- same record throughout: void and reopen are states it passes through.
CREATE TABLE ro_voids (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id             BIGINT UNSIGNED NOT NULL,
  ro_number         VARCHAR(32)   NOT NULL COMMENT 'number the file held when it was voided',
  reason            VARCHAR(48)   NOT NULL,
  note              VARCHAR(255)  NULL,
  status_slot       VARCHAR(64)   NULL COMMENT 'slot it was sitting in',
  amount_cents      BIGINT        NOT NULL DEFAULT 0,
  parts_cancelled   INT           NOT NULL DEFAULT 0,
  parts_flagged     INT           NOT NULL DEFAULT 0 COMMENT 'already ordered, flagged for return',
  voided_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by         BIGINT UNSIGNED NULL,
  voided_by_name    VARCHAR(120)  NULL,
  reopened_at       DATETIME      NULL,
  reopened_by       BIGINT UNSIGNED NULL,
  reopened_by_name  VARCHAR(120)  NULL,
  reopened_number   VARCHAR(32)   NULL COMMENT 'number it came back under',
  KEY ix_voids_ro (ro_id),
  KEY ix_voids_when (voided_at),
  CONSTRAINT fk_voids_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ro_assignments (
  ro_id           BIGINT UNSIGNED NOT NULL,
  position_key    VARCHAR(24)   NOT NULL COMMENT 'sales, pdr, body, paint, ri',
  user_id         BIGINT UNSIGNED NULL,
  display_name    VARCHAR(120)  NULL,
  assigned_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by     BIGINT UNSIGNED NULL,
  PRIMARY KEY (ro_id, position_key),
  KEY ix_assign_user (user_id),
  CONSTRAINT fk_assign_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every status move. This is what cycle time, touch time and the
-- "who moved it and when" line on the drawer are computed from.
CREATE TABLE ro_status_history (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  from_slot       VARCHAR(64)   NULL,
  to_slot         VARCHAR(64)   NOT NULL,
  from_label      VARCHAR(120)  NULL COMMENT 'label at the time of the move',
  to_label        VARCHAR(120)  NULL,
  lane_changed    TINYINT(1)    NOT NULL DEFAULT 0,
  reason          VARCHAR(255)  NULL,
  is_rework       TINYINT(1)    NOT NULL DEFAULT 0,
  user_id         BIGINT UNSIGNED NULL,
  user_name       VARCHAR(120)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_hist_ro (ro_id, created_at),
  CONSTRAINT fk_hist_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ro_notes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  kind            ENUM('note','auto','customer','insurance','sms','email') NOT NULL DEFAULT 'note',
  body            TEXT          NOT NULL,
  user_id         BIGINT UNSIGNED NULL,
  user_name       VARCHAR(120)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_notes_ro (ro_id, created_at),
  CONSTRAINT fk_notes_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ro_promises (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  body            VARCHAR(255)  NOT NULL,
  done            TINYINT(1)    NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_prom_ro (ro_id),
  CONSTRAINT fk_prom_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Documents
-- ===========================================================================
CREATE TABLE documents (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  doc_type        VARCHAR(64)   NOT NULL,
  label           VARCHAR(190)  NOT NULL,
  storage_key     VARCHAR(255)  NOT NULL COMMENT 'path on disk or object key',
  mime_type       VARCHAR(96)   NULL,
  size_bytes      BIGINT        NOT NULL DEFAULT 0,
  is_money_doc    TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'hidden from roles without money access',
  version_of      BIGINT UNSIGNED NULL,
  uploaded_by     BIGINT UNSIGNED NULL,
  uploaded_name   VARCHAR(120)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      DATETIME      NULL,
  KEY ix_doc_ro (ro_id, created_at),
  CONSTRAINT fk_doc_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Supplements and sublet
-- ===========================================================================
CREATE TABLE supplements (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id             BIGINT UNSIGNED NOT NULL,
  seq               INT           NOT NULL COMMENT '0 = the original estimate',
  state             ENUM('draft','sent','awaiting','approved','partial','denied') NOT NULL DEFAULT 'draft',
  block_level       ENUM('hard','soft','none') NOT NULL DEFAULT 'soft',
  requested_cents   BIGINT        NOT NULL DEFAULT 0,
  approved_cents    BIGINT        NOT NULL DEFAULT 0,
  sent_at           DATE          NULL,
  decided_at        DATE          NULL,
  note              VARCHAR(400)  NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_supp_seq (ro_id, seq),
  KEY ix_supp_state (state),
  CONSTRAINT fk_supp_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sublets (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  service         VARCHAR(64)   NOT NULL COMMENT 'ADAS calibration, glass, alignment, stripes, wrap…',
  vendor          VARCHAR(160)  NULL,
  state           ENUM('scheduled','out','returned','invoiced') NOT NULL DEFAULT 'scheduled',
  out_at          DATE          NULL,
  back_at         DATE          NULL,
  cost_cents      BIGINT        NOT NULL DEFAULT 0,
  po_number       VARCHAR(48)   NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sublet_ro (ro_id),
  CONSTRAINT fk_sublet_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Parts
-- ===========================================================================
CREATE TABLE vendors (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(160)  NOT NULL,
  kind            VARCHAR(48)   NULL,
  phone           VARCHAR(32)   NULL,
  email           VARCHAR(190)  NULL,
  active          TINYINT(1)    NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE parts_lines (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  supplement_id   BIGINT UNSIGNED NULL COMMENT 'which supplement added it',
  vendor_id       BIGINT UNSIGNED NULL,
  line_no         INT           NULL COMMENT 'line number on the estimate',
  description     VARCHAR(255)  NOT NULL,
  part_number     VARCHAR(64)   NULL,
  part_type       ENUM('oem','aftermarket','used','recycled','reconditioned') NULL,
  qty             INT           NOT NULL DEFAULT 1,
  qty_received    INT           NOT NULL DEFAULT 0,
  price_cents     BIGINT        NOT NULL DEFAULT 0 COMMENT 'what the estimate pays',
  cost_cents      BIGINT        NOT NULL DEFAULT 0 COMMENT 'what the shop pays the vendor',
  po_number       VARCHAR(48)   NULL,
  invoice_no      VARCHAR(48)   NULL,
  state           ENUM('need','ordered','partial','received','backordered','returned','not_needed')
                    NOT NULL DEFAULT 'need',
  gating          TINYINT(1)    NOT NULL DEFAULT 1 COMMENT 'holds the parts gate',
  ordered_at      DATE          NULL,
  eta             DATE          NULL,
  received_at     DATE          NULL,
  return_flagged_at DATETIME    NULL COMMENT 'ordered against a file that was voided',
  return_cleared_at DATETIME    NULL,
  note            VARCHAR(255)  NULL,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_parts_ro (ro_id, state),
  KEY ix_parts_eta (eta, state),
  KEY ix_parts_returns (return_flagged_at, return_cleared_at),
  CONSTRAINT fk_parts_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_parts_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL,
  CONSTRAINT fk_parts_supp FOREIGN KEY (supplement_id) REFERENCES supplements(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Leads
-- ===========================================================================
CREATE TABLE leads (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_number     VARCHAR(24)   NOT NULL,
  source          VARCHAR(48)   NOT NULL COMMENT 'phone, walk-in, website, referral, google, scheduler, sales app',
  state           ENUM('new','contacted','estimate_sent','appraisal_booked','won','lost') NOT NULL DEFAULT 'new',
  lost_reason     VARCHAR(64)   NULL,
  first_name      VARCHAR(80)   NULL,
  last_name       VARCHAR(80)   NULL,
  phone           VARCHAR(32)   NULL,
  email           VARCHAR(190)  NULL,
  vehicle_text    VARCHAR(160)  NULL,
  damage_note     VARCHAR(400)  NULL,
  owner_user_id   BIGINT UNSIGNED NULL,
  contract_doc_id BIGINT UNSIGNED NULL COMMENT 'photo from the sales app',
  appointment_id  BIGINT UNSIGNED NULL,
  ro_id           BIGINT UNSIGNED NULL COMMENT 'set when converted',
  received_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_reply_at  DATETIME      NULL,
  last_followup_at DATETIME     NULL,
  followup_snooze_until DATE     NULL COMMENT 'set by hand to hold it longer',
  settled_at      DATETIME      NULL,
  deleted_at      DATETIME      NULL COMMENT 'soft delete, like a void',
  deleted_by      BIGINT UNSIGNED NULL,
  delete_reason   VARCHAR(64)   NULL,
  UNIQUE KEY uq_lead_number (lead_number),
  KEY ix_lead_state (state, received_at),
  KEY ix_lead_deleted (deleted_at),
  CONSTRAINT fk_lead_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lead_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id         BIGINT UNSIGNED NOT NULL,
  kind            ENUM('note','auto','followup','appointment') NOT NULL DEFAULT 'note',
  body            VARCHAR(500)  NOT NULL,
  user_id         BIGINT UNSIGNED NULL,
  user_name       VARCHAR(120)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_levent_lead (lead_id, created_at),
  CONSTRAINT fk_levent_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Scheduler
-- ===========================================================================
CREATE TABLE appointments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind            ENUM('drop','pickup','return','estimate','appraiser') NOT NULL,
  starts_at       DATETIME      NOT NULL,
  duration_min    INT           NOT NULL DEFAULT 30,
  ro_id           BIGINT UNSIGNED NULL,
  lead_id         BIGINT UNSIGNED NULL,
  customer_name   VARCHAR(160)  NOT NULL,
  vehicle_text    VARCHAR(160)  NULL,
  phone           VARCHAR(32)   NULL,
  note            VARCHAR(255)  NULL,
  remind_1d       TINYINT(1)    NOT NULL DEFAULT 1,
  remind_12h      TINYINT(1)    NOT NULL DEFAULT 1,
  gcal_event_id   VARCHAR(128)  NULL,
  created_by      BIGINT UNSIGNED NULL,
  assigned_user_id BIGINT UNSIGNED NULL COMMENT 'whose day this sits in, for conflicts',
  override_note   VARCHAR(255)  NULL COMMENT 'what was overridden when this was booked',
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at    DATETIME      NULL,
  KEY ix_appt_day (starts_at, kind),
  KEY ix_appt_assigned (assigned_user_id, starts_at),
  KEY ix_appt_ro (ro_id),
  CONSTRAINT fk_appt_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_appt_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Time an employee is off. A layer over the week, not an appointment type: a
-- date range, optionally narrowed to hours within the day. Owner maintained.
CREATE TABLE employee_time_off (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  display_name  VARCHAR(120)  NOT NULL COMMENT 'copied so the block reads right if the person leaves',
  starts_on     DATE          NOT NULL,
  ends_on       DATE          NOT NULL COMMENT 'inclusive',
  start_time    TIME          NULL COMMENT 'null = from the start of the day',
  end_time      TIME          NULL COMMENT 'null = to the end of the day',
  reason        VARCHAR(120)  NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_name  VARCHAR(120)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at  DATETIME      NULL,
  KEY ix_off_span (starts_on, ends_on),
  KEY ix_off_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The shop's Google Calendar link. Push only: appointments are written out,
-- nothing is read back in.
CREATE TABLE calendar_connections (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider       VARCHAR(24)   NOT NULL DEFAULT 'google',
  calendar_id    VARCHAR(190)  NULL COMMENT 'which calendar appointments land on',
  calendar_name  VARCHAR(190)  NULL,
  account_email  VARCHAR(190)  NULL,
  access_token   TEXT          NULL,
  refresh_token  TEXT          NULL,
  expires_at     DATETIME      NULL,
  state          ENUM('connected','error','disconnected') NOT NULL DEFAULT 'connected',
  last_error     VARCHAR(255)  NULL,
  last_push_at   DATETIME      NULL,
  connected_by   BIGINT UNSIGNED NULL,
  connected_name VARCHAR(120)  NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cal_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Notifications
-- ===========================================================================
CREATE TABLE notification_groups (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(120)  NOT NULL,
  description     VARCHAR(255)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_group_members (
  group_id        BIGINT UNSIGNED NOT NULL,
  member_type     ENUM('position','user') NOT NULL,
  position_key    VARCHAR(24)   NULL,
  user_id         BIGINT UNSIGNED NULL,
  PRIMARY KEY (group_id, member_type, position_key, user_id),
  CONSTRAINT fk_ngm_group FOREIGN KEY (group_id) REFERENCES notification_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_subscriptions (
  group_id        BIGINT UNSIGNED NOT NULL,
  event_key       VARCHAR(32)   NOT NULL COMMENT 'status.change, parts.arrived, parts.late, parts.return, supp.decision, age.red, assign.file, sms.reply',
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,
  scope           VARCHAR(48)   NULL COMMENT 'owned | any | picked',
  scope_detail    JSON          NULL COMMENT 'picked slot ids, ETA offsets',
  channel_app     TINYINT(1)    NOT NULL DEFAULT 1,
  channel_email   TINYINT(1)    NOT NULL DEFAULT 0,
  channel_sms     TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, event_key),
  CONSTRAINT fk_nsub_group FOREIGN KEY (group_id) REFERENCES notification_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  group_id        BIGINT UNSIGNED NULL,
  event_key       VARCHAR(32)   NOT NULL,
  ro_id           BIGINT UNSIGNED NULL,
  lead_id         BIGINT UNSIGNED NULL,
  title           VARCHAR(120)  NOT NULL,
  body            VARCHAR(500)  NOT NULL,
  dedupe_key      VARCHAR(190)  NULL COMMENT 'one per person per event per file',
  read_at         DATETIME      NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notif_dedupe (user_id, dedupe_key),
  KEY ix_notif_inbox (user_id, read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- EMS imports
-- A file lands, is parsed, and WAITS. Nothing touches a repair order until
-- someone accepts it on the import screen.
-- ===========================================================================
CREATE TABLE ems_imports (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source          ENUM('agent','upload') NOT NULL DEFAULT 'agent',
  agent_label     VARCHAR(120)  NULL,
  estimating_system VARCHAR(32) NULL COMMENT 'ccc, mitchell, audatex',
  envelope_name   VARCHAR(190)  NULL COMMENT 'the EMS set name, eg a9062516',
  ro_number       VARCHAR(32)   NULL COMMENT 'parsed from the file',
  claim_number    VARCHAR(64)   NULL,
  insurer_name    VARCHAR(190)  NULL COMMENT 'carrier as the estimate wrote it',
  policy_number   VARCHAR(64)   NULL,
  deductible_cents BIGINT       NULL,
  deductible_waived TINYINT(1)  NOT NULL DEFAULT 0,
  date_of_loss    DATE          NULL,
  adjuster        VARCHAR(120)  NULL,
  estimator       VARCHAR(120)  NULL,
  vin             VARCHAR(24)   NULL,
  customer_name   VARCHAR(160)  NULL,
  vehicle_text    VARCHAR(160)  NULL,
  vehicle_color   VARCHAR(48)   NULL,
  plate           VARCHAR(16)   NULL,
  plate_state     VARCHAR(8)    NULL,
  mileage         INT           NULL,
  supplement_seq  INT           NULL,
  total_cents     BIGINT        NULL,
  line_count      INT           NULL,
  matched_ro_id   BIGINT UNSIGNED NULL,
  match_confidence ENUM('exact','likely','none') NOT NULL DEFAULT 'none',
  state           ENUM('pending','accepted','rejected','failed','superseded') NOT NULL DEFAULT 'pending',
  parse_error     VARCHAR(500)  NULL,
  storage_key     VARCHAR(255)  NULL COMMENT 'folder holding the raw file set on disk',
  received_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at      DATETIME      NULL,
  decided_by      BIGINT UNSIGNED NULL,
  KEY ix_ems_state (state, received_at),
  KEY ix_ems_ro (matched_ro_id),
  CONSTRAINT fk_ems_ro FOREIGN KEY (matched_ro_id) REFERENCES repair_orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ems_import_lines (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  import_id       BIGINT UNSIGNED NOT NULL,
  line_no         INT           NULL,
  operation       VARCHAR(32)   NULL,
  description     VARCHAR(255)  NULL,
  part_number     VARCHAR(64)   NULL,
  part_type       VARCHAR(24)   NULL,
  qty             INT           NULL,
  price_cents     BIGINT        NULL,
  labor_hours     DECIMAL(7,2)  NULL,
  labor_type      VARCHAR(24)   NULL,
  is_new          TINYINT(1)    NOT NULL DEFAULT 1 COMMENT 'new since the last accepted import',
  KEY ix_emsline_import (import_id),
  CONSTRAINT fk_emsline_import FOREIGN KEY (import_id) REFERENCES ems_imports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Shop-level audit
-- ===========================================================================
CREATE TABLE audit_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NULL,
  user_name       VARCHAR(120)  NULL,
  entity          VARCHAR(32)   NOT NULL,
  entity_id       BIGINT UNSIGNED NULL,
  action          VARCHAR(48)   NOT NULL,
  detail          JSON          NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_entity (entity, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
-- Roles the shop owns
-- ===========================================================================
CREATE TABLE roles (
  role_key      VARCHAR(32)   NOT NULL PRIMARY KEY,
  label         VARCHAR(64)   NOT NULL,
  rank_order    INT           NOT NULL DEFAULT 100 COMMENT 'lower ranks higher; picks the primary role',
  locked        ENUM('none','owner','tech') NOT NULL DEFAULT 'none',
  own_only      TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'only sees work assigned to them',
  is_custom     TINYINT(1)    NOT NULL DEFAULT 0,
  note          VARCHAR(255)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_roles_rank (rank_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE role_caps (
  role_key      VARCHAR(32)   NOT NULL,
  cap_key       VARCHAR(32)   NOT NULL,
  can_see       TINYINT(1)    NOT NULL DEFAULT 0,
  can_change    TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (role_key, cap_key),
  CONSTRAINT fk_role_caps_role FOREIGN KEY (role_key) REFERENCES roles(role_key) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO roles (role_key, label, rank_order, locked, own_only, is_custom, note) VALUES
  ('owner','Owner',10,'owner',0,0,'Holds everything and cannot be reduced.'),
  ('accounting','Accounting',20,'none',0,0,NULL),
  ('estimator','Estimator',30,'none',0,0,NULL),
  ('production_manager','Production manager',40,'none',0,0,NULL),
  ('parts_manager','Parts manager',50,'none',0,0,NULL),
  ('front_office','Front office',60,'none',0,0,NULL),
  ('salesperson','Salesperson',70,'none',1,0,'Sees their own leads and their own files.'),
  ('technician','Technician',80,'tech',1,0,'Locked because the lane rules hang off trades.');

INSERT INTO role_caps (role_key, cap_key, can_see, can_change) VALUES
  ('owner','ro_totals',1,1),('owner','parts_money',1,1),('owner','labour_money',1,1),
  ('owner','commission',1,1),('owner','sees_all',1,1),('owner','edit_ro',1,1),
  ('owner','any_status',1,1),('owner','total_loss',1,1),('owner','void_ro',1,1),
  ('owner','close_ro',1,1),('owner','unclose',1,1),('owner','leads',1,1),
  ('owner','del_lead',1,1),('owner','paperwork',1,1),('owner','del_doc',1,1),
  ('owner','imports',1,1),('owner','assign',1,1),('owner','parts',1,1),
  ('owner','sublet',1,1),('owner','reports',1,1),('owner','money_reports',1,1),
  ('owner','pay_plans',1,1),('owner','admin',1,1),('owner','perms',1,1),
  ('accounting','ro_totals',1,1),('accounting','parts_money',1,0),('accounting','labour_money',1,0),
  ('accounting','commission',1,1),('accounting','sees_all',1,0),('accounting','close_ro',1,1),
  ('accounting','unclose',1,1),('accounting','leads',1,0),('accounting','paperwork',1,1),
  ('accounting','reports',1,1),('accounting','money_reports',1,0),('accounting','pay_plans',1,1),
  ('estimator','ro_totals',1,1),('estimator','parts_money',1,1),('estimator','labour_money',1,1),
  ('estimator','commission',1,0),('estimator','sees_all',1,0),('estimator','edit_ro',1,1),
  ('estimator','any_status',1,1),('estimator','total_loss',1,1),('estimator','close_ro',1,0),
  ('estimator','leads',1,1),('estimator','del_lead',1,1),('estimator','paperwork',1,1),
  ('estimator','del_doc',1,1),('estimator','imports',1,1),('estimator','assign',1,1),
  ('estimator','parts',1,1),('estimator','sublet',1,1),('estimator','reports',1,0),
  ('estimator','money_reports',1,0),
  ('production_manager','labour_money',1,0),('production_manager','sees_all',1,0),
  ('production_manager','edit_ro',1,1),('production_manager','any_status',1,1),
  ('production_manager','total_loss',1,0),('production_manager','paperwork',1,1),
  ('production_manager','imports',1,1),('production_manager','assign',1,1),
  ('production_manager','parts',1,1),('production_manager','sublet',1,1),
  ('production_manager','reports',1,0),
  ('parts_manager','parts_money',1,1),('parts_manager','sees_all',1,0),
  ('parts_manager','paperwork',1,0),('parts_manager','parts',1,1),('parts_manager','sublet',1,1),
  ('front_office','ro_totals',1,0),('front_office','sees_all',1,0),('front_office','edit_ro',1,1),
  ('front_office','any_status',1,1),('front_office','close_ro',1,1),('front_office','leads',1,1),
  ('front_office','del_lead',1,0),('front_office','paperwork',1,1),
  ('salesperson','sees_all',1,0),('salesperson','leads',1,1),('salesperson','paperwork',1,0),
  ('technician','sees_all',1,0),('technician','labour_money',1,0);

-- ===========================================================================
-- Pay: the stamps, the plans, the ledger
-- ===========================================================================
CREATE TABLE ro_triggers (
  ro_id          BIGINT UNSIGNED NOT NULL,
  trigger_key    ENUM('arrived','approval','car_gone','file_closed') NOT NULL,
  fired_at       DATETIME      NOT NULL COMMENT 'when the event happened, not when the row was written',
  fired_by       BIGINT UNSIGNED NULL,
  fired_by_name  VARCHAR(120)  NULL,
  source         ENUM('auto','manual') NOT NULL DEFAULT 'auto',
  corrected_at   DATETIME      NULL,
  note           VARCHAR(255)  NULL,
  PRIMARY KEY (ro_id, trigger_key),
  KEY ix_trig_fired (trigger_key, fired_at),
  CONSTRAINT fk_trig_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pay_plans (
  user_id           BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'master users.id',
  mode              ENUM('net','flat') NOT NULL DEFAULT 'net',
  rate_pct          DECIMAL(6,3)  NOT NULL DEFAULT 0,
  pay_when          ENUM('approval','car_gone','file_closed') NOT NULL DEFAULT 'file_closed',
  drop_on           TINYINT(1)    NOT NULL DEFAULT 0,
  drop_fee_cents    BIGINT        NOT NULL DEFAULT 0 COMMENT 'paid out when the car arrives',
  drop_recover      TINYINT(1)    NOT NULL DEFAULT 1,
  tl_amount_cents   BIGINT        NOT NULL DEFAULT 0 COMMENT 'what a total loss pays instead of a commission',
  tl_pay_drop       TINYINT(1)    NOT NULL DEFAULT 0,
  active            TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by        BIGINT UNSIGNED NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pay_plan_deductions (
  user_id       BIGINT UNSIGNED NOT NULL,
  deduct_key    VARCHAR(24)   NOT NULL,
  PRIMARY KEY (user_id, deduct_key),
  CONSTRAINT fk_ppd_plan FOREIGN KEY (user_id) REFERENCES pay_plans(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A paid line is never rewritten; what changes after payment lands as an
-- 'adjustment' against the next period.
CREATE TABLE commission_lines (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ro_id           BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL COMMENT 'the salesperson',
  kind            ENUM('drop','commission','total_loss','recovery','adjustment') NOT NULL,
  amount_cents    BIGINT        NOT NULL COMMENT 'signed',
  basis_cents     BIGINT        NOT NULL DEFAULT 0,
  rate_pct        DECIMAL(6,3)  NOT NULL DEFAULT 0,
  trigger_key     ENUM('arrived','approval','car_gone','file_closed') NULL,
  earned_at       DATETIME      NOT NULL,
  period_end      DATE          NOT NULL,
  run_id          BIGINT UNSIGNED NULL,
  paid_at         DATETIME      NULL,
  paid_cents      BIGINT        NULL,
  supersedes_id   BIGINT UNSIGNED NULL,
  note            VARCHAR(255)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_cl_person (user_id, period_end),
  KEY ix_cl_ro (ro_id, kind),
  KEY ix_cl_unpaid (paid_at, period_end),
  CONSTRAINT fk_cl_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE commission_runs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  period_end    DATE          NOT NULL,
  run_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  run_by        BIGINT UNSIGNED NULL,
  run_by_name   VARCHAR(120)  NULL,
  paid_at       DATETIME      NULL,
  total_cents   BIGINT        NOT NULL DEFAULT 0,
  people        INT           NOT NULL DEFAULT 0,
  note          VARCHAR(255)  NULL,
  KEY ix_run_period (period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('pay_period_end', 'tuesday'),
  ('sales_tax_rate', '8.25')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- ===========================================================================
-- The close-out sheet
-- ===========================================================================
CREATE TABLE ro_labour (
  ro_id         BIGINT UNSIGNED NOT NULL,
  position_key  VARCHAR(24)   NOT NULL COMMENT 'pdr, body, paint, ri, detail',
  basis         ENUM('hours','flat','ems','pct') NOT NULL,
  hours         DECIMAL(7,2)  NOT NULL DEFAULT 0,
  rate_cents    BIGINT        NOT NULL DEFAULT 0 COMMENT 'the rate used, so history survives a rate change',
  rate_pct      DECIMAL(6,3)  NOT NULL DEFAULT 0,
  pct_after_costs TINYINT(1)  NOT NULL DEFAULT 0 COMMENT 'PDR: a share of what is left, not of the approval',
  cost_cents    BIGINT        NOT NULL DEFAULT 0,
  user_id       BIGINT UNSIGNED NULL COMMENT 'who it is owed to',
  display_name  VARCHAR(120)  NULL,
  entered_by    BIGINT UNSIGNED NULL,
  entered_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (ro_id, position_key),
  KEY ix_labour_user (user_id),
  CONSTRAINT fk_labour_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kept rather than recomputed, so a rate change next month does not rewrite what
-- last month made.
CREATE TABLE ro_profit (
  ro_id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  approval_cents    BIGINT NOT NULL DEFAULT 0,
  deductible_given_cents BIGINT NOT NULL DEFAULT 0,
  promises_cents    BIGINT NOT NULL DEFAULT 0,
  rental_cents      BIGINT NOT NULL DEFAULT 0 COMMENT 'what the shop carried, so nil on a covered rental',
  parts_cents       BIGINT NOT NULL DEFAULT 0,
  labour_cents      BIGINT NOT NULL DEFAULT 0,
  materials_cents   BIGINT NOT NULL DEFAULT 0,
  sublet_cents      BIGINT NOT NULL DEFAULT 0,
  sales_pay_cents   BIGINT NOT NULL DEFAULT 0,
  profit_cents      BIGINT NOT NULL DEFAULT 0,
  profit_pct        DECIMAL(6,2) NOT NULL DEFAULT 0 COMMENT 'of the approval amount',
  settled_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  settled_by        BIGINT UNSIGNED NULL,
  CONSTRAINT fk_profit_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shop_settings (setting_key, setting_value) VALUES
  ('materials_rate_cents', '4200'),
  ('thin_profit_pct', '25')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
