-- 0005_inventory_schema.sql
-- Phase 5: inventory — ingredients, recipes (BOMs per menu item),
-- stock movements (audit log of every quantity change), suppliers, purchase orders.
--
-- Quantities are stored as INTEGER in the ingredient's declared base unit
-- (e.g. unit='g' → store 200 for 200 grams). The UI handles
-- display conversion (kg ↔ g). No floats — exact arithmetic.

------------------------------------------------------------
-- Suppliers (referenced by ingredients + purchase orders)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  contact_person  TEXT,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  notes           TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_suppliers_active
  ON suppliers(is_active, name) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Ingredients — raw materials consumed by recipes.
-- unit is a free-form string ('g', 'ml', 'pcs', 'slice', etc.).
-- current_qty is the live in-hand quantity in that unit.
-- cost_per_unit_cents is the most recent unit cost (for COGS calc).
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingredients (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  unit                  TEXT NOT NULL DEFAULT 'g',
  current_qty           INTEGER NOT NULL DEFAULT 0,
  low_threshold         INTEGER NOT NULL DEFAULT 0,
  cost_per_unit_cents   INTEGER NOT NULL DEFAULT 0 CHECK (cost_per_unit_cents >= 0),
  default_supplier_id   TEXT REFERENCES suppliers(id),
  sku                   TEXT,
  notes                 TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  synced_at             TEXT,
  deleted_at            TEXT,
  device_id             TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_name
  ON ingredients(name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ingredients_low_stock
  ON ingredients(is_active, current_qty, low_threshold)
  WHERE deleted_at IS NULL AND is_active = 1;
CREATE INDEX IF NOT EXISTS idx_ingredients_supplier
  ON ingredients(default_supplier_id) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Recipes — the bill-of-materials linking menu_items to ingredients.
-- qty_per_unit is "how much of this ingredient does ONE sold unit consume".
-- E.g. one Large Pepperoni Pizza uses 200g cheese, 150g dough, 30g sauce → 3 rows.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipes (
  id              TEXT PRIMARY KEY,
  menu_item_id    TEXT NOT NULL REFERENCES menu_items(id),
  ingredient_id   TEXT NOT NULL REFERENCES ingredients(id),
  qty_per_unit    INTEGER NOT NULL CHECK (qty_per_unit > 0),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_pair
  ON recipes(menu_item_id, ingredient_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recipes_by_item
  ON recipes(menu_item_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recipes_by_ingredient
  ON recipes(ingredient_id) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Stock movements — append-only-ish audit log of every change to
-- ingredients.current_qty. delta_qty is signed (negative on consumption).
-- Reasons: 'sale', 'delivery', 'waste', 'count' (stock take adjustment),
-- 'transfer' (between locations — future), 'adjustment' (manual).
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_movements (
  id                        TEXT PRIMARY KEY,
  ingredient_id             TEXT NOT NULL REFERENCES ingredients(id),
  delta_qty                 INTEGER NOT NULL,
  reason                    TEXT NOT NULL
                              CHECK (reason IN ('sale', 'delivery', 'waste', 'count', 'transfer', 'adjustment')),
  ref_order_id              TEXT REFERENCES orders(id),
  ref_purchase_order_id     TEXT,
  notes                     TEXT,
  actor_user_id             TEXT REFERENCES users(id),
  occurred_at               TEXT NOT NULL,
  /** Stock level immediately after this movement applied. */
  resulting_qty             INTEGER NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  synced_at                 TEXT,
  deleted_at                TEXT,
  device_id                 TEXT NOT NULL,
  version                   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_movements_ingredient_time
  ON stock_movements(ingredient_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_movements_order
  ON stock_movements(ref_order_id) WHERE ref_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movements_reason_time
  ON stock_movements(reason, occurred_at);

------------------------------------------------------------
-- Purchase orders — placed with a supplier; items track ordered vs received qty.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_orders (
  id                  TEXT PRIMARY KEY,
  supplier_id         TEXT NOT NULL REFERENCES suppliers(id),
  reference_no        TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'ordered', 'partial', 'received', 'cancelled')),
  ordered_at          TEXT,
  expected_at         TEXT,
  received_at         TEXT,
  total_cents         INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes               TEXT,
  created_by_user_id  TEXT NOT NULL REFERENCES users(id),
  received_by_user_id TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_pos_supplier_status
  ON purchase_orders(supplier_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pos_status_ordered
  ON purchase_orders(status, ordered_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id                    TEXT PRIMARY KEY,
  purchase_order_id     TEXT NOT NULL REFERENCES purchase_orders(id),
  ingredient_id         TEXT NOT NULL REFERENCES ingredients(id),
  qty_ordered           INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_received          INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost_cents       INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  line_total_cents      INTEGER NOT NULL CHECK (line_total_cents >= 0),
  notes                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  synced_at             TEXT,
  deleted_at            TEXT,
  device_id             TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_poi_by_po
  ON purchase_order_items(purchase_order_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_poi_by_ingredient
  ON purchase_order_items(ingredient_id) WHERE deleted_at IS NULL;
