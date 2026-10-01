-- 009 — the price list billing starts on (1 Oct 2026).
--
-- One shop: $299.99 a month with 5 seats. Each additional location: $99.99 with
-- 5 seats of its own. Seats beyond that are sold per location in blocks of 5 at
-- $49.99 (the block price is in src/lib/billing.ts). Seats are per location and
-- are not pooled.
--
-- Nobody had been charged before this, so the old Starter / Growth / Multi-shop
-- rows are retired rather than priced. Every shop on one of them moves to Shop,
-- with enough seat blocks to keep the seat count it had — nobody loses capacity
-- in the move. Platform admin sets the real figure per shop afterwards.
--
-- `companies.seats` stays, and is now derived: plan seats + 5 × blocks. It is
-- written whenever either changes, so every reader of `seats` keeps working.
-- Seats warn and never refuse (routes/admin.ts).

INSERT INTO plans (code, label, seat_limit, monthly_cents, sort_order, is_active) VALUES
  ('shop',     'Shop',                5, 29999, 2, 1),
  ('location', 'Additional location', 5,  9999, 3, 1)
ON DUPLICATE KEY UPDATE label = VALUES(label), seat_limit = VALUES(seat_limit),
  monthly_cents = VALUES(monthly_cents), sort_order = VALUES(sort_order), is_active = 1;

UPDATE plans SET is_active = 0 WHERE code IN ('starter', 'growth', 'multishop');
UPDATE plans SET seat_limit = 5, sort_order = 1 WHERE code = 'trial';

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS extra_seat_blocks INT NOT NULL DEFAULT 0
    COMMENT 'blocks of 5 seats bought beyond the plan' AFTER seats;

UPDATE companies
   SET extra_seat_blocks = GREATEST(0, CEIL((seats - 5) / 5))
 WHERE extra_seat_blocks = 0;

UPDATE companies SET plan_code = 'shop'
 WHERE plan_code IN ('starter', 'growth', 'multishop');

UPDATE companies c JOIN plans p ON p.code = c.plan_code
   SET c.seats = COALESCE(p.seat_limit, 5) + 5 * c.extra_seat_blocks;
