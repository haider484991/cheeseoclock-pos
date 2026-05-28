-- 0010_print_queue.sql
-- Persistent print job queue. Until now the print spooler was in-memory only,
-- so a crash between tender and print silently lost the receipt — sale was
-- in the books, paper was never printed, audit didn't notice.
--
-- This mirrors the fbr_submission_queue pattern: enqueue → worker drains →
-- retries with backoff → terminal status ('done' or 'failed') surfaced via
-- the existing printer:failed IPC.

CREATE TABLE IF NOT EXISTS print_queue (
  id              TEXT PRIMARY KEY,
  job_kind        TEXT NOT NULL CHECK (job_kind IN ('receipt')),
  -- Order ref (FK NOT enforced — we want orphan jobs to surface as failures,
  -- not silently disappear if an order was hard-deleted somehow).
  order_id        TEXT,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  -- Scheduling: workers pick pending jobs where next_attempt_at <= now.
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_print_queue_pending
  ON print_queue(next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_print_queue_order
  ON print_queue(order_id);
