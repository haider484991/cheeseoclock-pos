/**
 * Reading day notes (migration 0037, costing spec Phase 7). The writes, with
 * their sync and audit rows, stay in repositories/day-note-repo.ts. Kept
 * apart so the Reports worker thread (services/analytics/worker.ts) reads
 * them — Reports → When lists them and the heatmap leaves closed days out —
 * without loading the write path, and Electron with it.
 */
import { isDayNoteTag, type ReportDayNote } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';

export interface DayNoteRow {
  id: string;
  day: string;
  tag: string;
  note: string | null;
  exclude_from_forecast: number;
  created_at: string;
  added_by: string | null;
}

export function dayNoteFromRow(r: DayNoteRow): ReportDayNote {
  return {
    id: r.id,
    day: r.day,
    // A newer till's tag this one does not know still shows, as "Other".
    tag: isDayNoteTag(r.tag) ? r.tag : 'other',
    note: r.note,
    excludeFromForecast: Number(r.exclude_from_forecast) === 1,
    addedBy: r.added_by,
    createdAt: r.created_at,
  };
}

/** The notes still on for the trading days firstDay … lastDay (YYYY-MM-DD, inclusive), oldest day first (idx_day_notes_day). */
export function readDayNotes(db: AppDatabase, firstDay: string, lastDay: string): ReportDayNote[] {
  return (
    db
      .prepare(
        `SELECT n.id, n.day, n.tag, n.note, n.exclude_from_forecast, n.created_at, u.full_name AS added_by
           FROM day_notes n
           LEFT JOIN users u ON u.id = n.created_by_user_id
          WHERE n.day >= ? AND n.day <= ? AND n.deleted_at IS NULL
          ORDER BY n.day, n.created_at, n.id`,
      )
      .all(firstDay, lastDay) as DayNoteRow[]
  ).map(dayNoteFromRow);
}
