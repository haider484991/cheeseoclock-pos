import type { AppDatabase } from '../connection.js';
import { nowIso } from './base.js';

/**
 * Pure-local key/value store. Values are JSON. No sync.
 *
 * Callers pass a Zod schema in the getter to validate / type the value at the
 * boundary — never trust what was in the DB previously.
 */

export function getSettingRaw(db: AppDatabase, key: string): unknown {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

export function setSetting(db: AppDatabase, key: string, value: unknown): void {
  const json = JSON.stringify(value);
  const now = nowIso();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, json, now);
}

export function deleteSetting(db: AppDatabase, key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}
