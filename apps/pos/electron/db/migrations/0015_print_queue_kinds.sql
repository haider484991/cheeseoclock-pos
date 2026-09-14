-- 0015_print_queue_kinds.sql
-- The print queue learns two more job kinds:
--   'kitchen' — a kitchen ticket (what to cook, no prices), printed once when
--               an order is sent to the kitchen or paid up front;
--   'drawer'  — a bare cash-drawer pulse, for taking money in when no paper is
--               wanted (a rider handing over the cash for an order whose bill
--               already left with the food).
-- SQLite can't widen a CHECK, so the table is rebuilt. print_queue is a
-- pure-local table that nothing references, so no foreign keys to switch off;
-- the swap still runs in one transaction so a crash mid-way leaves the old
-- queue intact.

BEGIN TRANSACTION;

CREATE TABLE print_queue_new (
  id              TEXT PRIMARY KEY,
  job_kind        TEXT NOT NULL CHECK (job_kind IN ('receipt', 'kitchen', 'drawer')),
  order_id        TEXT,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);

INSERT INTO print_queue_new
  (id, job_kind, order_id, payload_json, status, attempts, last_error,
   next_attempt_at, created_at, updated_at, completed_at)
  SELECT id, job_kind, order_id, payload_json, status, attempts, last_error,
         next_attempt_at, created_at, updated_at, completed_at
    FROM print_queue;

DROP TABLE print_queue;
ALTER TABLE print_queue_new RENAME TO print_queue;

CREATE INDEX IF NOT EXISTS idx_print_queue_pending
  ON print_queue(next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_print_queue_order
  ON print_queue(order_id);
-- "Has this order already had a kitchen ticket / a dispatch bill?"
CREATE INDEX IF NOT EXISTS idx_print_queue_order_kind
  ON print_queue(order_id, job_kind);

COMMIT;
