-- 0011_shifts.sql
-- Cashier shifts (open / close cash drawer reconciliation).
--
-- Concept: a manager opens a shift on this device with an opening cash float.
-- Every order taken between open + close gets linked to the shift via
-- orders.shift_id (column already exists since 0003). At end of shift, the
-- manager counts the drawer; the system computes expected cash and records
-- the variance.
--
-- Only ONE open shift per device at a time (enforced by the partial unique
-- index). Shifts are replicable (synced) so HQ can see all per-device
-- end-of-day reports in one place.

CREATE TABLE IF NOT EXISTS shifts (
  id                    TEXT PRIMARY KEY,
  device_id             TEXT NOT NULL,
  opened_by_user_id     TEXT NOT NULL REFERENCES users(id),
  opened_at             TEXT NOT NULL,
  opening_cash_cents    INTEGER NOT NULL DEFAULT 0,
  -- Closing fields are NULL while the shift is open.
  closed_by_user_id     TEXT REFERENCES users(id),
  closed_at             TEXT,
  counted_cash_cents    INTEGER,
  expected_cash_cents   INTEGER,
  variance_cents        INTEGER,
  notes                 TEXT,
  -- Sync columns (replicable so multi-device shifts roll up at HQ).
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  synced_at             TEXT,
  deleted_at            TEXT,
  version               INTEGER NOT NULL DEFAULT 1
);

-- Exactly one active shift per device. Partial unique index permits as many
-- closed shifts as you like; rejects a second open shift on the same device.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open_per_device
  ON shifts(device_id)
  WHERE closed_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_shifts_opened_at
  ON shifts(opened_at DESC) WHERE deleted_at IS NULL;
