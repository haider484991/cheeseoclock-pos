-- 0043_order_test_delete.sql
-- (Numbered 0043: v0.7.22 released 0040 and 0041 first; runs after
-- 0042_drawer_log.sql.)
-- Test orders the OWNER deletes (owner, 27 Sep 2026: "the test order delete
-- option only for admin and restock back option").
--
-- A test order is soft-deleted like any row (orders.deleted_at, and each of
-- its payments too), so it drops out of sales, reports, the shift's cash and
-- the customer's history, and stays in the owner's list of deleted test
-- orders. These columns say who deleted it, why, and what happened to its
-- stock; the full order before the delete is in the hash-chained audit row
-- (action delete_test_order). Nothing else about the order changes: not its
-- status, lines, discounts, costs, papers or stock rows. It can't be brought
-- back.
--
-- delete_kind is 'test' (checked in code, no CHECK, so a newer till's kinds
-- still sync); a discarded cart keeps NULL. delete_stock is 'put_back' |
-- 'waste' | 'none' | 'settled_before' (already put back or wasted at a
-- cancel or refund, and left as it was).
--
-- Deletion wins between the two tills (apply-remote.ts): a delete that
-- arrives is applied even onto a newer local row, and a later change never
-- brings a deleted order or payment back.

ALTER TABLE orders ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE orders ADD COLUMN delete_reason TEXT;
ALTER TABLE orders ADD COLUMN delete_kind TEXT;
ALTER TABLE orders ADD COLUMN delete_stock TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_delete_kind ON orders(delete_kind, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_deleted_by ON orders(deleted_by);
