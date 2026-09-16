-- 0017_fbr_queue_kind.sql
-- A refund has to reach FBR as a Debit Note against the original invoice;
-- until now only the sale was ever submitted, so a refunded order stayed a
-- taxed sale on the FBR side. The queue therefore learns a `kind` and a
-- `ref_id` (the refund payment the note reverses) so one order can carry its
-- sale invoice plus one debit note per refund. The old UNIQUE(order_id) is
-- widened to (order_id, kind, ref_id); sale rows keep ref_id = '' so the
-- existing "one sale invoice per order" upsert keeps working.
ALTER TABLE fbr_submission_queue
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale', 'debit_note'));
ALTER TABLE fbr_submission_queue
  ADD COLUMN ref_id TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS idx_fbr_queue_order;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fbr_queue_order_kind
  ON fbr_submission_queue(order_id, kind, ref_id);
