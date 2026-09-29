/**
 * The shop block of the menu publish (shared-types web-bridge.ts, THE SHOP
 * BLOCK): the shop's details, opening hours, website words and home lineup
 * ('shop.profile', 'shop.hours', 'shop.website', 'website.home'), stamped
 * with the four keys' row versions and times — the settings block's own
 * arithmetic under shop names (pos-domain shopStampOf). Separate from the
 * settings block: a fee-item problem there never holds these back, nor the
 * other way round. Read-only and free of Electron: the bridge builds it;
 * tests call it directly.
 */
import { SHOP_PUBLISHED_KEYS, type PublishedShop, type ShopStamp } from '@cheeseoclock/shared-types';
import { publishedShopSchema } from '@cheeseoclock/shared-schemas';
import { buildShopBlock, shopStampOf, type SettingStamp } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import {
  getBusinessSetting,
  readBusinessSettingRow,
  readShopHours,
  readShopProfile,
  readShopWebsite,
  readWebsiteHome,
} from '../db/business-settings-read.js';

/** The four keys' rows as they are on this till (null = never saved). */
function shopStamps(db: AppDatabase): Array<SettingStamp | null> {
  return SHOP_PUBLISHED_KEYS.map((key) => {
    const row = readBusinessSettingRow(db, key);
    return row ? { version: row.version, updatedAt: row.updatedAt } : null;
  });
}

/** Each key in the owner's words (a problem names the card). */
const SHOP_KEY_WORDS: Readonly<Record<(typeof SHOP_PUBLISHED_KEYS)[number], string>> = {
  'shop.profile': 'The shop details were',
  'shop.hours': 'The opening hours were',
  'shop.website': 'The website’s words and payments were',
  'website.home': 'The home page lineup was',
};

/**
 * Why this till can't speak for the shop block, or null: one of the four
 * keys saved by a NEWER version of the app (or one this version can't read).
 * Its version counts in the stamp, but this till would send its default in
 * its place — and the website takes an equal stamp — so no shop block goes
 * from here until this till is updated (the updated till sends it).
 */
export function shopKeyProblem(db: AppDatabase): string | null {
  for (const key of SHOP_PUBLISHED_KEYS) {
    if (!readBusinessSettingRow(db, key)) continue;
    const saved = getBusinessSetting(db, key);
    if (!saved || saved.newerFormat) {
      return `${SHOP_KEY_WORDS[key]} saved by a newer version of the app — update this till (the website keeps what it has).`;
    }
  }
  return null;
}

/**
 * This till's shop stamp (pos-domain shopStampOf). Rev 0 = none of the four
 * keys is saved on either till — the website then goes on exactly as before
 * (no shop block is ever sent).
 */
export function localShopStamp(db: AppDatabase): ShopStamp & { shopTie: number } {
  return shopStampOf(shopStamps(db));
}

/**
 * The shop block to send, or why none goes:
 *  - nothing saved (rev 0): no block, no problem — the website stays as today;
 *  - a key this till can't speak for (shopKeyProblem): no block;
 *  - the block fails the website's own schema (it should not: every Save
 *    passes the same bounds): no block, and the reason in the owner's words.
 * Every section always goes, at its default too (v1: the website stores the
 * block whole).
 */
export function shopBlockFor(
  db: AppDatabase,
  deviceId: string,
): { block: PublishedShop | null; problem: string | null; stamp: ShopStamp & { shopTie: number } } {
  const stamps = shopStamps(db);
  const stamp = shopStampOf(stamps);
  if (stamp.shopRev === 0) return { block: null, problem: null, stamp };
  const unreadable = shopKeyProblem(db);
  if (unreadable) return { block: null, problem: unreadable, stamp };
  const block = buildShopBlock({
    profile: readShopProfile(db),
    hours: readShopHours(db),
    website: readShopWebsite(db),
    home: readWebsiteHome(db),
    stamps,
    deviceId,
  });
  const checked = publishedShopSchema.safeParse(block);
  if (!checked.success) {
    return { block: null, problem: `The website would refuse the shop details: ${checked.error.issues[0]?.message ?? 'they do not fit'}.`, stamp };
  }
  return { block, problem: null, stamp };
}
