-- 0056_vouchers.sql
-- Paper vouchers a client buys in bulk and hands out (v0.7.48; the owner,
-- 12 Oct 2026: "we are giving these vouchers to abhi company … can you add
-- it to pos system so we can track it"). Each voucher has a number and a
-- code printed on it; the till takes one item off the bill for it, once.
--
-- voucher_batches   one client's vouchers:
--   name                 who they are for ("abhi"): prints on the bill;
--   gives                what one voucher gets ("One Large pizza from the
--                        Regular menu"): shown at the till;
--   covers_cents         the most one voucher takes off (paisa): one of the
--                        item it is used on, never more;
--   good_until           the last trading day it can be used (YYYY-MM-DD);
--                        NULL = no end;
--   created_by_user_id   who added them: the voucher's discount rows carry
--                        them as the approver.
--
-- vouchers          one per printed voucher: its number (1 = "001") and its
--                   code ("MF7U"). Unique by number inside a batch; a code is
--                   checked unique among the live vouchers by the repository,
--                   not here, so two tills adding vouchers while the link is
--                   down never stop each other's rows landing.
--
-- order_discounts.voucher_id   the voucher a discount row is for (source
--                   'voucher'; its terms frozen in rule_json). Whether a
--                   voucher is used is read from these rows: one on an order
--                   that is not cancelled or deleted. Cancelling the order,
--                   deleting it or taking the voucher off frees it, with
--                   nothing else to keep in step. No REFERENCES: the row may
--                   reach the other till before its voucher does.
--
-- New tables, a plain nullable column and indexes only: no existing row is
-- touched, and a till before 0056 reads every order exactly as it did.
CREATE TABLE IF NOT EXISTS voucher_batches (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  gives               TEXT NOT NULL,
  covers_cents        INTEGER NOT NULL CHECK (covers_cents > 0),
  good_until          TEXT,
  created_by_user_id  TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_voucher_batches_created_by
  ON voucher_batches(created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voucher_batches_updated ON voucher_batches(updated_at);

CREATE TABLE IF NOT EXISTS vouchers (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL REFERENCES voucher_batches(id),
  number      INTEGER NOT NULL CHECK (number > 0),
  code        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  synced_at   TEXT,
  deleted_at  TEXT,
  device_id   TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_batch_number
  ON vouchers(batch_id, number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_updated ON vouchers(updated_at);

ALTER TABLE order_discounts ADD COLUMN voucher_id TEXT;

CREATE INDEX IF NOT EXISTS idx_order_discounts_voucher
  ON order_discounts(voucher_id) WHERE voucher_id IS NOT NULL AND deleted_at IS NULL;
