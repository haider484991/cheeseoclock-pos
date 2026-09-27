-- 0032_costing_foundation.sql
-- Costing, Phase 1 (read-only costing, targets, missing costs).
--
-- 1) business_settings: shop-wide settings BOTH tills share (food-cost
--    targets per menu category, the price step…), one row per key. The
--    `settings` table is per till (pure-local), so a target set on one till
--    would never reach the other. Replicable: sync columns, and the id is a
--    name-based uuid v5 of the key (computed in business-settings-repo), so
--    the same key written on two tills while the link is down is the SAME
--    row and settles by last write, instead of parking a UNIQUE clash for
--    ever (apply-remote). Values are JSON, checked per key by the Zod schema
--    in shared-schemas business-settings.ts on write and on read.
CREATE TABLE IF NOT EXISTS business_settings (
  id                  TEXT PRIMARY KEY,
  key                 TEXT NOT NULL,
  value_json          TEXT NOT NULL,
  updated_by_user_id  TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_settings_key
  ON business_settings(key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_business_settings_updated_by
  ON business_settings(updated_by_user_id) WHERE updated_by_user_id IS NOT NULL;

-- 2) What an ingredient's price IS (costing spec D1):
--      'set'       a real price;
--      'estimate'  a known guess (breading, "about Rs 15");
--      'free'      it really costs nothing — Rs 0 is its price;
--      'unset'     nobody has priced it yet: the ONLY "missing price" marker,
--                  listed under Costing → Missing costs.
--    Until now Rs 0 meant both "free" and "not priced", so the Costing page
--    could never reach zero missing costs.
ALTER TABLE ingredients ADD COLUMN price_kind TEXT NOT NULL DEFAULT 'set'
  CHECK (price_kind IN ('set', 'estimate', 'free', 'unset'));

-- A schema-time fill, not a business write (the 0029 precedent): each till
-- fills its own copy, so nothing is queued or audited at boot. Rs 0 with no
-- pack price was never priced. A manager marks the truly free ones 'free'.
UPDATE ingredients
   SET price_kind = 'unset'
 WHERE cost_per_unit_cents = 0 AND COALESCE(pack_price_cents, 0) = 0;
