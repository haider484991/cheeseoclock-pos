-- 0021_cash_movements.sql
-- Cash put into or taken out of the drawer during a shift that is not a sale:
-- paying the gas man or a supplier from the till (pay-out), topping up the
-- float with change (pay-in), a tip handed to a rider (tip-out). Without it
-- every such note showed up as a shortage at close, and nobody could tell a
-- supplier paid in cash from money that went missing.
--
-- The shift's expected cash is opening + cash sales − cash refunds
-- + pay-ins − pay-outs − tip-outs. A cashier records one with a manager's PIN
-- (approved_by_user_id); a manager or the owner records one directly.

CREATE TABLE IF NOT EXISTS cash_movements (
  id                   TEXT PRIMARY KEY,
  shift_id             TEXT NOT NULL REFERENCES shifts(id),
  type                 TEXT NOT NULL CHECK (type IN ('payin', 'payout', 'tip_out')),
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  reason               TEXT NOT NULL,
  user_id              TEXT NOT NULL REFERENCES users(id),
  approved_by_user_id  TEXT REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  synced_at            TEXT,
  deleted_at           TEXT,
  device_id            TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_user ON cash_movements(user_id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_approver ON cash_movements(approved_by_user_id);
