-- 0018_ingredient_pack.sql
-- How an ingredient is bought: a pack of `pack_size` base units (grams, ml,
-- pieces…) for `pack_price_cents`. The costing sheet prices everything this
-- way ("Ketchup, 6000 g for Rs 2,250"), and the per-unit cost the recipes use
-- is derived from it, so the shop types what is on the supplier's bill and the
-- POS shows the cost per gram. Both NULL = cost per unit entered directly, as
-- before. For a made-in-house item (dough, sauces) the "pack" is one batch.
ALTER TABLE ingredients ADD COLUMN pack_size INTEGER CHECK (pack_size IS NULL OR pack_size > 0);
ALTER TABLE ingredients ADD COLUMN pack_price_cents INTEGER CHECK (pack_price_cents IS NULL OR pack_price_cents >= 0);
