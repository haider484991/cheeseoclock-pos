-- 0004_fbr_queue.sql
-- Pure-local queue for FBR Digital Invoicing submissions. NOT replicable —
-- each device submits its own sales to FBR independently (PRAL identifies the
-- submitter by bearer token, not by sync events).

CREATE TABLE IF NOT EXISTS fbr_submission_queue (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  irn             TEXT,
  qr_payload      TEXT,
  enqueued_at     TEXT NOT NULL,
  submitted_at    TEXT,
  next_attempt_at TEXT,
  mode_at_enqueue TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Worker scans pending rows ordered by enqueued_at.
CREATE INDEX IF NOT EXISTS idx_fbr_queue_drain
  ON fbr_submission_queue(status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- Lookup by order_id (e.g. to find the IRN for a re-printed receipt).
CREATE UNIQUE INDEX IF NOT EXISTS idx_fbr_queue_order
  ON fbr_submission_queue(order_id);
