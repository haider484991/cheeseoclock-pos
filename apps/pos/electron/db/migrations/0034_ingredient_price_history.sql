-- 0034_ingredient_price_history.sql
-- Costing, Phase 4: exact prices and price history.
--
-- ingredient_costs: every price an ingredient has had, when it came in, from
-- what and why. Append-only and effective-dated: a price change adds a row,
-- it never edits one already there (Reports read "the price in force at a
-- time" as the latest row with a price at or before it, and the earliest
-- such row for anything older). Written ONLY through ingredient-cost-repo
-- (setIngredientPrice), in the same transaction as the ingredient's own
-- price columns, its sync entry and its audit row. A starting price ('seed')
-- is in force from the start of time (effective_at 1970-01-01T00:00:00.000Z,
-- the same on every till), so it always sorts before every real change;
-- when it was written is its created_at.
--
-- The price is kept EXACTLY as bought (costing spec D1): `pack_size` base
-- units for `pack_price_cents` paisa ("6,000 g for Rs 2,250"), never a
-- per-gram price rounded to whole paisa. `unit` is the ingredient's unit when
-- the row was written (a Convert kg -> g adds a row in grams, same value).
--   unit_cost_mc       one base unit's price, millicents (1/1000 paisa):
--                      round(pack_price_cents x 1000 / pack_size);
--   prev_unit_cost_mc  the price it replaced, in THIS row's unit (for the
--                      up / down arrow); NULL when there was none;
--   source             'seed' | 'manual' | 'delivery' | 'purchase' |
--                      'import' | 'batch' | 'convert' (shared-types
--                      PRICE_SOURCES; checked there, not by a CHECK, so a
--                      newer till's row always lands here, as in 0033);
--   price_kind         as on ingredients (set / estimate / free / unset).
--
-- Ids (costing spec D13): a row two tills could each write for the same fact
-- gets a name-based uuid v5, so the link settles it by id instead of parking
-- a clash — the one-off starting price ('seed', written once per till at
-- boot by services/costing-seed.ts), a menu file's price ('import', per
-- ingredient per file) and a batch's rolled-up price ('batch', per batch per
-- triggering change). Anything else has one writer and gets a uuid v7.
--
-- Replicable (sync columns); every foreign key has an index.
CREATE TABLE IF NOT EXISTS ingredient_costs (
  id                          TEXT PRIMARY KEY,
  ingredient_id               TEXT NOT NULL REFERENCES ingredients(id),
  effective_at                TEXT NOT NULL,
  unit                        TEXT NOT NULL,
  pack_size                   INTEGER NOT NULL CHECK (pack_size > 0),
  pack_price_cents            INTEGER NOT NULL CHECK (pack_price_cents >= 0),
  price_kind                  TEXT NOT NULL,
  unit_cost_mc                INTEGER NOT NULL,
  prev_unit_cost_mc           INTEGER,
  source                      TEXT NOT NULL,
  supplier_id                 TEXT REFERENCES suppliers(id),
  ref_purchase_order_id       TEXT REFERENCES purchase_orders(id),
  ref_purchase_order_item_id  TEXT REFERENCES purchase_order_items(id),
  actor_user_id               TEXT REFERENCES users(id),
  notes                       TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  synced_at                   TEXT,
  deleted_at                  TEXT,
  device_id                   TEXT NOT NULL,
  version                     INTEGER NOT NULL DEFAULT 1
);

-- An ingredient's history, and "the price in force at" a time.
CREATE INDEX IF NOT EXISTS idx_ingredient_costs_ingredient_time
  ON ingredient_costs(ingredient_id, effective_at);
-- Prices by where they came from (deliveries, the menu file…) over a period.
CREATE INDEX IF NOT EXISTS idx_ingredient_costs_source_time
  ON ingredient_costs(source, effective_at);
CREATE INDEX IF NOT EXISTS idx_ingredient_costs_supplier
  ON ingredient_costs(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ingredient_costs_po
  ON ingredient_costs(ref_purchase_order_id) WHERE ref_purchase_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ingredient_costs_po_item
  ON ingredient_costs(ref_purchase_order_item_id) WHERE ref_purchase_order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ingredient_costs_actor
  ON ingredient_costs(actor_user_id) WHERE actor_user_id IS NOT NULL;
