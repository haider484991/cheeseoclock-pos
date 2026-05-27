-- 0006_customers_schema.sql
-- Customers + delivery addresses. Snapshot customer info onto orders so a
-- renamed customer / deleted address doesn't rewrite yesterday's receipts.

------------------------------------------------------------
-- Customers — replicable.
-- phone is UNIQUE (within non-deleted rows) so cashier can lookup instantly.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  notes           TEXT,
  loyalty_points  INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone
  ON customers(phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_name
  ON customers(name) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Customer addresses — N per customer. A 'default' flag picks the one auto-loaded.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_addresses (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  label           TEXT NOT NULL DEFAULT 'Home',
  address_line    TEXT NOT NULL,
  area            TEXT,
  city            TEXT,
  notes           TEXT,
  is_default      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_addresses_customer
  ON customer_addresses(customer_id, is_default DESC) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- Snapshot the customer + delivery details onto orders for historical accuracy.
-- (orders.customer_id already exists, was nullable text. We add snapshots
-- alongside so the live customer/address can change without rewriting history.)
------------------------------------------------------------
ALTER TABLE orders ADD COLUMN customer_name_snapshot TEXT;
ALTER TABLE orders ADD COLUMN customer_phone_snapshot TEXT;
ALTER TABLE orders ADD COLUMN delivery_address_snapshot TEXT;
ALTER TABLE orders ADD COLUMN delivery_notes TEXT;
