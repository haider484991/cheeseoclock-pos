-- 0014_order_mode_foodpanda.sql
-- Add 'foodpanda' as an order mode so aggregator orders are recorded and
-- reported as their own channel, distinct from walk-in takeaway/delivery.
--
-- SQLite can't ALTER a CHECK constraint, so the mode CHECK on `orders` has to
-- be widened by rebuilding the table. Unlike the 0008 rebuild — which only
-- ever ran at first boot on an empty table — this one runs on tills that
-- already hold live orders, so a plain `DROP TABLE orders` with foreign keys
-- ON would try to cascade-delete rows that order_items/payments reference and
-- fail. We follow SQLite's documented table-redefinition recipe: turn foreign
-- keys OFF (only legal outside a transaction), do the swap inside one
-- transaction, then turn them back ON.
--
-- 'dine_in' stays a legal value: the POS no longer offers it, but historical
-- dine-in orders must still read and write (version bumps, refunds).

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE orders_new (
  id                          TEXT PRIMARY KEY,
  order_number                TEXT NOT NULL,
  mode                        TEXT NOT NULL
                                CHECK (mode IN ('dine_in', 'takeaway', 'delivery', 'online', 'foodpanda')),
  status                      TEXT NOT NULL DEFAULT 'open'
                                CHECK (status IN (
                                  'open', 'sent_to_kitchen', 'preparing', 'ready',
                                  'out_for_delivery', 'delivered', 'served',
                                  'paid', 'void', 'refunded'
                                )),
  table_id                    TEXT REFERENCES tables(id),
  customer_id                 TEXT,
  cashier_id                  TEXT NOT NULL REFERENCES users(id),
  shift_id                    TEXT,
  source                      TEXT NOT NULL DEFAULT 'pos'
                                CHECK (source IN ('pos', 'web')),
  notes                       TEXT,
  subtotal_cents              INTEGER NOT NULL DEFAULT 0,
  discount_cents              INTEGER NOT NULL DEFAULT 0,
  tax_cents                   INTEGER NOT NULL DEFAULT 0,
  total_cents                 INTEGER NOT NULL DEFAULT 0,
  paid_at                     TEXT,
  voided_at                   TEXT,
  voided_by                   TEXT REFERENCES users(id),
  void_reason                 TEXT,
  customer_name_snapshot      TEXT,
  customer_phone_snapshot     TEXT,
  delivery_address_snapshot   TEXT,
  delivery_notes              TEXT,
  assigned_rider_id           TEXT REFERENCES riders(id),
  dispatched_at               TEXT,
  delivered_at                TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  synced_at                   TEXT,
  deleted_at                  TEXT,
  device_id                   TEXT NOT NULL,
  version                     INTEGER NOT NULL DEFAULT 1
);

INSERT INTO orders_new (
  id, order_number, mode, status, table_id, customer_id, cashier_id, shift_id,
  source, notes, subtotal_cents, discount_cents, tax_cents, total_cents,
  paid_at, voided_at, voided_by, void_reason,
  customer_name_snapshot, customer_phone_snapshot,
  delivery_address_snapshot, delivery_notes,
  assigned_rider_id, dispatched_at, delivered_at,
  created_at, updated_at, synced_at, deleted_at, device_id, version
)
SELECT
  id, order_number, mode, status, table_id, customer_id, cashier_id, shift_id,
  source, notes, subtotal_cents, discount_cents, tax_cents, total_cents,
  paid_at, voided_at, voided_by, void_reason,
  customer_name_snapshot, customer_phone_snapshot,
  delivery_address_snapshot, delivery_notes,
  assigned_rider_id, dispatched_at, delivered_at,
  created_at, updated_at, synced_at, deleted_at, device_id, version
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- Recreate every index that lived on the old table (from 0008).
CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders(status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_shift
  ON orders(shift_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_cashier
  ON orders(cashier_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_number
  ON orders(order_number, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_rider_status
  ON orders(assigned_rider_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_active
  ON orders(status, created_at)
  WHERE deleted_at IS NULL
    AND status NOT IN ('paid', 'void', 'refunded', 'delivered', 'served');

COMMIT;

PRAGMA foreign_keys=ON;
