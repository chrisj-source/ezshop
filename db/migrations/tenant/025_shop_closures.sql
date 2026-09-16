-- 025 — closures: holidays, half days, and any date the shop picks.
--
-- `shop_hours` (024) is the ordinary week. This is the exception list, because
-- a shop's real calendar is a weekly pattern plus a handful of specific dates
-- that do not follow it — and the Fourth of July is not a Saturday.
--
-- One row per date. A date with `kind = 'closed'` overrides the weekday
-- entirely; `kind = 'hours'` replaces that day's window, which is how Christmas
-- Eve becomes an eight-to-noon rather than an all-or-nothing.
--
-- `source` separates the ones the shop ticked from a preset list from the ones
-- somebody typed. It matters because the preset list is regenerated each year:
-- re-ticking Thanksgiving for 2027 must not wipe the Tuesday in March the owner
-- closed for a funeral.
--
-- `holiday_key` is stable across years ('thanksgiving', 'christmas_eve'), so
-- "we observe these" is remembered and next year's dates are offered already
-- ticked rather than asked again from scratch.

CREATE TABLE IF NOT EXISTS shop_closures (
  on_date      DATE         NOT NULL,
  kind         ENUM('closed','hours') NOT NULL DEFAULT 'closed',
  open_time    TIME         NULL COMMENT 'kind = hours only',
  close_time   TIME         NULL COMMENT 'kind = hours only',
  label        VARCHAR(80)  NOT NULL,
  source       ENUM('holiday','manual') NOT NULL DEFAULT 'manual',
  holiday_key  VARCHAR(40)  NULL COMMENT 'stable across years, e.g. christmas_eve',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (on_date),
  KEY ix_closure_year (on_date, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which holidays this shop observes at all, remembered by key so next year's
-- dates can be offered pre-ticked. A row here means "we observe this"; the
-- dates themselves live above.
CREATE TABLE IF NOT EXISTS shop_holiday_prefs (
  holiday_key  VARCHAR(40)  NOT NULL,
  observed     TINYINT(1)   NOT NULL DEFAULT 1,
  kind         ENUM('closed','hours') NOT NULL DEFAULT 'closed',
  open_time    TIME         NULL,
  close_time   TIME         NULL,
  PRIMARY KEY (holiday_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nothing is seeded as observed. A shop that works Thanksgiving should not have
-- to un-tick it, and guessing somebody's calendar is worse than asking once.
