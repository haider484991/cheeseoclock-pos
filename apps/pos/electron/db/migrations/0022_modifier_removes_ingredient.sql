-- 0022_modifier_removes_ingredient.sql
-- "Leave out" choices (owner 2026-09-26: customers, above all allergic ones,
-- must be able to have an ingredient left off). A choice such as "No onion"
-- names the ingredient it takes off the dish; when it is picked on an order
-- line, that ingredient's base recipe line is not deducted from stock for that
-- line. The kitchen ticket prints the choice itself ("NO ONION").
--
-- NULL for every ordinary choice (sizes, dips, extras, deal slots).
ALTER TABLE modifiers ADD COLUMN removes_ingredient_id TEXT REFERENCES ingredients(id);

CREATE INDEX IF NOT EXISTS idx_modifiers_removes_ingredient ON modifiers(removes_ingredient_id);
