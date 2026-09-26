-- 0025_orders_customer_index.sql
-- orders.customer_id is a foreign key with no index (the house rule is that
-- every FK gets one). A customer's order history, and the Customers screen's
-- order count / last order per row, each scanned the whole orders table once
-- per customer — fine at 50 orders, a stall at 20,000. This lets SQLite jump
-- straight to one customer's orders, newest first.
CREATE INDEX IF NOT EXISTS idx_orders_customer
  ON orders(customer_id, created_at) WHERE customer_id IS NOT NULL AND deleted_at IS NULL;
