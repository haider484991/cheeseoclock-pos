-- 0049_outside_rider.sql
-- Outside riders (the owner, 2 Oct 2026: "Ready delivery -> Send out";
-- "Third-party rider keeps the delivery charge: the drawer expects the food
-- total from the rider").
--
--   orders.rider_keeps_cents
--             what an outside rider keeps of this order, frozen when it is
--             sent out (order-repo sendOutOrder): the order's delivery-charge
--             lines as sold, before tax, and never more than the order's
--             total (shared-types deliveryChargeLinesCents); 0 = sent out
--             with no delivery charge to keep. NULL = one of the shop's own
--             riders (Assign rider, who brings back the full bill), an order
--             not out yet (Back to Ready clears it), or any order from before
--             0.7.34. Nothing reads it as money until the rider settles.
--   cash_movements.order_id
--             a payout to an outside rider for this order: the delivery
--             charge he kept, or a trip he made for an order that was then
--             cancelled. NULL = every other pay-in, payout or tip-out, as
--             before. A payout WITH an order id is a delivery charge kept by
--             an outside rider, never a shortage.
--
-- Plain nullable ADD COLUMNs, no CHECK and no backfill: an order already out
-- reads as one of the shop's own riders, as it was. Row images are built from
-- the live schema, so both columns travel without a sync-core change; a till
-- without them (v0.7.33) ignores the keys, and an image without them leaves
-- the columns here as they are. Install both tills the same day. The index
-- finds an order's rider payouts (only the few rows that have one).
ALTER TABLE orders ADD COLUMN rider_keeps_cents INTEGER;
ALTER TABLE cash_movements ADD COLUMN order_id TEXT REFERENCES orders(id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_order ON cash_movements(order_id) WHERE order_id IS NOT NULL;
