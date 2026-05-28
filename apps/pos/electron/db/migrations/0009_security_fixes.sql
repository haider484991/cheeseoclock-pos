-- 0009_security_fixes.sql
-- Two fixes wrapped in one migration:
--
-- 1. The original `payments.amount_cents > 0` CHECK is wrong: refund flow
--    inserts negative payments (one negative entry per original positive
--    payment) so the books balance. That CHECK rejected every refund —
--    `orders:refund` would throw SQLITE_CONSTRAINT_CHECK and the order
--    stayed `paid` with no money returned in the books. Relax to `!= 0`.
--
-- 2. Add `login_attempts` table for PIN rate-limiting. Argon2 alone is
--    not sufficient at 4-digit PIN entropy; we need an attempt counter +
--    lockout so a local attacker can't brute-force the ~10k space.

------------------------------------------------------------
-- 1. Rebuild `payments` with the relaxed CHECK.
--    SQLite needs a full table swap because CHECKs can't be ALTER'd.
------------------------------------------------------------
CREATE TABLE payments_new (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id),
  method              TEXT NOT NULL
                        CHECK (method IN ('cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer')),
  -- Was: amount_cents > 0. Now allows negative entries for refunds so the
  -- ledger keeps a non-zero magnitude entry per original payment.
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
  version             INTEGER NOT NULL DEFAULT 1
);

INSERT INTO payments_new SELECT * FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX IF NOT EXISTS idx_payments_order
  ON payments(order_id, paid_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_method_paid
  ON payments(method, paid_at) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- 2. Per-PIN-hash login attempt tracking. Pure-local (not synced) — each
--    device tracks its own attempts. A successful login clears the row.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
  pin_hash       TEXT PRIMARY KEY,  -- hashed identifier so we don't store PINs
  failed_count   INTEGER NOT NULL DEFAULT 0,
  last_failed_at TEXT NOT NULL,
  /** Unix epoch ms — null when not currently locked. */
  locked_until   TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_locked
  ON login_attempts(locked_until) WHERE locked_until IS NOT NULL;
