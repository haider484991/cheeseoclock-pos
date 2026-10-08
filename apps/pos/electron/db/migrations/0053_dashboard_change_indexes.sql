-- 0053_dashboard_change_indexes.sql
-- The owner's phone dashboard (v0.7.40, shared-types dashboard.ts): the till
-- sends the website what changed since its last push, found by each row's
-- updated_at (services/dashboard-push.ts). These indexes keep that look a
-- range read as the history grows, instead of a scan of every order line,
-- choice and payment once a minute through service.
--
-- Indexes only: no column, no CHECK, no data written. A till without them
-- (v0.7.39) reads the same rows, only slower; a database with them opens on
-- an older till unchanged. The menu tables are small and left alone.
CREATE INDEX IF NOT EXISTS idx_orders_updated ON orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_items_updated ON order_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_updated ON order_item_modifiers(updated_at);
CREATE INDEX IF NOT EXISTS idx_payments_updated ON payments(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_discounts_updated ON order_discounts(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_item_costs_updated ON order_item_costs(updated_at);
CREATE INDEX IF NOT EXISTS idx_order_channel_terms_updated ON order_channel_terms(updated_at);
CREATE INDEX IF NOT EXISTS idx_shifts_updated ON shifts(updated_at);
CREATE INDEX IF NOT EXISTS idx_cash_movements_updated ON cash_movements(updated_at);
CREATE INDEX IF NOT EXISTS idx_drawer_opens_updated ON drawer_opens(updated_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_updated ON stock_movements(updated_at);
