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
 *
 * readShopSetting is THE reader of the owner's shop rules — foodpanda's fees
 * included: everything that works out foodpanda's money (Pay's tablet
 * check, the terms kept at payment, Reports → Channels and Profit, the cost
 * sheet, Costing → Targets & fees) reads 'foodpanda.fees' through it, so the
 * v0.7.20 carry-over below happens in one place.
 */
import {
  BUSINESS_SETTING_READ_SCHEMAS,
  storedFormatIsNewer,
  type BusinessSettingKey,
  type BusinessSettingValue,
} from '@cheeseoclock/shared-schemas';
import { SHOP_SETTING_DEFAULTS, type ShopSettingKey, type ShopSettingValues } from '@cheeseoclock/shared-types';
import { foodpandaFeesFromChannelFees } from '@cheeseoclock/pos-domain';
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
  /**
   * 'foodpanda.fees' only: never saved, and what v0.7.20 saved in
   * 'channels.fees' is carried over (savedAt / savedByUserId are that row's).
   */
  carriedOver: boolean;
}

/**
 * One of the owner's shop rules, read on every call (no cache: the Reports
 * worker has its own connection and a setting from the other till arrives
 * through apply-remote with no hook, so a cache would go stale).
 */
export function readShopSetting<K extends ShopSettingKey>(db: AppDatabase, key: K): ShopSettingInUse<K> {
  const saved = getBusinessSetting(db, key);
  if (!saved) {
    // Never saved at all (a saved row that does not read is "not set", not "never saved").
    if (key === 'foodpanda.fees' && readBusinessSettingRow(db, key) === null) {
      const carried = feesCarriedOver(db);
      if (carried) return carried as ShopSettingInUse<K>;
    }
    return {
      value: { ...SHOP_SETTING_DEFAULTS[key] } as ShopSettingValues[K],
      isDefault: true,
      savedAt: null,
      savedByUserId: null,
      newerFormat: false,
      carriedOver: false,
    };
  }
  return {
    value: saved.value as unknown as ShopSettingValues[K],
    isDefault: false,
    savedAt: saved.updatedAt,
    savedByUserId: saved.updatedByUserId,
    newerFormat: saved.newerFormat,
    carriedOver: false,
  };
}

/**
 * v0.7.20 kept foodpanda's commission in 'channels.fees' (Costing → Targets
 * & fees). Settings → foodpanda is now the one place it lives; until the
 * owner saves it there, what he typed in v0.7.20 stays in force: its
 * commission and fixed fee, CONFIRMED (he typed them), the base mapped
 * (pos-domain LEGACY_COMMISSION_BASE_MAP: sales_ex_tax → after_deal,
 * menu_price → before_deal, paid_incl_tax → after_deal), its uplift. Read
 * time only: nothing is rewritten, so both tills read the same thing and the
 * first Save of the card takes over. Null when v0.7.20 saved no foodpanda
 * part (the suggested default applies).
 */
function feesCarriedOver(db: AppDatabase): ShopSettingInUse<'foodpanda.fees'> | null {
  const legacy = getBusinessSetting(db, 'channels.fees');
  const fp = legacy?.value.foodpanda;
  if (!legacy || !fp) return null;
  return {
    value: foodpandaFeesFromChannelFees(fp),
    isDefault: false,
    savedAt: legacy.updatedAt,
    savedByUserId: legacy.updatedByUserId,
    newerFormat: false,
    carriedOver: true,
  };
}
