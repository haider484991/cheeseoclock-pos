-- 0038_stock_counts.sql
-- Costing, Phase 8: stock takes and "used vs should have used".
--
-- 1) ingredients.count_weekly: a KEY ITEM (cheese, chicken, patties, dough,
--    oil, boxes…). ONE list, kept here and nowhere else: it is what a "Key
--    items" stock take counts every week, what the price alerts watch for a
--    jump (Phase 6 kept it as costing.alerts.keyIngredientIds), and what the
--    Dashboard's "Do this" pins when it runs low (Phase 7). 1 = key item.
--    Written only through the ingredient repository (the ingredient form's
--    "Key item" box, Costing → Targets' key ingredients), synced and audited
--    with the ingredient.
--
--    A schema-time fill, not a business write (the 0029 / 0032 precedent:
--    each till fills its own copy the same way): the list Phase 6 saved moves
--    here; where none was ever saved, the ingredients the till suggested by
--    name (pos-domain suggestedKeyIngredient: mozzarella, cheese mix,
--    chicken, patty / patties, dough, flour, oil, box / boxes, whole words)
--    — exactly what the price alerts and the pins used until now, so neither
--    changes on the upgrade. The saved setting keeps its thresholds; its
--    list is no longer read, but a copy of the ingredients' list is still
--    written into it (ingredient-repo mirrorKeyItemsForOlderTills), so a
--    till upgraded after the other runs this with the owner's list, not
--    the name suggestions (shared-schemas costingAlertsSchema).
--
--    The name rule in SQL: the name, lower-cased (ASCII, as the /i rule
--    needs here), tabs and doubled spaces made single, padded with a space
--    each side, then GLOB with [^a-z0-9_] either side of the word — the
--    same "whole word" \b draws. Tested against the pos-domain rule
--    (stock-counts.db.test.ts).
ALTER TABLE ingredients ADD COLUMN count_weekly INTEGER NOT NULL DEFAULT 0
  CHECK (count_weekly IN (0, 1));

UPDATE ingredients SET count_weekly = 1
 WHERE deleted_at IS NULL
   AND id IN (
     SELECT j.value
       FROM business_settings b,
            json_each(CASE WHEN json_valid(b.value_json) THEN b.value_json ELSE '{}' END, '$.keyIngredientIds') j
      WHERE b.key = 'costing.alerts' AND b.deleted_at IS NULL
        AND json_valid(b.value_json)
        AND json_type(b.value_json, '$.keyIngredientIds') = 'array'
   );

UPDATE ingredients SET count_weekly = 1
 WHERE deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM business_settings b
      WHERE b.key = 'costing.alerts' AND b.deleted_at IS NULL
        AND json_valid(b.value_json)
        AND json_type(b.value_json, '$.keyIngredientIds') = 'array'
   )
   AND id IN (
     SELECT id FROM (
       SELECT id, ' ' || replace(replace(replace(lower(name), char(9), ' '), '   ', ' '), '  ', ' ') || ' ' AS n
         FROM ingredients WHERE deleted_at IS NULL
     )
      WHERE n GLOB '*[^a-z0-9_]mozzarella[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]cheese mix[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]cheesemix[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]chicken[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]patty[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]patties[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]dough[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]flour[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]oil[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]box[^a-z0-9_]*'
         OR n GLOB '*[^a-z0-9_]boxes[^a-z0-9_]*'
   );

