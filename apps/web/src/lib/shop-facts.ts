import {
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  hoursLine,
  nameInProse,
  telUrl,
  waLinkWith,
  waUrl,
  type PublishedShop,
  type PublishedShopHours,
  type PublishedShopProfile,
  type PublishedShopWebsite,
  type PublishedWebsiteHome,
} from '@cheeseoclock/shared-types';

/**
 * The shop's details as the website shows them (sweep B2 + B4): the owner's
 * shop block from the till (Settings → Shop & logo → "Website: shop details
 * (both tills)", stored with the menu — shared-types web-bridge.ts, THE SHOP
 * BLOCK) or, with none stored, today's details exactly (the frozen
 * DEFAULT_SHOP_* of shared-types website-shop.ts): every page reads as
 * before until the owner edits a card.
 *
 * Pure, and safe in the browser: the /menu page and the tracking page hand
 * these facts to their client components. Never the block's stamps or its
 * device id. The database read is lib/site-facts.ts (getShopFacts); the
 * words in page copy are delivery-facts' tokens and claims ({hours},
 * {closes}, {name}, { cashOnly: true } …).
 *
 * What stays in code (not shop words): the city, region and country, the
 * map pin, the Google Maps link and listing id (lib/business.ts), the logo,
 * and the prose that names the kitchen's street by hand ("Rahat
 * Commercial", "our Phase 6 kitchen") — the till's address card says so.
 */
export interface ShopFacts {
  /** 'settings' = the owner's block from the till; 'default' = today's details (none stored, or the database unreadable). */
  source: 'settings' | 'default';
  /** The name, tagline, phone, WhatsApp lines, street address, social links and price range. */
  profile: PublishedShopProfile;
  /** The opening hours — display only: ordering follows the till's shift, never these. */
  hours: PublishedShopHours;
  /** The WhatsApp greeting, what the rider and the counter take (words only), the allergy notice. */
  website: PublishedShopWebsite;
  /** The home page's featured items and their home words. */
  home: PublishedWebsiteHome;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** A default section without its format `v`, as a fresh copy. */
function sectionOf<T extends { v: number }>(d: Readonly<T>): Omit<T, 'v'> {
  const { v: _v, ...rest } = JSON.parse(JSON.stringify(d)) as T;
  return rest;
}

/** Today's details: every page exactly as before the shop block (frozen). */
export const DEFAULT_SHOP_FACTS: ShopFacts = deepFreeze({
  source: 'default',
  profile: sectionOf(DEFAULT_SHOP_PROFILE),
  hours: sectionOf(DEFAULT_SHOP_HOURS),
  website: sectionOf(DEFAULT_SHOP_WEBSITE),
  home: sectionOf(DEFAULT_WEBSITE_HOME),
});

/** The facts for a stored block (null → DEFAULT_SHOP_FACTS): its four sections, never its stamps or device id. */
export function shopFactsFromBlock(block: PublishedShop | null | undefined): ShopFacts {
  if (!block) return DEFAULT_SHOP_FACTS;
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    source: 'settings',
    profile: copy(block.profile),
    hours: copy(block.hours),
    website: copy(block.website),
    home: copy(block.home),
  };
}

// ---------------------------------------------------------------------------
// The details in the pages' words
// ---------------------------------------------------------------------------

/** A WhatsApp line as the pages link it. */
export interface ShopLine {
  /** As printed: "0300 9367865". */
  display: string;
  /** As dialled: "+923009367865". */
  e164: string;
  /** Its wa.me link: "https://wa.me/923009367865". */
  url: string;
}

/** The WhatsApp lines, the order link's first. */
export function whatsappLinesOf(shop: ShopFacts): ShopLine[] {
  return shop.profile.whatsappLines.map((l) => ({ display: l.display, e164: l.e164, url: waUrl(l.e164) }));
}

/** The first WhatsApp line: the "order on WhatsApp" link's number. */
export function orderLine(shop: ShopFacts): ShopLine {
  // The block always has one (1–3 lines); today's first line is the fallback.
  return whatsappLinesOf(shop)[0] ?? whatsappLinesOf(DEFAULT_SHOP_FACTS)[0]!;
}

/** "0300 9367865 or 0331 2188295": the WhatsApp numbers in a sentence. */
export function whatsappNumbersText(shop: ShopFacts): string {
  return shop.profile.whatsappLines.map((l) => l.display).join(' or ');
}

/** The "order on WhatsApp" link: the first line, with the owner's greeting (encoded once). */
export function orderWhatsappUrl(shop: ShopFacts): string {
  return waLinkWith(orderLine(shop).e164, shop.website.whatsappGreeting);
}

/** A WhatsApp link to the first line with a page's own message. */
export function whatsappUrlWith(shop: ShopFacts, message: string): string {
  return waLinkWith(orderLine(shop).e164, message);
}

/** A WhatsApp link to this line with the owner's greeting. */
export function lineOrderUrl(shop: ShopFacts, line: Pick<ShopLine, 'e164'>): string {
  return waLinkWith(line.e164, shop.website.whatsappGreeting);
}

/** "Hi Cheese O'Clock!" — how every page-specific WhatsApp message starts (its own words follow). */
export function whatsappHello(shop: ShopFacts): string {
  return `Hi ${shop.profile.name}!`;
}

/** The call line's tel: link. */
export function shopTelUrl(shop: ShopFacts): string {
  return telUrl(shop.profile.phone.e164);
}

/** The name in running text (curly apostrophe): "Cheese O’Clock". */
export function shopNameProse(shop: ShopFacts): string {
  return nameInProse(shop.profile.name);
}

/** The name is today's: the lines built on its pun ("It’s always Cheese O’Clock") may print. */
export function nameIsDefault(shop: ShopFacts): boolean {
  return shop.profile.name === DEFAULT_SHOP_PROFILE.name;
}

/** "Open daily · 12 noon – 1 am". */
export function shopHoursLine(shop: ShopFacts): string {
  return hoursLine(shop.hours);
}
