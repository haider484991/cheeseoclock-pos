-- 0012_web_order_imports.sql
-- Tracks website orders imported by the web bridge. Pure-local (per-device):
-- only the device running the bridge needs the mapping; the imported orders
-- themselves are replicable like any other order.
--
-- web_order_id is the website's UUID — PRIMARY KEY makes the import
-- idempotent: a re-poll after a half-failed ack can't create a second
-- local order for the same web order.

CREATE TABLE IF NOT EXISTS web_order_imports (
  web_order_id        TEXT PRIMARY KEY,
  pos_order_id        TEXT,
  status              TEXT NOT NULL DEFAULT 'imported'
                        CHECK (status IN ('imported', 'failed')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  /** Last web-facing status we successfully pushed to the site. */
  last_pushed_status  TEXT,
  imported_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_imports_pos_order
  ON web_order_imports(pos_order_id) WHERE pos_order_id IS NOT NULL;
