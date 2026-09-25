import type { AppDatabase } from '../connection.js';
import { nowIso } from './base.js';
import { writeAudit } from './audit-repo.js';

/** Field names whose values never go into the audit log (sealed or not). */
const SECRET_FIELD = /secret|token|password|apikey|api_key|credential/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_FIELD.test(k) ? (v ? '[hidden]' : v) : redact(v),
      ]),
    );
  }
  return value;
}

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

/**
 * `audit` is for settings a person changes (printers, FBR, the website link,
 * branding): who changed what, before and after, secrets hidden. Left off for
 * the till's own bookkeeping (last backup time and so on) — that is not a change
 * anyone made. Settings changes used to leave no trace at all.
 */
export function setSetting(
  db: AppDatabase,
  key: string,
  value: unknown,
  audit?: { actorUserId: string | null },
): void {
  const json = JSON.stringify(value);
  const now = nowIso();
  db.transaction(() => {
    const before = audit ? getSettingRaw(db, key) : null;
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(key, json, now);
    if (audit && JSON.stringify(before) !== json) {
      writeAudit(db, {
        entityType: 'settings',
        entityId: key,
        action: 'settings_change',
        actorUserId: audit.actorUserId,
        before: redact(before),
        after: redact(value),
      });
    }
  })();
}

export function deleteSetting(db: AppDatabase, key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}
