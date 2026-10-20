/**
 * The country this till runs as (international edition, Phase 1a).
 *
 * The choice is a business setting, 'shop.locale', written once by first-time
 * setup on a Pixel & Oak till and shared with the second till like every
 * other shop setting. This file turns it into the process's locale — money,
 * paper, notes, tenders — at start, after setup writes it, and when the other
 * till's copy arrives.
 *
 * Cheese O'Clock's tills never store it, so they read as Pakistan, which is
 * DEFAULT_SHOP_LOCALE itself: their money, paper and screens are exactly what
 * they were (the oracle and the 80 golden papers hold that).
 */
import {
  DEFAULT_STORED_SHOP_LOCALE,
  resolveShopLocale,
  setShopLocale,
  type ShopLocale,
  type StoredShopLocale,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { getBusinessSetting } from '../db/business-settings-read.js';

/** What this till has stored as its country; Pakistan when nothing readable is. */
export function readStoredShopLocale(db: AppDatabase): StoredShopLocale {
  return getBusinessSetting(db, 'shop.locale')?.value ?? DEFAULT_STORED_SHOP_LOCALE;
}

/**
 * Make this process run as the shop's locale, and give it back. Never throws:
 * a till that cannot read its setting runs as Pakistan, which is what every
 * till was before the setting existed.
 */
export function applyShopLocale(db: AppDatabase): ShopLocale {
  let locale: ShopLocale;
  try {
    locale = resolveShopLocale(readStoredShopLocale(db));
  } catch {
    locale = resolveShopLocale(null);
  }
  setShopLocale(locale);
  return locale;
}

/**
 * The country is fixed once the till has taken an order, voided or not: every
 * stored amount, paper and report since is in that currency, and changing it
 * would re-label history rather than convert it.
 */
export function shopLocaleLocked(db: AppDatabase): boolean {
  return db.prepare(`SELECT 1 FROM orders LIMIT 1`).get() !== undefined;
}
