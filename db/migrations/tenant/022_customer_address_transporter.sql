-- 022 — customer address, the transporter role, and the capability that hides
--       customer contact details from most of the shop.
--
-- Three things from a demo on 15 Sep 2026, and they belong together because the
-- new role exists mainly to see the new fields.

-- ===========================================================================
-- 1 · A lead can carry an address
-- ===========================================================================
--
-- `clients` has had address, city, state and zip since the beginning, and the
-- EMS import has filled them since migration 014 — so a repair order already
-- knows where the customer lives. A LEAD did not, which is the gap: an
-- estimate written at the counter for somebody who then has to be chased, or a
-- car that needs collecting, has nowhere to put the address.
--
-- Same column names as `clients`, so converting a lead copies them across
-- without a translation layer.

-- NOTE THE NAME: `addr_state`, not `state`. `leads.state` is already the lead's
-- status ENUM (new / contacted / estimate_written / won / lost), so a US state
-- column called `state` would collide with it — and a scrub that stripped
-- "state" for a role without the capability would have blanked every lead's
-- status instead. `clients.state` is safe because `clients` has no status
-- column, so the conversion maps `leads.addr_state` → `clients.state`.
ALTER TABLE leads ADD COLUMN address    VARCHAR(190) NULL AFTER email;
ALTER TABLE leads ADD COLUMN city       VARCHAR(90)  NULL AFTER address;
ALTER TABLE leads ADD COLUMN addr_state VARCHAR(32)  NULL AFTER city;
ALTER TABLE leads ADD COLUMN zip        VARCHAR(16)  NULL AFTER addr_state;

-- ===========================================================================
-- 2 · The capability
-- ===========================================================================
--
-- `cust_contact` governs the customer's address, city, zip, phone and email
-- wherever they appear on the board, in the file and on a lead. It is a SEE
-- capability; editing them is still `edit_ro` / the leads capability, because
-- who may correct an address is a different question from who may read it.
--
-- Why it is its own tick rather than riding on `sees_all`: a production manager
-- sees every car in the shop and has no reason to know where its owner lives.
-- The roles that need it need it for a specific job — billing, calling the
-- customer, or driving to them.
--
-- The lead's CREATOR always sees the details on their own lead, in code rather
-- than here: they typed them in, and a capability that took that away would
-- make the screen lie about what the person just entered.

INSERT INTO role_caps (role_key, cap_key, can_see, can_change) VALUES
  ('owner',        'cust_contact', 1, 1),
  ('front_office', 'cust_contact', 1, 1),
  ('accounting',   'cust_contact', 1, 0)
ON DUPLICATE KEY UPDATE can_see = VALUES(can_see), can_change = VALUES(can_change);

-- Deliberately NOT granted: estimator, production manager, parts manager,
-- salesperson, technician. A shop that wants one of those to have it ticks it
-- on the permissions screen — that is what the screen is for.

-- ===========================================================================
-- 3 · The transporter role
-- ===========================================================================
--
-- Somebody who moves vehicles. They need to know which car, where it is going
-- and who to call when they get there — and nothing about what any of it costs.
--
-- Ranked 75, between salesperson (70) and technician (80): it is not a
-- management role, and it should not outrank sales in the pickers.
--
-- `own_only` is 'none' on purpose. A transporter with "only their own work"
-- would see nothing, because nothing is assigned to a transporter — they read
-- the board and the schedule to find out what needs moving.

INSERT INTO roles (role_key, label, rank_order, locked, own_only, is_custom, note) VALUES
  ('transporter', 'Transporter', 75, 'none', 0, 0,
   'Moves vehicles. Sees the board, the schedule and leads — the vehicle, the customer and who checked it in. No money and no hours.')
ON DUPLICATE KEY UPDATE label = VALUES(label), note = VALUES(note);

-- What they can see. Every money and hours capability is absent, which is how
-- absence works here: no row means no.
--
--   sees_all      the whole board, not just assigned work
--   leads         the leads screen, read only — can_change 0
--   cust_contact  the address and phone, which is the point of the role
--
-- Not granted, and each for a reason:
--   ro_totals / parts_money / labour_money / commission — no money, as asked
--   edit_ro       they do not correct the file; they report to the desk
--   any_status    moving a car in the world is not moving it on the board
--   paperwork     a transporter has no reason to open an insurance estimate
--   assign        not theirs to assign
INSERT INTO role_caps (role_key, cap_key, can_see, can_change) VALUES
  ('transporter', 'sees_all',     1, 0),
  ('transporter', 'leads',        1, 0),
  ('transporter', 'cust_contact', 1, 0)
ON DUPLICATE KEY UPDATE can_see = VALUES(can_see), can_change = VALUES(can_change);

-- A matching position, so a transporter can be picked for a run the way a
-- trade is picked for a car. Sort order 11, after sales.
INSERT INTO positions (position_key, label, category, owner_role, sort_order) VALUES
  ('transport', 'Transporter', 'office', 'transporter', 11)
ON DUPLICATE KEY UPDATE label = VALUES(label), category = VALUES(category),
  owner_role = VALUES(owner_role), sort_order = VALUES(sort_order);
