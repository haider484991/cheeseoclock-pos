-- 0037_day_notes.sql
-- Costing, Phase 7: the owner's week. Notes on trading days, added on
-- Reports → When by a manager or the owner (report.view): "Eid", "rain",
-- "load-shedding", "closed"… so a quiet Friday has its reason beside it.
--
--   day                    the trading day (YYYY-MM-DD; 05:00 → 05:00
--                          Pakistan time, the same day the reports use);
--   tag                    'closed' | 'eid' | 'ramadan' | 'rain' |
--                          'load_shedding' | 'cricket' | 'event' | 'other'.
--                          Checked in shared-schemas (DAY_NOTE_TAGS), not by a
--                          CHECK, so a newer till's tag still lands here (as in
--                          0028 / 0033). A 'closed' day is left out of the
--                          weekday × hour heatmap's averages;
--   note                   a few words, optional;
--   exclude_from_forecast  1: leave the day out of the forecast (costing spec
--                          Phase 12); the screen suggests it for closed days
--                          and Eid;
--   created_by_user_id     who added it.
-- A day may have more than one note (one from each till, or rain AND a
-- match). Taking a note off is a soft delete (deleted_at), so the history
-- keeps it.
--
-- Replicable (sync columns, uuid v7 ids: one writer per note); written only
-- through repositories/day-note-repo.ts, each change with its sync entry and
-- hash-chained audit row. Every foreign key has an index.
CREATE TABLE IF NOT EXISTS day_notes (
  id                     TEXT PRIMARY KEY,
  day                    TEXT NOT NULL,
  tag                    TEXT NOT NULL,
  note                   TEXT,
  exclude_from_forecast  INTEGER NOT NULL DEFAULT 0 CHECK (exclude_from_forecast IN (0, 1)),
  created_by_user_id     TEXT REFERENCES users(id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  synced_at              TEXT,
  deleted_at             TEXT,
  device_id              TEXT NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1
);

-- The notes of a period (Reports → When, the heatmap's closed days).
CREATE INDEX IF NOT EXISTS idx_day_notes_day ON day_notes(day);
CREATE INDEX IF NOT EXISTS idx_day_notes_created_by
  ON day_notes(created_by_user_id) WHERE created_by_user_id IS NOT NULL;
