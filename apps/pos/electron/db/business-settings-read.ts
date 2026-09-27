/**
 * Reading one shop-wide setting (business_settings, migration 0032). The
 * writes, with their sync and audit rows, stay in
 * repositories/business-settings-repo.ts, which re-exports this. Kept apart
 * so the Reports worker thread (services/analytics/worker.ts) can read the
 * food-cost targets without loading the write path, and Electron with it.
 *
 * Every value is checked against its key's READ schema on the way out
 * (shared-schemas BUSINESS_SETTING_READ_SCHEMAS): the costing keys as they
 * are written; the owner's shop rules (Settings → foodpanda …) leniently —
 * fields this version does not know are dropped, so a value a newer till
 * saved is still used for what this till understands. A stored value that
 * does not fit at all is read as "not set", never trusted.
 */
import {
  BUSINESS_SETTING_READ_SCHEMAS,
  storedFormatIsNewer,
  type BusinessSettingKey,
  type BusinessSettingValue,
} from '@cheeseoclock/shared-schemas';
import { SHOP_SETTING_DEFAULTS, type ShopSettingKey, type ShopSettingValues } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';

export interface StoredBusinessSetting<K extends BusinessSettingKey> {
  value: BusinessSettingValue<K>;
  updatedAt: string;
  updatedByUserId: string | null;
  /** Saved by a newer version of the app (a higher format, or fields this version does not know). */
  newerFormat: boolean;
}

/** The stored row for a key, as it is on disk (before any schema). */
export function readBusinessSettingRow(
  db: AppDatabase,
  key: BusinessSettingKey,
): { id: string; valueJson: string; updatedAt: string; updatedByUserId: string | null } | null {
  const row = db
    .prepare(
      `SELECT id, value_json, updated_at, updated_by_user_id FROM business_settings
        WHERE key = ? AND deleted_at IS NULL`,
    )
    .get(key) as { id: string; value_json: string; updated_at: string; updated_by_user_id: string | null } | undefined;
  return row ? { id: row.id, valueJson: row.value_json, updatedAt: row.updated_at, updatedByUserId: row.updated_by_user_id } : null;
}

export function getBusinessSetting<K extends BusinessSettingKey>(db: AppDatabase, key: K): StoredBusinessSetting<K> | null {
  const row = readBusinessSettingRow(db, key);
  if (!row) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.valueJson);
  } catch {
    return null;
  }
  const parsed = BUSINESS_SETTING_READ_SCHEMAS[key].safeParse(raw);
  if (!parsed.success) return null;
  return {
    value: parsed.data as BusinessSettingValue<K>,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
    newerFormat: storedFormatIsNewer(key, raw),
  };
}

/** A shop rule as the till uses it: the saved value, or its frozen default when nothing (readable) is saved. */
export interface ShopSettingInUse<K extends ShopSettingKey> {
  value: ShopSettingValues[K];
  /** Nothing readable is saved: this is the default. */
  isDefault: boolean;
  /** When it was saved (the row's updated_at); null for the default. */
  savedAt: string | null;
  /** Who saved it last (the row's updated_by_user_id). */
  savedByUserId: string | null;
  newerFormat: boolean;
}

/**
 * One of the owner's shop rules, read on every call (no cache: the Reports
 * worker has its own connection and a setting from the other till arrives
 * through apply-remote with no hook, so a cache would go stale).
 */
export function readShopSetting<K extends ShopSettingKey>(db: AppDatabase, key: K): ShopSettingInUse<K> {
  const saved = getBusinessSetting(db, key);
  if (!saved) {
    return { value: { ...SHOP_SETTING_DEFAULTS[key] } as ShopSettingValues[K], isDefault: true, savedAt: null, savedByUserId: null, newerFormat: false };
  }
  return {
    value: saved.value as unknown as ShopSettingValues[K],
    isDefault: false,
    savedAt: saved.updatedAt,
    savedByUserId: saved.updatedByUserId,
    newerFormat: saved.newerFormat,
  };
}
