-- 008 — the public key a web form is identified by.
--
-- This has to live in the MASTER database and there is no way around it: the
-- snippet on a shop's own website posts a key and nothing else. Until that key
-- resolves to a company there is no tenant database to look in. Every other
-- public surface we have (unsubscribe, check-in) carries its company in a
-- signed link; this one cannot, because the shop's web person pastes the
-- snippet by hand and a signature is not something they can be asked to carry.
--
-- The key is PUBLIC by definition — it sits in HTML anybody can read. It is an
-- identifier, not a secret, and nothing may be authorised by holding it alone.
-- What makes a scraped key useless somewhere else is `funnel_domains` in the
-- tenant database: the Origin of the request has to be one the shop named.
--
-- Rotating writes a new row and revokes the old one rather than editing in
-- place, so a shop that rotates while the old snippet is still on a page can
-- see the refused traffic instead of wondering why the form went quiet.

CREATE TABLE IF NOT EXISTS funnel_keys (
  public_key   CHAR(28)     NOT NULL PRIMARY KEY COMMENT 'pk_live_ + 20 hex; public by design',
  company_id   BIGINT UNSIGNED NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   BIGINT UNSIGNED NULL,
  revoked_at   DATETIME     NULL,
  last_seen_at DATETIME     NULL COMMENT 'last submission or availability read on this key',
  KEY ix_fkey_company (company_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
