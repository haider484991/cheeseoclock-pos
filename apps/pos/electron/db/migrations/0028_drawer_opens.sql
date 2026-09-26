-- 0028_drawer_opens.sql
-- Every time the cash drawer is opened by hand rather than by a sale: the
-- Open drawer button on the top bar (a cashier needs a manager's PIN), "Open
-- drawer to count" while closing a shift, and Test drawer under Settings →
-- Printers. Cash payments, cash refunds and drawer cash in / out open it too,
-- but those are already on record as payments and cash_movements.
--
-- The row is written (with its audit_log entry) BEFORE the drawer is pulsed,
-- so an open is on record even when the printer then fails. Reports count
-- them per shift and per person and list each one with who approved it.
--
-- kind is 'no_sale' | 'count' | 'test', checked in drawer-open-repo.ts rather
-- than with a CHECK, so a newer till's kinds still sync to an older one.

CREATE TABLE IF NOT EXISTS drawer_opens (
  id                   TEXT PRIMARY KEY,
  shift_id             TEXT REFERENCES shifts(id),
  kind                 TEXT NOT NULL,
  reason               TEXT,
  user_id              TEXT NOT NULL REFERENCES users(id),
  approved_by_user_id  TEXT REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  synced_at            TEXT,
  deleted_at           TEXT,
  device_id            TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_drawer_opens_shift ON drawer_opens(shift_id);
CREATE INDEX IF NOT EXISTS idx_drawer_opens_user ON drawer_opens(user_id);
CREATE INDEX IF NOT EXISTS idx_drawer_opens_approver ON drawer_opens(approved_by_user_id);
CREATE INDEX IF NOT EXISTS idx_drawer_opens_created ON drawer_opens(created_at);
