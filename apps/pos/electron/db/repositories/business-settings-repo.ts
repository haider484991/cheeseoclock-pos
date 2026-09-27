import { v5 as uuidv5 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { getBusinessSetting, type StoredBusinessSetting } from '../business-settings-read.js';
import { COC_ID_NAMESPACE } from '@cheeseoclock/shared-types';
import {
  BUSINESS_SETTING_SCHEMAS,
  isBusinessSettingKey,
  type BusinessSettingKey,
  type BusinessSettingValue,
} from '@cheeseoclock/shared-schemas';

/**
 * Shop-wide settings both tills share (migration 0032, costing spec §3):
 * food-cost targets, the price step… One row per key. Unlike the per-till
 * `settings` table these replicate, so a target set on one till is the
 * target on the other.
 *
 * The id is a name-based uuid v5 of the key (spec D13): the same key written
 * on both tills while the link is down is the SAME row, and the link keeps
 * the later write (apply-remote: version, then updated_at) instead of
 * parking a UNIQUE clash for ever.
 *
 * Every value is checked against its key's Zod schema on the way in AND on
 * the way out: a stored value that does not fit (a newer till's format) is
 * read as "not set", never trusted.
 */

/** The row id for a key: the same on every till. */
export function businessSettingId(key: string): string {
  return uuidv5(`business_settings:${key}`, COC_ID_NAMESPACE);
}

// Reading a setting lives in ../business-settings-read.ts (the Reports worker loads it without this write path).
export { getBusinessSetting, type StoredBusinessSetting };

/** One key and its value, for setBusinessSettings. */
export type BusinessSettingEntry = { [K in BusinessSettingKey]: { key: K; value: BusinessSettingValue<K> } }[BusinessSettingKey];

/**
 * Save one setting: the row (insert, or update with version + 1), its sync
 * entry and an audit row with before and after, in one transaction. Throws
 * the Zod message when the value does not fit the key.
 */
export function setBusinessSetting<K extends BusinessSettingKey>(
  db: AppDatabase,
  key: K,
  value: BusinessSettingValue<K>,
  actor: Actor,
): void {
  setBusinessSettings(db, [{ key, value } as BusinessSettingEntry], actor);
}

/** Save several settings together: all or none (one transaction). */
export function setBusinessSettings(db: AppDatabase, entries: readonly BusinessSettingEntry[], actor: Actor): void {
  const checked = entries.map(({ key, value }) => {
    if (!isBusinessSettingKey(key)) throw new Error(`Unknown setting "${String(key)}"`);
    const parsed = BUSINESS_SETTING_SCHEMAS[key].safeParse(value);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? `That value does not fit "${key}"`);
    }
    return { key, value: parsed.data as unknown };
  });
  const now = nowIso();
  const tx = db.transaction(() => {
    for (const { key, value } of checked) {
      const id = businessSettingId(key);
      const json = JSON.stringify(value);
      const existing = db
        .prepare(`SELECT value_json, deleted_at FROM business_settings WHERE id = ?`)
        .get(id) as { value_json: string; deleted_at: string | null } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE business_settings
              SET key = ?, value_json = ?, updated_by_user_id = ?, deleted_at = NULL,
                  updated_at = ?, version = version + 1
            WHERE id = ?`,
        ).run(key, json, actor.userId, now, id);
      } else {
        db.prepare(
          `INSERT INTO business_settings
             (id, key, value_json, updated_by_user_id, created_at, updated_at, device_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, key, json, actor.userId, now, now, actor.deviceId);
      }
      enqueueSync(db, {
        entityType: 'business_settings',
        entityId: id,
        op: 'upsert',
        payload: { id, key, value },
      });
      writeAudit(db, {
        entityType: 'business_settings',
        entityId: id,
        action: existing ? 'update' : 'create',
        actorUserId: actor.userId,
        before: existing && existing.deleted_at === null ? { key, value: safeJson(existing.value_json) } : null,
        after: { key, value },
      });
    }
  });
  tx();
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
