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
  labor_hours       DECIMAL(7,2)  NOT NULL DEFAULT 0,
  target_days       INT           NULL,
  promised_at       DATE          NULL,
  opened_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at       DATETIME      NULL,
  delivered_at      DATETIME      NULL,
  closed_at         DATETIME      NULL,
  created_by        BIGINT UNSIGNED NULL,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ro_number (ro_number),
  KEY ix_ro_open (closed_at, status_slot),
  KEY ix_ro_client (client_id),
  KEY ix_ro_vehicle (vehicle_id),
  CONSTRAINT fk_ro_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
  CONSTRAINT fk_ro_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
  CONSTRAINT fk_ro_status FOREIGN KEY (status_slot) REFERENCES statuses(slot_id)
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
  note            VARCHAR(255)  NULL,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_parts_ro (ro_id, state),
  KEY ix_parts_eta (eta, state),
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
  settled_at      DATETIME      NULL,
  UNIQUE KEY uq_lead_number (lead_number),
  KEY ix_lead_state (state, received_at),
  CONSTRAINT fk_lead_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lead_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id         BIGINT UNSIGNED NOT NULL,
  kind            ENUM('note','auto') NOT NULL DEFAULT 'note',
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
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at    DATETIME      NULL,
  KEY ix_appt_day (starts_at, kind),
  KEY ix_appt_ro (ro_id),
  CONSTRAINT fk_appt_ro FOREIGN KEY (ro_id) REFERENCES repair_orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_appt_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
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
  event_key       VARCHAR(32)   NOT NULL COMMENT 'status.change, parts.arrived, parts.late, supp.decision, age.red, assign.file, sms.reply',
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
  vin             VARCHAR(24)   NULL,
  customer_name   VARCHAR(160)  NULL,
  vehicle_text    VARCHAR(160)  NULL,
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
