-- 0023_orders_created_index.sql
-- Order History pages through placed orders newest-first inside a date range
-- (status <> 'open', created_at BETWEEN …, ORDER BY created_at DESC). The
-- existing (status, created_at) indexes can't serve a "not open" filter, so a
-- month of orders was scanned and sorted on every page and every 15 s refresh.
-- A plain created_at index lets SQLite walk the range in order and stop at
-- the page size. Reports' date-range totals use the same range.
CREATE INDEX IF NOT EXISTS idx_orders_created
  ON orders(created_at) WHERE deleted_at IS NULL;
