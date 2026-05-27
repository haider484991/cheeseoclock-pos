-- 0002_menu_schema.sql
-- Phase 2: menu management — categories, items, modifiers, combos, tax.
-- All tables are replicable (sync columns + UUID v7 id). Money in cents.

------------------------------------------------------------
-- Tax categories — referenced by menu_items at order time
-- via the snapshot in order_items.tax_category_id.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  rate_bps    INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  synced_at   TEXT,
  deleted_at  TEXT,
  device_id   TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tax_categories_active
  ON tax_categories(name) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Categories — top-level menu groupings shown on the POS grid.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 0,
  color_hex       TEXT NOT NULL DEFAULT '#f59e0b',
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_categories_active_order
  ON categories(is_active, display_order) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Menu items — the sellable products.
-- prep_station drives KOT routing (kitchen / bar / cold).
-- current_stock + low_stock_threshold are optional item-level inventory.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menu_items (
  id                    TEXT PRIMARY KEY,
  category_id           TEXT NOT NULL REFERENCES categories(id),
  name                  TEXT NOT NULL,
  description           TEXT,
  base_price_cents      INTEGER NOT NULL CHECK (base_price_cents >= 0),
  sku                   TEXT,
  barcode               TEXT,
  image_url             TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  prep_station          TEXT NOT NULL DEFAULT 'kitchen'
                          CHECK (prep_station IN ('kitchen', 'bar', 'cold')),
  tax_category_id       TEXT NOT NULL REFERENCES tax_categories(id),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  current_stock         INTEGER,
  low_stock_threshold   INTEGER,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  synced_at             TEXT,
  deleted_at            TEXT,
  device_id             TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_menu_items_category_active
  ON menu_items(category_id, is_active, sort_order) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_barcode
  ON menu_items(barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_prep_station
  ON menu_items(prep_station) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_low_stock
  ON menu_items(category_id, current_stock)
  WHERE current_stock IS NOT NULL AND low_stock_threshold IS NOT NULL
        AND deleted_at IS NULL;

------------------------------------------------------------
-- Modifier groups + modifiers.
-- selection_type: 'single' (radio) or 'multi' (checkbox).
-- min/max_select are integer constraints applied at order time.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS modifier_groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  selection_type  TEXT NOT NULL CHECK (selection_type IN ('single', 'multi')),
  min_select      INTEGER NOT NULL DEFAULT 0,
  max_select      INTEGER NOT NULL DEFAULT 1,
  is_required     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  CHECK (min_select >= 0 AND max_select >= min_select)
);

CREATE TABLE IF NOT EXISTS modifiers (
  id                 TEXT PRIMARY KEY,
  modifier_group_id  TEXT NOT NULL REFERENCES modifier_groups(id),
  name               TEXT NOT NULL,
  price_delta_cents  INTEGER NOT NULL DEFAULT 0,
  is_default         INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  synced_at          TEXT,
  deleted_at         TEXT,
  device_id          TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_modifiers_group_sort
  ON modifiers(modifier_group_id, sort_order) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- M:N: a modifier group can be attached to many items;
-- an item can have many modifier groups (e.g. Size + Crust + Toppings).
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
  id                 TEXT PRIMARY KEY,
  menu_item_id       TEXT NOT NULL REFERENCES menu_items(id),
  modifier_group_id  TEXT NOT NULL REFERENCES modifier_groups(id),
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  synced_at          TEXT,
  deleted_at         TEXT,
  device_id          TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mimg_pair
  ON menu_item_modifier_groups(menu_item_id, modifier_group_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mimg_by_item
  ON menu_item_modifier_groups(menu_item_id, sort_order)
  WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Combos: a fixed-price bundle of slots, each slot may be a fixed item
-- or a choice between several. At order time, the combo expands into
-- a parent order_items row + N child rows.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS combos (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  synced_at     TEXT,
  deleted_at    TEXT,
  device_id     TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_combos_active
  ON combos(is_active, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS combo_components (
  id              TEXT PRIMARY KEY,
  combo_id        TEXT NOT NULL REFERENCES combos(id),
  slot_name       TEXT NOT NULL,
  selection_type  TEXT NOT NULL CHECK (selection_type IN ('fixed', 'choice')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_combo_components_combo
  ON combo_components(combo_id, sort_order) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS combo_component_choices (
  id                  TEXT PRIMARY KEY,
  combo_component_id  TEXT NOT NULL REFERENCES combo_components(id),
  menu_item_id        TEXT NOT NULL REFERENCES menu_items(id),
  price_delta_cents   INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_ccc_by_component
  ON combo_component_choices(combo_component_id) WHERE deleted_at IS NULL;
