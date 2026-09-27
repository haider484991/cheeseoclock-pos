-- 0036_price_ownership_and_alerts.sql
-- Costing, Phase 6: the costing sheet stops overwriting till prices; price alerts.
--
-- 1) ingredients.sheet_*: what the costing sheet (the menu file made from the
--    owner's workbook) says an ingredient costs — kept as a REFERENCE only,
--    never used for costing unless someone taps "Use the sheet's price"
--    (costing spec D4, section 8). Once costing has started the till owns
--    ingredient prices: a menu file only fills the price of an ingredient
--    that is new or has none ('unset'); every other price the till keeps
--    (from a delivery, typed, from an earlier sheet…). The sheet's figure is
--    stored here on every import, so Inventory shows it beside the till's.
--      sheet_pack_size / sheet_pack_price_cents
--                        the sheet's price EXACTLY as the file gives it: a
--                        pack of N base units for P paisa, or (1, its cost
--                        per unit) when the file gives no pack (D1);
--      sheet_price_kind  'set', 'estimate' (the file says it is a guess) or
--                        'unset' (the file says Rs 0: not priced yet);
--      sheet_price_at    when this figure came in (the import that brought it).
--    NULL until a menu file names the ingredient. Written only through
--    ingredient-cost-repo (setSheetPrice), synced and audited like any other
--    column of the ingredient.
ALTER TABLE ingredients ADD COLUMN sheet_pack_size INTEGER
  CHECK (sheet_pack_size IS NULL OR sheet_pack_size > 0);
ALTER TABLE ingredients ADD COLUMN sheet_pack_price_cents INTEGER
  CHECK (sheet_pack_price_cents IS NULL OR sheet_pack_price_cents >= 0);
ALTER TABLE ingredients ADD COLUMN sheet_price_kind TEXT
  CHECK (sheet_price_kind IS NULL OR sheet_price_kind IN ('set', 'estimate', 'free', 'unset'));
ALTER TABLE ingredients ADD COLUMN sheet_price_at TEXT;

-- 2) cost_alerts: what the Costing page's Alerts tab tells the owner, in plain
--    words — which dishes a price change moved and what it costs per week.
--      kind  'price_jump'           a key ingredient's price moved more than
--                                   the alert threshold, or a price change
--                                   costs at least Rs N a week (default
--                                   Rs 1,000) at this till's sales;
--            'weekly_digest'        Monday's list of dishes a price change
--                                   moved across their target (with a
--                                   1-point margin, and the customers' picks
--                                   frozen at the last digest, so a change
--                                   in what people order never alerts);
--            'batch_unpriced_input' a sauce / mix made here could not take
--                                   its price from its recipe because an
--                                   input has no price, so it kept the one
--                                   it had.
--            Checked in shared-types (COST_ALERT_KINDS), not by a CHECK, so a
--            newer till's alert still lands here (as in 0033 / 0034).
--    Alerts are worked out ONLY on the till that wrote the price (never when
--    a price arrives from the other till). The id is name-based (costing
--    spec D13): uuid v5 of kind | subject | the row that set it off (the
--    price history row; for the digest, the week), so the same alert on both
--    tills is ONE row, which the link settles by id.
--      ingredient_id       the ingredient it is about (NULL for the digest);
--      menu_item_id        the one dish it is about, when it is about one;
--      ingredient_cost_id  the price history row that set it off, when there
--                          is one;
--      impact_week_cents   what it costs per week at this till's sales
--                          (signed: below 0 is a saving); 0 when not known;
--      before_json / after_json
--                          the figures, as shared-types CostAlert describes
--                          them (the digest's after_json also carries the
--                          bands and picks the next digest compares with);
--      seen_at / seen_by_user_id
--                          "Seen", tapped by a manager or the owner. A digest
--                          with nothing to say is written seen.
-- Replicable (sync columns); written only through cost-alert-repo, each row
-- with its sync entry and audit row. Every foreign key has an index.
CREATE TABLE IF NOT EXISTS cost_alerts (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  ingredient_id       TEXT REFERENCES ingredients(id),
  menu_item_id        TEXT REFERENCES menu_items(id),
  ingredient_cost_id  TEXT REFERENCES ingredient_costs(id),
  impact_week_cents   INTEGER NOT NULL DEFAULT 0,
  before_json         TEXT,
  after_json          TEXT,
  seen_at             TEXT,
  seen_by_user_id     TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  synced_at           TEXT,
  deleted_at          TEXT,
  device_id           TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);

-- The Alerts tab: not seen yet first, newest first.
CREATE INDEX IF NOT EXISTS idx_cost_alerts_seen_created
  ON cost_alerts(seen_at, created_at);
-- The last weekly digest (what the next one compares with).
CREATE INDEX IF NOT EXISTS idx_cost_alerts_kind_created
  ON cost_alerts(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_cost_alerts_ingredient
  ON cost_alerts(ingredient_id) WHERE ingredient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_alerts_menu_item
  ON cost_alerts(menu_item_id) WHERE menu_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_alerts_ingredient_cost
  ON cost_alerts(ingredient_cost_id) WHERE ingredient_cost_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_alerts_seen_by
  ON cost_alerts(seen_by_user_id) WHERE seen_by_user_id IS NOT NULL;
