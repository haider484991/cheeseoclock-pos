-- 0020_payment_method_foodpanda.sql
-- Foodpanda orders are settled by the platform, not paid into the drawer. With
-- no method of their own they were tendered as the dialog's default, Cash:
-- every foodpanda order raised the shift's expected drawer cash and every
-- night closed "short" by the foodpanda takings — noise that hides a real
-- shortage (audit 2026-09-25). Add 'foodpanda' as a payment method; it is not
-- 'cash', so expected-cash sums leave it out.
--
-- SQLite can't ALTER a CHECK constraint, so `payments` is rebuilt with the
-- same recipe as 0014: foreign keys OFF (only legal outside a transaction),
-- swap inside one transaction, foreign keys back ON. Columns are listed in the
-- live table's order: 0009's rebuild, then 0016's shift_id.

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE payments_new (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id),
  method              TEXT NOT NULL
                        CHECK (method IN ('cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer', 'foodpanda')),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents != 0),
  tendered_cents      INTEGER,
  reference_no        TEXT,
  received_by_user_id TEXT NOT NULL REFERENCES users(id),
  paid_at             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  shift_id            TEXT REFERENCES shifts(id)
);

INSERT INTO payments_new (
  id, order_id, method, amount_cents, tendered_cents, reference_no,
  received_by_user_id, paid_at, created_at, updated_at, synced_at, deleted_at,
  device_id, version, shift_id
)
SELECT
  id, order_id, method, amount_cents, tendered_cents, reference_no,
  received_by_user_id, paid_at, created_at, updated_at, synced_at, deleted_at,
  device_id, version, shift_id
FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

-- Every index that lived on the old table (0009 + 0016).
CREATE INDEX IF NOT EXISTS idx_payments_order
  ON payments(order_id, paid_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_method_paid
  ON payments(method, paid_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(shift_id);

COMMIT;

PRAGMA foreign_keys=ON;
