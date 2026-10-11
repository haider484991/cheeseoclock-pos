-- 0054_tax_by_payment_method.sql
-- A tax rate for each way of paying (v0.7.45; the owner, 12 Oct 2026: "add
-- settings to set percentage tax on jazz cash or any payment method"). 0052
-- gave a tax category one card rate for card, the wallets and bank transfer
-- alike; each of them can now have its own (shared-types tax-by-method.ts):
--
--   tax_categories.method_rates_json
--             the ways of paying whose rate differs from the category's card
--             rate, in whole basis points: {"jazzcash":1500}. NULL = none:
--             every way but cash pays digital_rate_bps (else rate_bps), as
--             it did.
--   order_items.method_rates_snapshot_json
--             the line's, frozen when the line was added, like
--             digital_rate_bps_snapshot. NULL = none: every line from before
--             0054 reads exactly as before.
--   orders.method_totals_json
--             the bill if paid entirely one way, for the ways whose bill
--             differs from digital_total_cents (else total_cents), in whole
--             paisa; stored with the other totals each time they are worked
--             out. NULL = none.
--
-- No backfill, no CHECK, no index: a till from before 0054 sees nothing new,
-- and every row it wrote reads here exactly as it did there.
ALTER TABLE tax_categories ADD COLUMN method_rates_json TEXT;
ALTER TABLE order_items ADD COLUMN method_rates_snapshot_json TEXT;
ALTER TABLE orders ADD COLUMN method_totals_json TEXT;