-- 2) stock_counts: one stock take — the whole store room ('full'), the key
--    items ('key_items'), or a few picked ingredients ('custom'; the Stock
--    button's one-line stock take is one of these).
--      status   'open'      being counted (saved as the cook goes, shelf by
--                           shelf; the other till sees it too);
--               'done'      finished: every counted line has its figures and
--                           its 'count' stock row;
--               'cancelled' dropped: nothing was written to stock.
--               A full stock take finished with items left blank becomes
--               'custom' (it is not a whole count any more).
--      started_at / finished_at   finished_at is when the counts count from:
--                           "shop stock" and "used vs should have used" are
--                           worked out from it (costing spec 4.6).
--      counted_by_user_id   who started it.
--    scope / status are checked in shared-types (STOCK_COUNT_SCOPES,
--    STOCK_COUNT_STATUSES), not by a CHECK, so a newer till's row still lands
--    here (as in 0028 / 0033 / 0037).
CREATE TABLE IF NOT EXISTS stock_counts (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  counted_by_user_id  TEXT REFERENCES users(id),
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

-- The list (open first, newest first) and "the stock takes finished before t".
CREATE INDEX IF NOT EXISTS idx_stock_counts_status_started
  ON stock_counts(status, started_at);
CREATE INDEX IF NOT EXISTS idx_stock_counts_counted_by
  ON stock_counts(counted_by_user_id) WHERE counted_by_user_id IS NOT NULL;

-- 3) stock_count_lines: one ingredient on one stock take.
--      counted_qty   what is on the shelf, in `unit` (NULL = not counted yet;
--                    a blank line on a finished count was left out). While
--                    open: what the cook counted, at counted_at. Once
--                    finished: what was on the shelf at finished_at — the
--                    count carried forward by every till's stock rows
--                    between counted_at and the finish (a pizza sent after
--                    the cheese shelf was counted), so a shelf counted at
--                    10:00 and finished at 11:00 is not read as "11:00";
--      unit          the ingredient's unit when it was counted (a Convert
--                    later reads it back right, as stock rows do since 0029);
--      counted_at    when the shelf was counted (the save that set
--                    counted_qty; NULL when blank);
--    Written when the stock take is finished, in the same transaction:
--      expected_qty  SHOP stock at the finish: the last stock take's count
--                    plus every till's stock rows since (costing spec 4.6),
--                    or — never counted before — this till's own count;
--      till_qty      this till's count just before (the finish sets it to
--                    the counted figure: the 'count' stock row);
--      unit_cost_mc / value_cents   the price at the finish, and what the
--                    counted stock is worth at it (counted × price);
--      movement_id   the 'count' stock row the finish wrote.
-- Replicable (sync columns, uuid v7 ids: one writer per line); written only
-- through repositories/stock-count-repo.ts, each change with its sync entry
-- and hash-chained audit row. Every foreign key has an index.
CREATE TABLE IF NOT EXISTS stock_count_lines (
  id              TEXT PRIMARY KEY,
  stock_count_id  TEXT NOT NULL REFERENCES stock_counts(id),
  ingredient_id   TEXT NOT NULL REFERENCES ingredients(id),
  counted_qty     INTEGER,
  unit            TEXT,
  counted_at      TEXT,
  expected_qty    INTEGER,
  till_qty        INTEGER,
  unit_cost_mc    INTEGER,
  value_cents     INTEGER,
  movement_id     TEXT REFERENCES stock_movements(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  synced_at       TEXT,
  deleted_at      TEXT,
  device_id       TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1
);

-- One line per ingredient per stock take (also the stock take's own index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_count_lines_count_ingredient
  ON stock_count_lines(stock_count_id, ingredient_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_stock_count_lines_count
  ON stock_count_lines(stock_count_id);
-- An ingredient's stock takes, newest first (the last count before a moment).
CREATE INDEX IF NOT EXISTS idx_stock_count_lines_ingredient_created
  ON stock_count_lines(ingredient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_count_lines_movement
  ON stock_count_lines(movement_id) WHERE movement_id IS NOT NULL;

-- 4) Stock rows that settle an order, by when that order first took stock
--    (ref_taken_at, 0033): "used vs should have used" finds a cancel written
--    after a stock take that dates back before it without walking every row
--    since (costing spec 4.6). Partial: only settle rows carry it.
CREATE INDEX IF NOT EXISTS idx_movements_taken
  ON stock_movements(ref_taken_at) WHERE ref_taken_at IS NOT NULL;
