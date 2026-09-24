-- 0019_recipe_choices_and_batches.sql
--
-- 1) A recipe line can depend on a choice made at the till. modifier_id NULL
--    = used on every sale of the item; otherwise the line is only used when
--    that modifier was chosen on the order line — "Vege Lovers: any 5 veg"
--    deducts exactly the five picked, a "dip of your choice" deducts the dip
--    picked. The quantity stays per item, so a Medium and a Large deduct
--    different grams for the same choice.
ALTER TABLE recipes ADD COLUMN modifier_id TEXT REFERENCES modifiers(id);
DROP INDEX IF EXISTS idx_recipes_pair;
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_pair
  ON recipes(menu_item_id, ingredient_id, COALESCE(modifier_id, ''))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recipes_by_modifier
  ON recipes(modifier_id) WHERE modifier_id IS NOT NULL AND deleted_at IS NULL;

-- 2) Batch recipes for what the kitchen makes itself (sauces, dough, cheese
--    mix): one batch of `ingredient_id` uses these inputs and yields
--    `ingredients.batch_yield` units. "Make a batch" deducts the inputs and
--    adds the yield to stock. Inputs may themselves be made in-house
--    (shawarma sauce = tahini + toum).
ALTER TABLE ingredients ADD COLUMN batch_yield INTEGER CHECK (batch_yield IS NULL OR batch_yield > 0);
ALTER TABLE ingredients ADD COLUMN batch_method TEXT;

CREATE TABLE IF NOT EXISTS batch_recipe_lines (
  id                   TEXT PRIMARY KEY,
  ingredient_id        TEXT NOT NULL REFERENCES ingredients(id),
  input_ingredient_id  TEXT NOT NULL REFERENCES ingredients(id),
  qty                  INTEGER NOT NULL CHECK (qty > 0),
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  synced_at            TEXT,
  deleted_at           TEXT,
  device_id            TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,
  CHECK (ingredient_id <> input_ingredient_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_lines_pair
  ON batch_recipe_lines(ingredient_id, input_ingredient_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_batch_lines_input
  ON batch_recipe_lines(input_ingredient_id) WHERE deleted_at IS NULL;
