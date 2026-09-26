-- 0029_stock_movement_unit.sql
-- The unit each stock movement was written in.
--
-- Convert (kg → g, l → ml; ingredient-repo convertIngredientToBaseUnit)
-- rescales an ingredient's count, recipes, open purchase orders and batch
-- lines, but not its past movements — rewriting the ledger would mean
-- thousands of rows to sync and audit. So a movement now carries its unit,
-- and whoever reads movements back (cancelling an order and putting its
-- stock back, Reports → Food cost) scales old rows into the unit the
-- ingredient has now. Found 2026-09-26: an order sent while flour was in kg
-- and cancelled after the Convert put back "2" into a count in grams
-- (1,998 g of flour lost for good).
--
-- Plain ADD COLUMN, no table rebuild. Row images are built from the live
-- schema on each till, so the column travels without a sync-core change; a
-- row from a till without it is given the unit the ingredient has here when
-- it arrives (apply-remote), which is the unit it was written in: rows apply
-- in the order they were written.
ALTER TABLE stock_movements ADD COLUMN unit TEXT;

-- Fill the rows already there (a schema-time fill, not a business write:
-- each till fills its own copy). Only kg → g and l → ml ever change a unit,
-- so only rows of an ingredient now in g or ml can be in another one.
--
-- 1. The count each row left (resulting_qty) makes a chain per ingredient and
--    till: a row's count before it (resulting_qty − delta_qty) is what the
--    previous row on that till left. Nothing moves a count outside the
--    movements except a Convert — done on that till, or the other till's
--    arriving there (apply-remote countInNewUnit) — and that multiplies it by
--    exactly 1,000. So a row whose count before is 1,000 × what the previous
--    row left marks the Convert on that till: the rows before it were written
--    in kg (l), the rows from it on in g (ml). This works on either till,
--    for its own rows and the other till's (their counts travel with them).
CREATE TEMP TABLE _unit_jump AS
  SELECT ing, dev, at, id
    FROM (SELECT m.ingredient_id AS ing, m.device_id AS dev, m.created_at AS at, m.id AS id,
                 m.resulting_qty - m.delta_qty AS before_qty,
                 LAG(m.resulting_qty) OVER (
                   PARTITION BY m.ingredient_id, m.device_id ORDER BY m.created_at, m.id) AS prev_qty
            FROM stock_movements m
            JOIN ingredients i ON i.id = m.ingredient_id
           WHERE i.unit IN ('g', 'ml'))
   WHERE prev_qty IS NOT NULL
     AND ABS(before_qty - prev_qty) > 1e-9
     AND ABS(before_qty - prev_qty * 1000) <= 1e-6 * MAX(1.0, ABS(prev_qty * 1000));

UPDATE stock_movements
   SET unit = CASE WHEN EXISTS (SELECT 1 FROM _unit_jump j
                                 WHERE j.ing = stock_movements.ingredient_id
                                   AND j.dev = stock_movements.device_id
                                   AND (j.at > stock_movements.created_at
                                        OR (j.at = stock_movements.created_at AND j.id > stock_movements.id)))
                   THEN (SELECT CASE i.unit WHEN 'g' THEN 'kg' ELSE 'l' END
                           FROM ingredients i WHERE i.id = stock_movements.ingredient_id)
                   ELSE (SELECT i.unit FROM ingredients i WHERE i.id = stock_movements.ingredient_id)
              END
 WHERE unit IS NULL
   AND EXISTS (SELECT 1 FROM _unit_jump j
                WHERE j.ing = stock_movements.ingredient_id AND j.dev = stock_movements.device_id);

-- 2. A Convert after this till's last row for an ingredient shows in its
--    count now: 1,000 × what that last row left. Then every row this till
--    wrote for it was in kg (l).
CREATE TEMP TABLE _unit_tail AS
  SELECT t.ing AS ing
    FROM (SELECT m.ingredient_id AS ing, m.resulting_qty AS last_qty,
                 ROW_NUMBER() OVER (PARTITION BY m.ingredient_id ORDER BY m.created_at DESC, m.id DESC) AS rn
            FROM stock_movements m
           WHERE m.device_id = (SELECT d.device_id FROM device_info d WHERE d.id = 'singleton')) t
    JOIN ingredients i ON i.id = t.ing
   WHERE t.rn = 1 AND i.unit IN ('g', 'ml')
     AND ABS(i.current_qty - t.last_qty) > 1e-9
     AND ABS(i.current_qty - t.last_qty * 1000) <= 1e-6 * MAX(1.0, ABS(t.last_qty * 1000));

UPDATE stock_movements
   SET unit = (SELECT CASE i.unit WHEN 'g' THEN 'kg' ELSE 'l' END
                 FROM ingredients i WHERE i.id = stock_movements.ingredient_id)
 WHERE unit IS NULL
   AND device_id = (SELECT d.device_id FROM device_info d WHERE d.id = 'singleton')
   AND ingredient_id IN (SELECT ing FROM _unit_tail);

DROP TABLE _unit_jump;
DROP TABLE _unit_tail;

-- 3. The till that ran a Convert has its audit row: a row written before it
--    (and not placed by 1 or 2) was in the unit it converted FROM.
UPDATE stock_movements
   SET unit = (
     SELECT json_extract(a.before_json, '$.unit')
       FROM audit_log a
      WHERE a.entity_type = 'ingredients'
        AND a.entity_id = stock_movements.ingredient_id
        AND a.action = 'convert_unit'
        AND a.created_at > stock_movements.created_at
      ORDER BY a.created_at
      LIMIT 1)
 WHERE unit IS NULL;

-- 4. Everything else was written in the unit the ingredient has now. The one
--    case none of the above can place: a row the OTHER till wrote before its
--    own Convert, when that till wrote nothing for the ingredient after it —
--    on this till it reads in the new unit (as every row did before 0029).
UPDATE stock_movements
   SET unit = (SELECT i.unit FROM ingredients i WHERE i.id = stock_movements.ingredient_id)
 WHERE unit IS NULL;
