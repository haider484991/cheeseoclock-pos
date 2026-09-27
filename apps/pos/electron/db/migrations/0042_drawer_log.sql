-- 0042_drawer_log.sql
-- (Numbered 0042: v0.7.22 released 0040_foodpanda_deal_and_terms.sql and
-- 0041_channel_terms_uplift_and_fee.sql first.)
-- The cash drawer log: EVERY time the till opens the cash drawer, not only by
-- hand (owner, 27 Sep 2026: "I don't see the logs who drawers used").
--
-- 0028 kept only the opens by hand (Open drawer / no sale, open to count,
-- Test drawer). From this version the till also writes a row, in the SAME
-- transaction that moves the cash, for:
--   'sale'     a cash payment: tender, or cash collected on delivery / at the
--              table (order_id set, amount = the cash part of the payment);
--   'refund'   cash handed back (order_id set, amount negative; user = who
--              pressed Refund, approved_by = the manager who allowed it);
--   'float'    the float going in when a shift opens (even Rs 0: the drawer pops);
--   'payin' / 'payout' / 'tip_out'  cash in, cash out (also a purchase paid
--              from the drawer) and a rider's tip (cash_movement_id set).
-- 'no_sale', 'count' and 'test' are unchanged. kind still has no CHECK, so a
-- newer till's kinds sync to an older one (which reads them as 'Other').
--
-- "No row, no pulse": the drawer is only pulsed for a row, and the pulse
-- settles the row's outcome once the printer answered:
--   NULL          not known yet (the pulse is waiting or on its way);
--   opened        the printer took the pulse;
--   already_open  a later pulse (another sale, Open drawer) opened it first;
--   not_opened    it surely did not open (printer off, too late, order gone);
--   unsure        the printer failed mid-way, or the till stopped first;
--   no_printer    no receipt printer is set up.
-- An open with the physical key is never recorded (the till can't see it).
--
-- ALTER TABLE ADD COLUMN only: no rebuild and no back-filling from old print
-- jobs. The log starts on the update: drawer.logSince (same shape as 0030's
-- printing.printLogSince). Rows written before it never get an outcome.

ALTER TABLE drawer_opens ADD COLUMN order_id TEXT REFERENCES orders(id);
ALTER TABLE drawer_opens ADD COLUMN cash_movement_id TEXT REFERENCES cash_movements(id);
-- Signed paisa: + into the drawer (sale, float, payin), − out (refund, payout,
-- tip_out); NULL for no_sale / count / test.
ALTER TABLE drawer_opens ADD COLUMN amount_cents INTEGER;
ALTER TABLE drawer_opens ADD COLUMN outcome TEXT;
ALTER TABLE drawer_opens ADD COLUMN outcome_note TEXT;
ALTER TABLE drawer_opens ADD COLUMN settled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_drawer_opens_order ON drawer_opens(order_id);
CREATE INDEX IF NOT EXISTS idx_drawer_opens_cash_movement ON drawer_opens(cash_movement_id);
CREATE INDEX IF NOT EXISTS idx_drawer_opens_kind_created ON drawer_opens(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_drawer_opens_outcome ON drawer_opens(outcome, created_at);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES (
  'drawer.logSince',
  '"' || strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || '"',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
