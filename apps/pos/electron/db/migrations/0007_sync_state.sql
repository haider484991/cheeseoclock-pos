-- 0007_sync_state.sql
-- Pure-local key/value store for sync cursors and worker state.
-- Keys we use:
--   'pull.cursor'          → opaque cursor string from the server, advances per pull
--   'push.last_event_id'   → uuid of the last sync_queue row we pushed (so re-runs resume)
--   'sync.last_attempt'    → ISO timestamp of last push/pull attempt
--   'sync.last_error'      → last error message, cleared on success
--   'sync.events_pushed'   → counter
--   'sync.events_pulled'   → counter
CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
