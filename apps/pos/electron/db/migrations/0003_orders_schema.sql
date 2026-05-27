-- 0003_orders_schema.sql
-- Phase 2: orders, payments, dine-in tables, discounts.
-- All money in cents. Snapshots (unit_price, modifier_name, tax_category) live
-- on the order_items / order_item_modifiers rows — never live-joined to the menu.

------------------------------------------------------------
-- Floor sections + tables for dine-in mode.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS floor_sections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  synced_at   TEXT,
  deleted_at  TEXT,
  device_id   TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tables (
  id                  TEXT PRIMARY KEY,
  floor_section_id    TEXT NOT NULL REFERENCES floor_sections(id),
  label               TEXT NOT NULL,
  capacity            INTEGER NOT NULL DEFAULT 4,
  status              TEXT NOT NULL DEFAULT 'free'
                        CHECK (status IN ('free', 'occupied', 'reserved', 'cleaning')),
  current_order_id    TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tables_section_label
  ON tables(floor_section_id, label) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tables_status
  ON tables(status) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Orders — the hot path. order_number is human-readable and resets daily;
-- enforced at insertion time by the order service.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  order_number    TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('dine_in', 'takeaway', 'delivery', 'online')),
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'sent_to_kitchen', 'ready', 'served',
                                      'paid', 'void', 'refunded')),
  table_id        TEXT REFERENCES tables(id),
  customer_id     TEXT,
  cashier_id      TEXT NOT NULL REFERENCES users(id),
  shift_id        TEXT,
  source          TEXT NOT NULL DEFAULT 'pos' CHECK (source IN ('pos', 'web')),
  notes           TEXT,
  subtotal_cents  INTEGER NOT NULL DEFAULT 0,
  discount_cents  INTEGER NOT NULL DEFAULT 0,
  tax_cents       INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL DEFAULT 0,
  paid_at         TEXT,
  voided_at       TEXT,
  voided_by       TEXT REFERENCES users(id),
  void_reason     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders(status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_shift
  ON orders(shift_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_cashier
  ON orders(cashier_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_number
  ON orders(order_number, created_at);

------------------------------------------------------------
-- Order items. Snapshots: unit_price_cents and tax_category_id are frozen at
-- order time. A combo expands into one parent row (combo_id set) + N children
-- pointing at it via parent_order_item_id.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id                      TEXT PRIMARY KEY,
  order_id                TEXT NOT NULL REFERENCES orders(id),
  menu_item_id            TEXT REFERENCES menu_items(id),
  menu_item_name          TEXT NOT NULL,
  combo_id                TEXT REFERENCES combos(id),
  parent_order_item_id    TEXT REFERENCES order_items(id),
  quantity                INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents        INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents        INTEGER NOT NULL CHECK (line_total_cents >= 0),
  tax_category_id         TEXT NOT NULL,
  tax_rate_bps_snapshot   INTEGER NOT NULL,
  prep_station_snapshot   TEXT NOT NULL,
  notes                   TEXT,
  kitchen_status          TEXT NOT NULL DEFAULT 'pending'
                            CHECK (kitchen_status IN ('pending', 'preparing', 'ready', 'served')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  synced_at               TEXT,
  deleted_at              TEXT,
  device_id               TEXT NOT NULL,
  version                 INTEGER NOT NULL DEFAULT 1,
  CHECK (menu_item_id IS NOT NULL OR combo_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items(order_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_parent
  ON order_items(parent_order_item_id) WHERE parent_order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_kitchen
  ON order_items(kitchen_status, prep_station_snapshot) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Order-item modifiers. modifier_name is snapshotted so renaming a modifier
-- tomorrow doesn't rewrite yesterday's receipts.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id                    TEXT PRIMARY KEY,
  order_item_id         TEXT NOT NULL REFERENCES order_items(id),
  modifier_id           TEXT REFERENCES modifiers(id),
  modifier_name         TEXT NOT NULL,
  price_delta_cents     INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  synced_at             TEXT,
  deleted_at            TEXT,
  device_id             TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_oim_by_item
  ON order_item_modifiers(order_item_id) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Discounts on an order. Manager approval optional (depends on rules).
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_discounts (
  id                    TEXT PRIMARY KEY,
  order_id              TEXT NOT NULL REFERENCES orders(id),
  discount_type         TEXT NOT NULL CHECK (discount_type IN ('percent', 'flat')),
  value                 REAL NOT NULL CHECK (value >= 0),
  reason                TEXT,
  applied_by_user_id    TEXT NOT NULL REFERENCES users(id),
  approved_by_user_id   TEXT REFERENCES users(id),
  amount_cents          INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  synced_at             TEXT,
  deleted_at            TEXT,
  device_id             TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_order_discounts_order
  ON order_discounts(order_id) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Payments. Multiple per order (split tender). tendered_cents present for cash
-- so the UI can compute change due.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id),
  method              TEXT NOT NULL
                        CHECK (method IN ('cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer')),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  tendered_cents      INTEGER,
  reference_no        TEXT,
  received_by_user_id TEXT NOT NULL REFERENCES users(id),
  paid_at             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_payments_order
  ON payments(order_id, paid_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_method_paid
  ON payments(method, paid_at) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Daily order-number counter — pure-local. Allows resetting nightly without
-- impacting global uniqueness (order.id is UUID v7 — always unique).
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_number_counter (
  day_ymd     TEXT PRIMARY KEY,
  next_value  INTEGER NOT NULL DEFAULT 1
);
