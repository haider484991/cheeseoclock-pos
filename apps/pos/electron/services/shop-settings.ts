/**
 * The owner's shop rules (Settings → foodpanda …; shared-types
 * shop-settings.ts) as the till reads them. Stored in business_settings
 * (synced between the tills), saved through business-settings-repo (row +
 * sync + hash-chained audit, one transaction).
 *
 * NO CACHE. Every read is one indexed row and a Zod parse — cheap even on
 * every cart change. The Reports worker has its own connection and a setting
 * from the other till arrives through apply-remote with no hook, so a cache
 * would go stale.
 *
 * Read-only and free of Electron: the handlers call it, and so can a worker.
 */
import {
  FOODPANDA_TABLET_TOLERANCE_CENTS,
  SHOP_SETTING_DEFAULTS,
  SHOP_SETTING_KEYS,
  type CheckoutRules,
  type ItemFoodpandaLine,
  type ShopSettingCard,
  type ShopSettingHistoryLine,
  type ShopSettingKey,
  type ShopSettingValues,
  type TillLinkState,
} from '@cheeseoclock/shared-types';
import { BUSINESS_SETTING_READ_SCHEMAS } from '@cheeseoclock/shared-schemas';
import {
  activeFoodpandaDeal,
  atFoodpandaPrices,
  dealAmount,
  foodpandaDealLabel,
  foodpandaDealRule,
  foodpandaTerms,
  shareBps,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import { readBusinessSettingRow, readShopSetting, type ShopSettingInUse } from '../db/business-settings-read.js';
import { businessSettingId } from '../db/business-settings-ids.js';

export { readShopSetting, type ShopSettingInUse };

/** Every shop rule, as the till uses it now (saved values, or the defaults). */
export type ShopSettings = { [K in ShopSettingKey]: ShopSettingInUse<K> };

export function getShopSettings(db: AppDatabase): ShopSettings {
  const out = {} as Record<ShopSettingKey, ShopSettingInUse<ShopSettingKey>>;
  for (const key of SHOP_SETTING_KEYS) out[key] = readShopSetting(db, key);
  return out as ShopSettings;
}

/**
 * What the counter needs to take an order (checkout:getRules), for any
 * signed-in login: the foodpanda deal an order started now gets (its % and
 * label, never who saved it), what Pay asks, and how much dearer the
 * foodpanda listing is (a price: the tablet's total is the till's at those
 * prices). Never the commission, fees or costs.
 */
export function checkoutRules(db: AppDatabase, now: Date = new Date()): CheckoutRules {
  const deal = readShopSetting(db, 'foodpanda.deal').value;
  const checks = readShopSetting(db, 'foodpanda.checks').value;
  const { upliftBps } = readShopSetting(db, 'foodpanda.fees').value;
  const active = activeFoodpandaDeal(deal, now.toISOString());
  return {
    foodpanda: {
      deal: active
        ? {
            label: foodpandaDealLabel(active.percent, Math.min(active.shopPercent, active.percent)),
            percent: active.percent,
            shopPercent: Math.min(active.shopPercent, active.percent),
            minOrderCents: active.minOrderCents,
            maxOffCents: active.maxOffCents,
          }
        : null,
      checks: { orderCode: checks.orderCode, tabletTotal: checks.tabletTotal },
      tabletToleranceCents: FOODPANDA_TABLET_TOLERANCE_CENTS,
      upliftBps,
    },
  };
}

/**
 * The Costing item sheet's "On foodpanda" line for a typical plate: the
 * listing price (the till's at foodpanda's prices), what it sells for after
 * the shop's part of the deal a foodpanda order started now gets — the same
 * foodpandaTerms as Pay, the kept terms and Reports — and, with profit.view
 * only (`withProfit`: the owner), foodpanda's commission and what the shop
 * keeps. The main process decides `withProfit` (costing:itemSheet), so a
 * manager's sheet never carries them. The deal's minimum is about the whole
 * order, not one plate: the plate is worked out as part of an order that
 * reaches it (a Rs 800 burger on a "from Rs 1,000" deal still sells at the
 * deal's price in a bigger order), and the sheet says the minimum in words.
 * Null when the item has no price.
 */
export function itemFoodpandaLine(
  db: AppDatabase,
  plate: { priceCents: number; costCents: number },
  withProfit: boolean,
  now: Date = new Date(),
): ItemFoodpandaLine | null {
  if (!(plate.priceCents > 0)) return null;
  const deal = activeFoodpandaDeal(readShopSetting(db, 'foodpanda.deal').value, now.toISOString());
  const fees = readShopSetting(db, 'foodpanda.fees').value;
  // The deal as an order started now gets it (its most-off at foodpanda's prices), minimum aside.
  const amount = deal
    ? dealAmount({ ...foodpandaDealRule(deal, null, fees.upliftBps), minOrderCents: null }, plate.priceCents)
    : { shopCents: 0 };
  // One plate on its own bill, before tax: the order's value at foodpanda's prices is what it sells for.
  const t = foodpandaTerms(
    { subtotalCents: plate.priceCents, shopDiscountCents: amount.shopCents, totalCents: plate.priceCents - amount.shopCents },
    fees,
  );
  const after = plate.priceCents - amount.shopCents + t.upliftCents;
  const owner: ItemFoodpandaLine['owner'] = withProfit
    ? {
        commissionBps: fees.commissionBps,
        confirmed: fees.confirmed,
        foodpandaKeepsCents: t.foodpandaKeepsCents,
        youKeepCents: t.youKeepCents,
        foodCostOfKeptBps: shareBps(plate.costCents, t.youKeepCents),
      }
    : null;
  return {
    dealPercent: deal?.percent ?? 0,
    shopPercent: deal ? Math.min(deal.shopPercent, deal.percent) : 0,
    minOrderCents: deal?.minOrderCents ?? null,
    priceCents: plate.priceCents,
    upliftBps: fees.upliftBps,
    listingPriceCents: atFoodpandaPrices(plate.priceCents, fees.upliftBps),
    priceAfterDealCents: after,
    foodCostBps: shareBps(plate.costCents, after),
    owner,
  };
}

/** Changes shown under a card. */
const HISTORY_CAP = 20;

/**
 * One Settings card: the value in use, whether it is the default, who
 * changed it last and where, whether the other till has it yet, its history
 * (this till's saves and the ones that arrived from the other till), and
 * whether a newer version of the app saved it (read-only here).
 */
export function getShopSettingCard<K extends ShopSettingKey>(
  db: AppDatabase,
  key: K,
  link: TillLinkState,
): ShopSettingCard<K> {
  const inUse = readShopSetting(db, key);
  const id = businessSettingId(key);
  const row = readBusinessSettingRow(db, key);
  const names = userNames(db);

  const audit = db
    .prepare(
      `SELECT action, actor_user_id, after_json, created_at FROM audit_log
        WHERE entity_type = 'business_settings' AND entity_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(id, HISTORY_CAP) as Array<{ action: string; actor_user_id: string | null; after_json: string | null; created_at: string }>;

  const history: Array<ShopSettingHistoryLine<K>> = audit.map((a) => {
    const after = parseJson(a.after_json) as { value?: unknown; updatedByUserId?: unknown } | null;
    const remote = a.action === 'remote_apply';
    const by = remote ? (typeof after?.updatedByUserId === 'string' ? after.updatedByUserId : null) : a.actor_user_id;
    const parsed = BUSINESS_SETTING_READ_SCHEMAS[key].safeParse(after?.value);
    return {
      at: a.created_at,
      byName: by ? (names.get(by) ?? null) : null,
      onThisTill: !remote,
      value: parsed.success ? (parsed.data as unknown as ShopSettingValues[K]) : null,
    };
  });

  const unsent =
    row !== null &&
    link.on &&
    db
      .prepare(
        `SELECT 1 AS x FROM sync_queue
          WHERE entity_type = 'business_settings' AND entity_id = ? AND synced_at IS NULL
          LIMIT 1`,
      )
      .get(id) !== undefined;

  const defaultValue = { ...SHOP_SETTING_DEFAULTS[key] } as ShopSettingValues[K];
  return {
    key,
    value: inUse.value,
    defaultValue,
    // The value in use IS the default: never saved, or put back ("Put back the
    // default" writes the default's values, so a saved row can be the default).
    isDefault: !inUse.newerFormat && sameSettingValue(inUse.value, defaultValue),
    readOnly: inUse.newerFormat,
    ...(key === 'foodpanda.fees' ? { carriedOver: inUse.carriedOver } : {}),
    lastChanged: row
      ? {
          at: row.updatedAt,
          byName: row.updatedByUserId ? (names.get(row.updatedByUserId) ?? null) : null,
          onThisTill: history.length > 0 ? history[0]!.onThisTill : null,
        }
      : inUse.carriedOver && inUse.savedAt
        ? // Carried over: the v0.7.20 save of Costing → Targets & fees it came from.
          { at: inUse.savedAt, byName: inUse.savedByUserId ? (names.get(inUse.savedByUserId) ?? null) : null, onThisTill: null }
        : null,
    notOnOtherTillYet: unsent,
    history,
  };
}

/** Two setting values are the same whatever order their fields were written in. */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_key, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : val,
  );
}

function userNames(db: AppDatabase): Map<string, string> {
  const rows = db.prepare(`SELECT id, full_name FROM users`).all() as Array<{ id: string; full_name: string }>;
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
