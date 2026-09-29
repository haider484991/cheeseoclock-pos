/**
 * The website's shop block (shared-types web-bridge.ts, THE SHOP BLOCK): the
 * shop's details, opening hours, website words and home lineup, stamped with
 * the four keys' row versions and times. The SAME arithmetic as the settings
 * block (settingsStampOf, websiteNeedsSettings) under shop names — one rule
 * for "which block is newer", never a second one. Pure: the bridge reads the
 * rows; tests call these directly.
 */
import {
  compareShopStamp,
  type PublishedShop,
  type ShopHours,
  type ShopProfile,
  type ShopStamp,
  type ShopWebsite,
  type WebsiteHome,
} from '@cheeseoclock/shared-types';
import { settingsStampOf, websiteNeedsSettings, type SettingStamp } from './delivery-charge.js';

/**
 * The shop block's stamp from the four keys' rows (null = never saved): the
 * sum of their versions, the newest updated_at, the sum of the times — THE
 * STAMP of the settings block (settingsStampOf), named for the shop.
 */
export function shopStampOf(stamps: ReadonlyArray<SettingStamp | null>): { shopRev: number; shopAt: string; shopTie: number } {
  const s = settingsStampOf(stamps);
  return { shopRev: s.settingsRev, shopAt: s.settingsAt, shopTie: s.settingsTie };
}

/** A shop stamp as a settings stamp (the one comparison: compareSettingsStamp). */
function asSettingsStamp(s: ShopStamp): { settingsRev: number; settingsAt: string; settingsTie: number | null } {
  return { settingsRev: s.shopRev, settingsAt: s.shopAt, settingsTie: s.shopTie ?? null };
}

/**
 * Does the website need this till's shop block? (THE SHOP BLOCK, WHEN THE
 * TILL SENDS IT; websiteNeedsSettings' rule, with no fee-item problem.)
 * `held` = what the website said it holds, null when none or not said.
 *  - nothing saved on either till (rev 0): never;
 *  - no block there, or an older one: yes;
 *  - the same one: no;
 *  - this till's own, and a Save here since at a later time (a restore from
 *    an older backup moved this till's versions back): yes;
 *  - a newer one from the other till: no — the link brings it here.
 */
export function websiteNeedsShop(
  local: ShopStamp,
  held: { stamp: ShopStamp; deviceId: string | null } | null,
  deviceId: string,
): boolean {
  return websiteNeedsSettings(
    asSettingsStamp(local),
    held ? { stamp: asSettingsStamp(held.stamp), deviceId: held.deviceId, problem: null } : null,
    deviceId,
  );
}

/** Two shop stamps are the same (compareShopStamp 0). */
export function sameShopStamp(a: ShopStamp, b: ShopStamp): boolean {
  return compareShopStamp(a, b) === 0;
}

/**
 * The shop block for the menu publish and for the block alone: the four
 * keys' values WITHOUT their format `v`, every field (at its default too —
 * v1 always sends all four sections), as fresh copies in a fixed field
 * order, stamped (shopStampOf) and signed by the sending till. The caller
 * sends it only when the stamp's rev is 1 or more.
 */
export function buildShopBlock(input: {
  profile: ShopProfile;
  hours: ShopHours;
  website: ShopWebsite;
  home: WebsiteHome;
  stamps: ReadonlyArray<SettingStamp | null>;
  deviceId: string;
}): PublishedShop {
  const stamp = shopStampOf(input.stamps);
  const { profile: p, hours: h, website: w, home } = input;
  const entry = (e: WebsiteHome['pizzas'][number]) => ({
    itemRef: { posItemId: e.itemRef.posItemId, name: e.itemRef.name },
    ...(e.headline !== undefined ? { headline: e.headline } : {}),
    ...(e.text !== undefined ? { text: e.text } : {}),
  });
  return {
    v: 1,
    shopRev: stamp.shopRev,
    shopAt: stamp.shopAt,
    shopTie: stamp.shopTie,
    deviceId: input.deviceId,
    profile: {
      name: p.name,
      tagline: p.tagline,
      phone: { display: p.phone.display, e164: p.phone.e164 },
      whatsappLines: p.whatsappLines.map((l) => ({ display: l.display, e164: l.e164 })),
      address: { street: p.address.street, areaLine: p.address.areaLine, postalCode: p.address.postalCode },
      socialLinks: [...p.socialLinks],
      priceRange: p.priceRange,
    },
    hours: { opens: h.opens, closes: h.closes, days: [...h.days] },
    website: {
      whatsappGreeting: w.whatsappGreeting,
      doorPayments: [...w.doorPayments],
      pickupPayments: [...w.pickupPayments],
      allergyNotice: w.allergyNotice,
    },
    home: {
      pizzas: home.pizzas.map(entry),
      burger: home.burger ? entry(home.burger) : null,
      deals: home.deals.map(entry),
    },
  };
}
