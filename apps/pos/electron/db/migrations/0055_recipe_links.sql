-- 0055_recipe_links.sql
-- A recipe that uses other menu items' recipes (v0.7.47; the owner, 12 Oct
-- 2026: "Deal ki recipe bhi link ho, copy nahi" — a deal's recipe linked to
-- its items, not copied). A Big Two deal links two Zinger Burgers and a
-- Regular Fries; a deal's slot links each choice to its item ("Deal: Burger:
-- Grilled" → the Grilled Burger). Everything that reads a recipe opens the
-- links up (pos-domain recipe-links.ts flattenRecipe), so the deal follows
-- the burger's recipe the moment it changes.
--
--   menu_item_id          the item whose recipe it is (the deal);
--   component_item_id     the item whose recipe it uses (the burger);
--   qty_per_unit          how many of the component one of it takes;
--   modifier_id           this item's choice the component comes with; NULL =
--                         every sale;
--   component_modifier_ids_json
--                         the component's own choices whose lines come too (a
--                         pizza's size), a JSON array of modifier ids; NULL =
--                         its every-sale lines only.
--
-- A new table and its indexes only: no existing row is touched, and a till
-- before 0055 reads every recipe exactly as it did.
CREATE TABLE IF NOT EXISTS recipe_links (
  id                           TEXT PRIMARY KEY,
  menu_item_id                 TEXT NOT NULL REFERENCES menu_items(id),
  component_item_id            TEXT NOT NULL REFERENCES menu_items(id),
  qty_per_unit                 INTEGER NOT NULL CHECK (qty_per_unit > 0),
  modifier_id                  TEXT REFERENCES modifiers(id),
  component_modifier_ids_json  TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  synced_at                    TEXT,
  deleted_at                   TEXT,
  device_id                    TEXT NOT NULL,
  version                      INTEGER NOT NULL DEFAULT 1,
  CHECK (menu_item_id <> component_item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_links_pair
  ON recipe_links(menu_item_id, component_item_id, COALESCE(modifier_id, ''))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recipe_links_component
  ON recipe_links(component_item_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recipe_links_by_modifier
  ON recipe_links(modifier_id) WHERE modifier_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recipe_links_updated ON recipe_links(updated_at);
