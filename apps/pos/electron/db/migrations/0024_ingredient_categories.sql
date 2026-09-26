-- 0024_ingredient_categories.sql
-- Ingredient categories (owner 2026-09-26: "Ingredients don't have a search
-- bar and categories"). One of the fixed shelves in
-- shared-types INGREDIENT_CATEGORY_IDS: dough, cheese, meat, veg, sauce,
-- spice, dry, drinks, packaging, other. The list is checked where it is
-- written (shared-schemas), not by a CHECK here, so a shelf can be added
-- later without rebuilding the table.
--
-- NULL = nobody has picked one yet: the till guesses it from the name
-- (pos-domain guessIngredientCategory) every time the ingredient is read.
-- So every existing ingredient gets a sensible shelf without a mass rewrite
-- (no hundreds of sync / audit rows at boot), and a renamed one follows its
-- new name until a manager chooses.
ALTER TABLE ingredients ADD COLUMN category TEXT;

CREATE INDEX IF NOT EXISTS idx_ingredients_category
  ON ingredients(category, name) WHERE deleted_at IS NULL;
-- (The movement history's date index is idx_movements_occurred, migration 0026.)
