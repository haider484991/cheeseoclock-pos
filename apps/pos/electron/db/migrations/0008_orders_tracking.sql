-- 0008_orders_tracking.sql
-- Live order tracking: introduce a riders roster + per-order assignment, and
-- expand orders.status to cover the delivery lifecycle
-- (preparing, out_for_delivery, delivered).
--
-- Background: until now `orders.status` only had open/sent_to_kitchen/ready/
-- served/paid/void/refunded. Delivery flow needs richer states so the team
-- can see "who's holding what" on the Live Orders board.

------------------------------------------------------------
-- Riders / delivery staff. Lightweight roster — name + phone is the minimum
-- viable record. `is_active = 0` hides them from the picker without losing
-- history of past assignments.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS riders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  synced_at   TEXT,
  deleted_at  TEXT,
  device_id   TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_riders_active
  ON riders(is_active) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Recreate `orders` to expand the status CHECK and add the three rider
-- columns in a single rebuild. SQLite can't ALTER a CHECK constraint, and
-- adding columns + relaxing the check separately leaves a window where the
-- new statuses would be rejected.
------------------------------------------------------------
CREATE TABLE orders_new (
  id                          TEXT PRIMARY KEY,
  order_number                TEXT NOT NULL,
  mode                        TEXT NOT NULL
                                CHECK (mode IN ('dine_in', 'takeaway', 'delivery', 'online')),
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
  -- Rider tracking (new in 0008):
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
  NULL, NULL, NULL,
  created_at, updated_at, synced_at, deleted_at, device_id, version
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- Re-create the indexes that lived on the old table.
CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders(status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_shift
  ON orders(shift_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_cashier
  ON orders(cashier_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_number
  ON orders(order_number, created_at);
-- New: rider-centric lookups for the Live Orders board.
CREATE INDEX IF NOT EXISTS idx_orders_rider_status
  ON orders(assigned_rider_id, status) WHERE deleted_at IS NULL;
-- "Active" board query: everything that isn't done. Composite index keeps the
-- common (status IN (...) ORDER BY created_at) query off a full scan.
CREATE INDEX IF NOT EXISTS idx_orders_active
  ON orders(status, created_at)
  WHERE deleted_at IS NULL
    AND status NOT IN ('paid', 'void', 'refunded', 'delivered', 'served');
