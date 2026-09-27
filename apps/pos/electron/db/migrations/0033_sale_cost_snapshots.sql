-- 0033_sale_cost_snapshots.sql
-- Costing, Phase 2: true food cost from today (cost snapshots at sale time).
--
-- Until now Reports valued the stock an order took at the ingredient's price
-- TODAY, so last month's food cost moved every time cheese got dearer. From
-- this version every sale keeps what its food cost that day, and every stock
-- row keeps what it was worth when it was written (CLAUDE.md "snapshots at
-- order time"). Nothing already written is rewritten: older rows keep NULL
-- values and older orders are estimated, labelled as such, per order.
--
-- ROLLOUT: upgrade both tills together. An order sent from a till without
-- this version keeps no cost (it is estimated), and its stock rows arrive
-- here with no value.
--
-- 1) stock_movements: what each row was worth when it was written. Plain ADD
--    COLUMN, nullable, no table rebuild (costing spec D9) and no CHECKs: the
--    values allowed are checked in shared-types / shared-schemas, so a newer
--    till's row never fails to land here. Row images are built from the live
--    schema, so the columns travel without a sync-core change; a row from a
--    till without them arrives with NULLs and is valued like an older row.
--      unit_cost_mc   one unit's price, millicents (1/1000 paisa);
--      value_cents    SIGNED like delta_qty, paisa; NULL = written before costing;
--      cost_basis     how it was valued: 'price' | 'bill' | 'take' | 'batch' |
--                     'count' | 'none' (see shared-types CostBasis);
--      detail         what the row stands for beyond its reason: batch_in,
--                     batch_out, waste:<reason>, cancel_made, cancel_put_back,
--                     stock_take, correction (shared-types MOVEMENT_DETAILS);
--      ref_group_id   the rows of one batch run, together;
--      ref_taken_at   on a row that settles an order (put back, cancelled
--                     food booked as waste), when that order first took stock.
ALTER TABLE stock_movements ADD COLUMN unit_cost_mc INTEGER;
ALTER TABLE stock_movements ADD COLUMN value_cents INTEGER;
ALTER TABLE stock_movements ADD COLUMN cost_basis TEXT;
ALTER TABLE stock_movements ADD COLUMN detail TEXT;
ALTER TABLE stock_movements ADD COLUMN ref_group_id TEXT;
ALTER TABLE stock_movements ADD COLUMN ref_taken_at TEXT;

CREATE INDEX IF NOT EXISTS idx_movements_group
  ON stock_movements(ref_group_id) WHERE ref_group_id IS NOT NULL;

-- 2) order_item_costs: the cost kept with a sale, written when the order's
--    stock leaves (decrementForOrder), in the same transaction. Insert-only.
--      - ONE 'base' row per order line: what is in every one ('none', Rs 0,
--        when the item has no recipe lines at all: Baked Wings, a delivery
--        charge);
--      - one row per choice picked that has recipe lines on that item (a
--        veggie, a deal's pizza, a dip, a paid extra);
--      - a "leave out" pick has no row: its effect is inside the others.
--    cost_cents covers the WHOLE line quantity (line_qty).
--    A separate table, not a column on order_items: the snapshot never bumps
--    order_items.version, so it can't race the other till's kitchen updates.
--    The id is a name-based uuid v5 of (order_item_id | part), computed in
--    stock-movement-repo: four calls for one order, or both tills costing
--    the same order while the link is down, give the SAME rows, and the link
--    settles them by last write instead of parking a clash (costing spec D13).
CREATE TABLE IF NOT EXISTS order_item_costs (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  order_item_id   TEXT NOT NULL REFERENCES order_items(id),
  part            TEXT NOT NULL,
  modifier_id     TEXT REFERENCES modifiers(id),
  line_qty        INTEGER NOT NULL,
  cost_cents      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('full', 'partial', 'none', 'failed')),
  missing_lines   INTEGER NOT NULL DEFAULT 0,
  estimate_lines  INTEGER NOT NULL DEFAULT 0,
  costed_at       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_item_costs_line_part
  ON order_item_costs(order_item_id, part) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_order_item_costs_order
  ON order_item_costs(order_id);
CREATE INDEX IF NOT EXISTS idx_order_item_costs_modifier
  ON order_item_costs(modifier_id) WHERE modifier_id IS NOT NULL;
