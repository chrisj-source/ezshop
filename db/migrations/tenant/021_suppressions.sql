-- 021 — unsubscribe, as one list with a channel.
--
-- Decided 15 Sep 2026.
--
-- ONE TABLE, TWO CHANNELS. An email that unsubscribed and a phone number that
-- replied STOP are the same fact: a destination that has said no. Two parallel
-- systems would mean two places to check and one of them eventually not being
-- checked.
--
-- KEYED ON THE DESTINATION, NOT ON A CUSTOMER ROW. This is the whole point. If
-- the suppression hung off clients.id then editing the record, deleting it, or
-- re-importing an estimate that recreates it would quietly un-block the
-- address. It keys on the address itself, so none of those touch it.
--
-- PER SHOP. Each shop is its own controller; an address that unsubscribed from
-- one shop has not unsubscribed from another it does business with. Hard
-- bounces and complaints go platform-wide instead — master/006.
--
-- A ROW IS NEVER DELETED. Re-subscribing sets released_at. "Has this address
-- ever unsubscribed" stays answerable, which is the question that matters when
-- somebody asks why they stopped getting messages.

CREATE TABLE IF NOT EXISTS suppressions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel      ENUM('email','sms') NOT NULL,
  destination  VARCHAR(190) NOT NULL
               COMMENT 'email lowercased and trimmed; sms as digits only',
  reason       ENUM('unsubscribe','stop','manual') NOT NULL DEFAULT 'unsubscribe',
  source       ENUM('link','reply','desk') NOT NULL DEFAULT 'link'
               COMMENT 'link = the footer link; reply = STOP; desk = somebody in the shop',
  note         VARCHAR(255) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_ip   VARCHAR(45) NULL COMMENT 'evidence the person did it, not the shop',
  -- Re-subscribing. Confirmed by the CUSTOMER through the same page, never by a
  -- desk tick: the unsubscribe was their choice, so undoing it is theirs too.
  released_at  DATETIME NULL,
  released_ip  VARCHAR(45) NULL,
  UNIQUE KEY uq_supp (channel, destination),
  KEY ix_supp_live (channel, destination, released_at),
  KEY ix_supp_when (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every attempt that was refused because of the list. Without this a shop asks
-- "why did he not get told" and the honest answer is not written down anywhere.
CREATE TABLE IF NOT EXISTS suppression_hits (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel      ENUM('email','sms') NOT NULL,
  destination  VARCHAR(190) NOT NULL,
  context      VARCHAR(120) NULL COMMENT 'what was being sent, or where it was typed',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_supp_hit (destination, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A refused send is its own outcome, not a failure.
--
-- 'failed' means the provider could not deliver and a retry is reasonable.
-- 'suppressed' means we deliberately did not try, and a retry is the one thing
-- that must never happen. Putting them in one bucket is how an unsubscribed
-- address ends up being mailed again by whoever wrote the retry.
ALTER TABLE notification_deliveries
  MODIFY COLUMN state ENUM('pending','sent','failed','skipped','suppressed')
    NOT NULL DEFAULT 'pending';
