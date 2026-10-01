-- 0046_web_order_alerts.sql
-- Website-order alerts that last (v0.7.33): an ack the till checks and
-- retries, a new-order alert that survives a restart, and a loud card when
-- the website cancels an order the kitchen already has. Six plain nullable
-- columns on web_order_imports:
--
--   web_created_at     when the customer placed it, as the website said. The
--                      website cancels an order it has not seen confirmed
--                      45 minutes after this; the till shows that time.
--   web_total_cents    the total the website showed the customer, so "the
--                      total changed" can be shown again after a restart.
--   acked_at           when the website confirmed it (by the ack, or by an
--                      answer to a status push). NULL on an imported order =
--                      not confirmed yet: the till keeps trying.
--   alert_seen_at      Seen, View or Live Orders opened. NULL while the order
--                      is still New = it rings again after a restart.
--   site_cancelled_at  the website cancelled it while the kitchen had it.
--   cancel_noted_at    someone signed in closed that card.
--
-- web_order_imports stays pure-local (per till, bridge-only; it is listed in
-- sync-core's sync-contract.ts), so no sync columns, no sync_queue and no
-- audit row: the till's repo for it is web-order-imports-repo.ts, in the
-- print-queue-repo.ts style. No CHECK: the values are times and amounts,
-- checked in code (the 0044 practice).
--
-- Backfill: an order imported before this version was acked the old way and
-- has been on the board ever since, so it is marked confirmed and seen at
-- its import time. The restart that installs this version then neither warns
-- "not confirmed" nor rings again for it. Only rows that carry their POS
-- order: a row with no pos_order_id is an import attempt still waiting for
-- its retry, and once that retry imports it, it must start out unconfirmed
-- and unseen like any new order. Rows that failed are left alone.
--
-- The partial index serves the ack retry on every poll ("imported, not
-- confirmed yet", oldest first): it holds only the few rows in flight.
ALTER TABLE web_order_imports ADD COLUMN web_created_at TEXT;
ALTER TABLE web_order_imports ADD COLUMN web_total_cents INTEGER;
ALTER TABLE web_order_imports ADD COLUMN acked_at TEXT;
ALTER TABLE web_order_imports ADD COLUMN alert_seen_at TEXT;
ALTER TABLE web_order_imports ADD COLUMN site_cancelled_at TEXT;
ALTER TABLE web_order_imports ADD COLUMN cancel_noted_at TEXT;

UPDATE web_order_imports
   SET acked_at = COALESCE(imported_at, updated_at),
       alert_seen_at = COALESCE(imported_at, updated_at)
 WHERE status = 'imported' AND pos_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_web_imports_unacked
  ON web_order_imports(imported_at)
  WHERE status = 'imported' AND acked_at IS NULL;
