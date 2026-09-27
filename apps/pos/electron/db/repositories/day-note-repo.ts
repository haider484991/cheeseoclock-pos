import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, type Actor } from './base.js';
import {
  excludedFromForecastByDefault,
  isDayNoteTag,
  type DayNoteInput,
  type ReportDayNote,
} from '@cheeseoclock/shared-types';
import { dayNoteFromRow, type DayNoteRow } from '../day-notes-read.js';

/**
 * Day notes (migration 0037, costing spec Phase 7): "Eid", "rain",
 * "closed"… on a trading day, added on Reports → When by a manager or the
 * owner. Each add and each removal is the row, its sync entry and a
 * hash-chained audit row, in one transaction (writeWithSync). Reading them
 * for Reports is the worker's (../day-notes-read.ts).
 */

const DAY_MS = 86_400_000;
/** The oldest day a note may be for (before any till was in use). */
const OLDEST_DAY = '2020-01-01';
/** How far ahead a note may be put ("closed for Eid" next month, a match next season). */
const AHEAD_DAYS = 366;

/**
 * Why a day cannot take a note, in plain words, or null when it can: a real
 * date, from 2020, and no more than a year ahead of today's trading day.
 */
export function dayNoteDayProblem(day: string, now: Date = new Date()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return 'That is not a real date.';
  if (day < OLDEST_DAY) return 'Pick a day from 2020 on.';
  // The trading day is the UTC date (05:00 Pakistan time = 00:00 UTC).
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  if (t > today + AHEAD_DAYS * DAY_MS) return 'Pick a day within the next year.';
  return null;
}

/** Add a note for a day. Throws plain words when the day or tag will not do. */
export function addDayNote(db: AppDatabase, input: DayNoteInput, actor: Actor, now: Date = new Date()): ReportDayNote {
  const problem = dayNoteDayProblem(input.day, now);
  if (problem) throw new Error(problem);
  if (!isDayNoteTag(input.tag)) throw new Error('Pick what the day was.');
  const note = (input.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const exclude = input.excludeFromForecast ?? excludedFromForecastByDefault(input.tag);
  const id = uuidv7();
  const at = nowIso();
  const after = {
    id,
    day: input.day,
    tag: input.tag,
    note,
    excludeFromForecast: exclude,
    createdByUserId: actor.userId,
    // audit_log has no device column; the shop may run two tills.
    deviceId: actor.deviceId,
    createdAt: at,
  };
  writeWithSync({
    db,
    // The sync entity type is the table name (row images are read by it).
    entityType: 'day_notes',
    entityId: id,
    op: 'upsert',
    action: 'day_note_add',
    actor,
    before: null,
    after,
    writeRow: () => {
      db.prepare(
        `INSERT INTO day_notes
           (id, day, tag, note, exclude_from_forecast, created_by_user_id, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(id, input.day, input.tag, note, exclude ? 1 : 0, actor.userId, at, at, actor.deviceId);
    },
  });
  return getDayNote(db, id)!;
}

/**
 * Take a note off: marked removed (deleted_at), never erased, so the
 * history and the audit trail keep it. False when there was no such note (or
 * it was off already).
 */
export function removeDayNote(db: AppDatabase, id: string, actor: Actor): boolean {
  const before = getDayNote(db, id);
  if (!before) return false;
  const at = nowIso();
  writeWithSync({
    db,
    entityType: 'day_notes',
    entityId: id,
    op: 'delete',
    action: 'day_note_remove',
    actor,
    before,
    after: null,
    writeRow: () => {
      db.prepare(`UPDATE day_notes SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL`).run(at, at, id);
    },
  });
  return true;
}

/** One note that is still on, with who added it; null otherwise. */
export function getDayNote(db: AppDatabase, id: string): ReportDayNote | null {
  const row = db
    .prepare(
      `SELECT n.id, n.day, n.tag, n.note, n.exclude_from_forecast, n.created_at, u.full_name AS added_by
         FROM day_notes n
         LEFT JOIN users u ON u.id = n.created_by_user_id
        WHERE n.id = ? AND n.deleted_at IS NULL`,
    )
    .get(id) as DayNoteRow | undefined;
  return row ? dayNoteFromRow(row) : null;
}
