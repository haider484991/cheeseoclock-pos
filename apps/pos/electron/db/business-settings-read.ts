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
import {
  DEFAULT_DELIVERY_ZONES,
  DEFAULT_MENU_IMPORT_POLICY,
  DEFAULT_ONLINE_OPTIONS,
  DEFAULT_STAFF_TIMING,
  DEFAULT_STOCK_RULES,
  DEFAULT_WEBSITE_PICKUP,
  SHOP_SETTING_DEFAULTS,
  deliveryZoneFeeItemIds,
  type ApprovalLimits,
  type DeliveryZoneSetting,
  type MenuImportPolicy,
  type OnlineOptions,
  type WebsitePickup,
  type ShopSettingKey,
  type ShopSettingValues,
  type StaffTiming,
  type StockRules,
} from '@cheeseoclock/shared-types';
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
): { id: string; valueJson: string; updatedAt: string; updatedByUserId: string | null; version: number } | null {
  const row = db
    .prepare(
      `SELECT id, value_json, updated_at, updated_by_user_id, version FROM business_settings
        WHERE key = ? AND deleted_at IS NULL`,
    )
    .get(key) as
    | { id: string; value_json: string; updated_at: string; updated_by_user_id: string | null; version: number }
    | undefined;
  return row
    ? {
        id: row.id,
        valueJson: row.value_json,
        updatedAt: row.updated_at,
        updatedByUserId: row.updated_by_user_id,
        version: row.version,
      }
    : null;
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
 * The live approval limit ('discounts.approval'), as the main process checks
 * a discount (pos-domain requiresManagerApproval): the IPC handler and the
 * repository's save and cart re-check read it on every call, so a Save —
 * here or arrived from the other till — counts at once. The default (10%,
 * Rs 500) when nothing is saved.
 */
export function readApprovalLimits(db: AppDatabase): ApprovalLimits {
  const { percentOver, flatOverCents } = readShopSetting(db, 'discounts.approval').value;
  return { percentOver, flatOverCents };
}

/**
 * Does a discount given NOW also come off the delivery charge
 * ('discounts.delivery')? Read live by the main process when a staff
 * discount is applied or an order becomes foodpanda, and frozen onto that
 * discount row there (order-repo applyDiscount, putOnFoodpandaDeal). Nothing
 * after that reads it: the row's own rule decides. No (false) when nothing
 * is saved — the owner's answer.
 */
export function readDiscountAlsoOffDeliveryCharge(db: AppDatabase): boolean {
  return readShopSetting(db, 'discounts.delivery').value.alsoOffDeliveryCharge;
}

/**
 * The staff timings ('staff.timing') auth-service, the step-in hold and the
 * reprint rule use, read on every call. A read that fails (it should not)
 * falls back to the released defaults rather than locking the till.
 */
export function readStaffTiming(db: AppDatabase | null): StaffTiming {
  if (!db) return { ...DEFAULT_STAFF_TIMING };
  try {
    return readShopSetting(db, 'staff.timing').value;
  } catch {
    return { ...DEFAULT_STAFF_TIMING };
  }
}

/**
 * The stock rules ('stock.rules', Settings → Kitchen & stock) — the
 * variance's "Do this" trigger, bands and shortest window, the stock-take
 * reminders, the reorder multiple and the waste reasons — read on every
 * call (the Reports worker too). A read that fails (it should not) falls
 * back to the released rules rather than breaking a report.
 */
export function readStockRules(db: AppDatabase | null): StockRules {
  if (!db) return structuredClone(DEFAULT_STOCK_RULES) as StockRules;
  try {
    return readShopSetting(db, 'stock.rules').value;
  } catch {
    return structuredClone(DEFAULT_STOCK_RULES) as StockRules;
  }
}

/**
 * What a menu file import may change ('menu.importPolicy'), read when the
 * import is planned and again inside its transaction. The released one
 * (the file wins) when nothing is saved.
 */
export function readMenuImportPolicy(db: AppDatabase): MenuImportPolicy {
  try {
    return readShopSetting(db, 'menu.importPolicy').value;
  } catch {
    return { ...DEFAULT_MENU_IMPORT_POLICY };
  }
}

/**
 * The owner's delivery areas and fees ('delivery.zones', Settings →
 * Delivery areas), read on every call — the till's area picker and fee
 * button (checkout:getRules), the order's delivery charge, the Customers
 * filter, the menu locks and import, Reports (its worker too) and the
 * website's settings block. Every area, switched-off ones included (an old
 * address is still recognised). Today's 21 areas and fees when nothing is
 * saved, or when a read fails (it should not).
 */
export function readDeliveryZones(db: AppDatabase | null): DeliveryZoneSetting[] {
  if (!db) return structuredClone(DEFAULT_DELIVERY_ZONES.zones) as DeliveryZoneSetting[];
  try {
    return readShopSetting(db, 'delivery.zones').value.zones;
  } catch {
    return structuredClone(DEFAULT_DELIVERY_ZONES.zones) as DeliveryZoneSetting[];
  }
}

/**
 * The menu items the areas charge their fees with (each area's feeItemId):
 * a menu item is a delivery charge when it is one of these, or — data from
 * before Settings step 3, or an older till's — when it is named like one
 * (shared-types isDeliveryChargeMenuItem).
 */
export function readDeliveryFeeItemIds(db: AppDatabase | null): Set<string> {
  return deliveryZoneFeeItemIds(readDeliveryZones(db));
}

/** The website's pick-up offer ('discounts.websitePickup'): offered, and its whole %. Today's (on, 10%) when nothing is saved. */
export function readWebsitePickup(db: AppDatabase): WebsitePickup {
  try {
    return readShopSetting(db, 'discounts.websitePickup').value;
  } catch {
    return { ...DEFAULT_WEBSITE_PICKUP };
  }
}

/** How the till works with the website ('online.options'): today's (the menu goes only when asked) when nothing is saved. */
export function readOnlineOptions(db: AppDatabase): OnlineOptions {
  try {
    return readShopSetting(db, 'online.options').value;
  } catch {
    return { ...DEFAULT_ONLINE_OPTIONS };
  }
}

/**
 * v0.7.20 kept foodpanda's commission, and its "Foodpanda" payment fee, in
 * 'channels.fees' (Costing → Targets & fees). Settings → foodpanda is now
 * the one place they live; until the owner saves it there, what v0.7.20
 * saved stays in force (pos-domain foodpandaFeesFromChannelFees: the base
 * mapped, the payment fee as foodpanda's % of the total, CONFIRMED only when
 * the owner can have typed it — not v0.7.20's own default, and a base that
 * maps exactly). Read time only: nothing is rewritten, so both tills read
 * the same thing and the first Save of the card takes over. Null when
 * v0.7.20 saved nothing worth carrying (the suggested default applies).
 */
function feesCarriedOver(db: AppDatabase): ShopSettingInUse<'foodpanda.fees'> | null {
  const legacy = getBusinessSetting(db, 'channels.fees');
  const value = legacy ? foodpandaFeesFromChannelFees(legacy.value) : null;
  if (!legacy || !value) return null;
  return {
    value,
    isDefault: false,
    savedAt: legacy.updatedAt,
    savedByUserId: legacy.updatedByUserId,
    newerFormat: false,
    carriedOver: true,
  };
}
