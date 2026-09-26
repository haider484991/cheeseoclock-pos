-- 0026_main_thread_scan_indexes.sql
-- Queries that read a whole, ever-growing table on the till's main process,
-- where every IPC call (every tap) waits behind them. Measured on a year of
-- simulated trade (40k orders, 560k stock movements, 560k sync_queue rows):
--
--   * Inventory -> Movements, refreshed every 30 s: "newest movements first"
--     scanned and sorted every movement ever made: 744 ms a refresh, now <1 ms.
--   * Checkout's customer panel ("last orders" for a matched phone), and the
--     customer's order list: orders.customer_id is a foreign key with no
--     index, so each lookup scanned all orders (idx_orders_customer, migration 0025).
--   * Housekeeping at boot (before the window opens) and daily: "synced
--     sync_queue rows older than N days" scanned the whole queue, 750 ms,
--     even with sync switched off, when no row ever matches.
CREATE INDEX IF NOT EXISTS idx_movements_occurred
  ON stock_movements(occurred_at);

CREATE INDEX IF NOT EXISTS idx_sync_queue_synced
  ON sync_queue(synced_at) WHERE synced_at IS NOT NULL;
