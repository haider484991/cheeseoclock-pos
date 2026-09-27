-- 0035_purchases.sql
-- Costing, Phase 5: purchases and receiving at the real bill.
--
-- purchase_orders
--   kind        'order' (a purchase order placed with a supplier, received
--               later) or 'quick' (a purchase recorded on the spot: a market
--               run, a bill paid at the door, a drawer payout turned into a
--               purchase). A quick purchase is received as it is written.
--   invoice_no  the supplier's bill number, typed when the goods come in.
--   supplier_id is now OPTIONAL: a market run has no supplier on file.
-- SQLite can't drop a NOT NULL, so the table is rebuilt, following 0014's
-- recipe (the table-redefinition steps from the SQLite manual): foreign keys
-- OFF (only legal outside a transaction), the swap inside one transaction,
-- then foreign keys back ON. purchase_order_items, stock_movements and
-- ingredient_costs point at purchase_orders by name, so after the rename
-- they point at the new table; nothing else (no view, no trigger) refers to
-- it. Every index the old table had is made again.
--
-- purchase_order_items
--   ordered_pack_size / ordered_pack_price_cents
--               the price the line was ordered at, EXACTLY as typed ("Rs 375
--               per kg" = 1,000 g for Rs 375; "Rs 2,250 for a pack of
--               6,000 g"), costing spec D1. NULL on lines written before
--               this migration: they are priced (1, unit_cost_cents).
--               unit_cost_cents stays, in whole paisa, for older screens only.
--   received_value_cents
--               what the bills said for everything received on the line so
--               far (a delivery's rows are valued at its bill). Lines already
--               received before this migration are filled in below, at
--               qty_received × unit_cost_cents: exactly what receiving them
--               wrote on their delivery rows (costing Phase 2: the line's
--               price × what came). A schema-time fill, not a business write
--               (the 0029 precedent): each till fills its own copy, from
--               columns both tills already agree on.
--
-- cash_movements
--   ref_purchase_order_id
--               the purchase this drawer payout paid for: a quick purchase
--               "Paid from the drawer" (written with it, one transaction), or
--               a free-text payout a manager later turned into a purchase
--               (linked once; the amount, and so the shift's expected cash,
--               never changes).
--
-- Every column is replicable and written only through the repositories
-- (procurement-repo, shift-repo), each with its sync entry and audit row.

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE purchase_orders_new (
  id                  TEXT PRIMARY KEY,
  supplier_id         TEXT REFERENCES suppliers(id),
  reference_no        TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'ordered', 'partial', 'received', 'cancelled')),
  ordered_at          TEXT,
  expected_at         TEXT,
  received_at         TEXT,
  total_cents         INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes               TEXT,
  created_by_user_id  TEXT NOT NULL REFERENCES users(id),
  received_by_user_id TEXT REFERENCES users(id),
  invoice_no          TEXT,
  kind                TEXT NOT NULL DEFAULT 'order' CHECK (kind IN ('order', 'quick')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

INSERT INTO purchase_orders_new (
  id, supplier_id, reference_no, status, ordered_at, expected_at, received_at,
  total_cents, notes, created_by_user_id, received_by_user_id,
  invoice_no, kind,
  created_at, updated_at, synced_at, deleted_at, device_id, version
)
SELECT
  id, supplier_id, reference_no, status, ordered_at, expected_at, received_at,
  total_cents, notes, created_by_user_id, received_by_user_id,
  NULL, 'order',
  created_at, updated_at, synced_at, deleted_at, device_id, version
FROM purchase_orders;

DROP TABLE purchase_orders;
ALTER TABLE purchase_orders_new RENAME TO purchase_orders;

-- The indexes the old table had (0005).
CREATE INDEX IF NOT EXISTS idx_pos_supplier_status
  ON purchase_orders(supplier_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pos_status_ordered
  ON purchase_orders(status, ordered_at) WHERE deleted_at IS NULL;
-- The people on it (foreign keys).
CREATE INDEX IF NOT EXISTS idx_pos_created_by
  ON purchase_orders(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_pos_received_by
  ON purchase_orders(received_by_user_id) WHERE received_by_user_id IS NOT NULL;

ALTER TABLE purchase_order_items ADD COLUMN ordered_pack_size INTEGER
  CHECK (ordered_pack_size IS NULL OR ordered_pack_size > 0);
ALTER TABLE purchase_order_items ADD COLUMN ordered_pack_price_cents INTEGER
  CHECK (ordered_pack_price_cents IS NULL OR ordered_pack_price_cents >= 0);
ALTER TABLE purchase_order_items ADD COLUMN received_value_cents INTEGER NOT NULL DEFAULT 0
  CHECK (received_value_cents >= 0);
-- What was billed on the lines received before this migration (see above).
UPDATE purchase_order_items
   SET received_value_cents = qty_received * unit_cost_cents
 WHERE qty_received > 0;

ALTER TABLE cash_movements ADD COLUMN ref_purchase_order_id TEXT REFERENCES purchase_orders(id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_purchase
  ON cash_movements(ref_purchase_order_id) WHERE ref_purchase_order_id IS NOT NULL;

COMMIT;

PRAGMA foreign_keys=ON;
