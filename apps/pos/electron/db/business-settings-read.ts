/**
 * Reading one shop-wide setting (business_settings, migration 0032). The
 * writes, with their sync and audit rows, stay in
 * repositories/business-settings-repo.ts, which re-exports this. Kept apart
 * so the Reports worker thread (services/analytics/worker.ts) can read the
 * food-cost targets without loading the write path, and Electron with it.
 *
 * Every value is checked against its key's Zod schema on the way out: a
 * stored value that does not fit (a newer till's format) is read as "not
 * set", never trusted.
 */
import {
  BUSINESS_SETTING_SCHEMAS,
  type BusinessSettingKey,
  type BusinessSettingValue,
} from '@cheeseoclock/shared-schemas';
import type { AppDatabase } from './connection.js';

export interface StoredBusinessSetting<K extends BusinessSettingKey> {
  value: BusinessSettingValue<K>;
  updatedAt: string;
  updatedByUserId: string | null;
}

export function getBusinessSetting<K extends BusinessSettingKey>(db: AppDatabase, key: K): StoredBusinessSetting<K> | null {
  const row = db
    .prepare(
      `SELECT value_json, updated_at, updated_by_user_id FROM business_settings
        WHERE key = ? AND deleted_at IS NULL`,
    )
    .get(key) as { value_json: string; updated_at: string; updated_by_user_id: string | null } | undefined;
  if (!row) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.value_json);
  } catch {
    return null;
  }
  const parsed = BUSINESS_SETTING_SCHEMAS[key].safeParse(raw);
  if (!parsed.success) return null;
  return {
    value: parsed.data as BusinessSettingValue<K>,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
  };
}
