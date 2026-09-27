-- 0040_foodpanda_deal_and_terms.sql
-- (Numbered 0040: v0.7.21 released 0039_shift_close_notes.sql first.)
-- Settings → foodpanda (owner, 2026-09-27: "we just need to add how much
-- discount is added on the foodpanda listing so the system knows what stock
-- cost and all… everything should be editable for the admin").
--
-- Plain nullable ADD COLUMN and a new table, no rebuild and no CHECKs: the
-- values allowed are checked in shared-types / shared-schemas, so a newer
-- till's row never fails to land here (the 0033 practice). Row images are
-- built from the live schema, so the columns travel without a sync-core
-- change; a till without them ignores them.
--
-- ROLLOUT: update both tills the same day. Until then the older till keeps
-- today's behaviour (foodpanda at full price).

-- 1) Where a discount came from, and its frozen terms.
--      source     NULL = typed by staff (F3); 'foodpanda' = the shop's
--                 standing foodpanda deal, put on automatically when the
--                 order became foodpanda (order-repo createOrder /
--                 setOrderMode). Reports list those under "Standing offers",
--                 not under the cashier.
--      rule_json  the deal's terms at that moment (shared-types
--                 FoodpandaDealRule: the deal's %, the shop's %, the minimum,
--                 the most off, when the setting was saved). The order's
--                 rupees are re-worked from THIS on every cart change, never
--                 from the live setting, so a Save while the order is open
--                 can't move it.
ALTER TABLE order_discounts ADD COLUMN source TEXT;
ALTER TABLE order_discounts ADD COLUMN rule_json TEXT;

-- 2) order_channel_terms: a foodpanda order's economics, written ONCE when it
--    is paid (tenderOrder, same transaction), insert-only. The id is a
--    name-based uuid v5 of the order id (order-repo), so the same order can
--    only ever have one, on both tills. A separate table, not columns on
--    orders: it never bumps orders.version (the order_item_costs pattern).
--    Next month's commission never rewrites this month's orders.
--      deal_label / deal_bps / shop_bps   the deal as frozen on the order
--      shop_discount_cents                 the shop's part (= the order's discount)
--      platform_funded_cents               foodpanda's part, paid on top
--      commission_bps / commission_base    the fees in force at payment
--      commission_confirmed                1 = the owner confirmed it, 0 = "suggested"
--      commission_cents / fixed_fee_cents / commission_tax_cents
--      expected_payout_cents               what foodpanda should pay for it
--      tablet_total_cents / tablet_diff_cents   typed at Pay (NULL = not typed)
--      settings_at                         when the fees were saved (NULL = default)
CREATE TABLE IF NOT EXISTS order_channel_terms (
  id                     TEXT PRIMARY KEY,
  order_id               TEXT NOT NULL REFERENCES orders(id),
  channel                TEXT NOT NULL,
  deal_label             TEXT,
  deal_bps               INTEGER,
  shop_bps               INTEGER,
  shop_discount_cents    INTEGER,
  platform_funded_cents  INTEGER,
  commission_bps         INTEGER,
  commission_base        TEXT,
  commission_confirmed   INTEGER,
  commission_cents       INTEGER,
  fixed_fee_cents        INTEGER,
  commission_tax_cents   INTEGER,
  expected_payout_cents  INTEGER,
  tablet_total_cents     INTEGER,
  tablet_diff_cents      INTEGER,
  settings_at            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  synced_at              TEXT,
  deleted_at             TEXT,
  device_id              TEXT NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_order_channel_terms_order
  ON order_channel_terms(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_channel_terms_order_live
  ON order_channel_terms(order_id) WHERE deleted_at IS NULL;
