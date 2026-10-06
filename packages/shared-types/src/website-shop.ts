/**
 * The shop's details the website shows, from Settings (owner, 29 Sep 2026:
 * "everything should be in settings") — sweep bundles B2 + B4. Four synced
 * business settings, owner-only, format 1, each with a FROZEN default that is
 * exactly what the website shows today (so nothing changes until the owner
 * edits a card):
 *
 *   'shop.profile'  the name, tagline, phone, WhatsApp lines, street address,
 *                   social links and price range (NAP: must match Google);
 *   'shop.hours'    the opening hours — DISPLAY ONLY: website ordering
 *                   follows the till's shift open and close, never these;
 *   'shop.website'  the WhatsApp greeting, what the rider and the counter
 *                   take (website WORDS only, never the till's Pay buttons),
 *                   the allergy notice;
 *   'website.home'  which items the home page features, and their home copy.
 *
 * They reach the website in ONE separately stamped block (PublishedShop,
 * shared-types web-bridge.ts: THE SHOP BLOCK). Everything here is pure and
 * shared by the till (its cards, the block) and the website (its pages): no
 * clock, no I/O. Bounds live in shared-schemas (web-settings.ts for the
 * block, business-settings.ts for the till's Save) — the constants are here.
 *
 * PUBLIC REPO: the defaults below are the shop's own public details exactly
 * as the website already printed them (apps/web lib/business.ts, which now
 * derives from these). Tests use made-up values.
 */

import { isDeliveryChargeMenuItem } from './delivery-areas.js';

// ---------------------------------------------------------------------------
// 'shop.profile'
// ---------------------------------------------------------------------------

/** A phone line: as printed ("0300 9367865") and dialled ("+923009367865"; normalizePhone(display) === e164). */
export interface ShopPhone {
  display: string;
  e164: string;
}

/**
 * The street address as the website shows it (the city stays Karachi, the
 * region Sindh, the country Pakistan — and the map pin, the Maps link and
 * the Google listing id stay in code: they are the listing's, not words).
 */
export interface ShopAddress {
  /** The full street address: the footer's address block, JSON-LD streetAddress, the pick-up line. */
  street: string;
  /** The short "area, city" line of the footer's © strip ("Rahat Commercial Area, DHA Phase 6, Karachi"). */
  areaLine: string;
  /** Five digits (footer and JSON-LD postalCode). */
  postalCode: string;
}

export interface ShopProfile {
  v: number;
  /**
   * The website's name for the shop: titles, JSON-LD, the share images, the
   * app manifest, the footer, the WhatsApp texts, and the till's own screens
   * before a receipt name is read. NOT the printed receipt (each till's
   * Receipt branding) and NOT the FBR invoice's name (FBR settings).
   */
  name: string;
  /** One line under the name ('' = none). */
  tagline: string;
  /** The call line (footer, JSON-LD telephone, the "call" buttons). */
  phone: ShopPhone;
  /** One to three WhatsApp lines; the FIRST is the "order on WhatsApp" link. */
  whatsappLines: ShopPhone[];
  address: ShopAddress;
  /** Live profiles only (Instagram, Facebook, foodpanda…): https, shown in the footer AND JSON-LD sameAs. [] = none (today). */
  socialLinks: string[];
  /** JSON-LD priceRange ("PKR 400–2,500"): must match the Google listing's price tier. */
  priceRange: string;
}

export const SHOP_NAME_MAX = 40;
export const SHOP_TAGLINE_MAX = 80;
export const SHOP_PHONE_DISPLAY_MAX = 20;
export const WHATSAPP_LINES_MAX = 3;
export const SHOP_STREET_MAX = 150;
export const SHOP_AREA_LINE_MAX = 80;
export const SOCIAL_LINKS_MAX = 6;
export const SOCIAL_LINK_MAX = 200;
export const PRICE_RANGE_MAX = 30;
/** The shop's own website: a "social link" to it is not a profile (and would point the listing at itself). */
export const SHOP_OWN_DOMAIN = 'cheeseoclock.net';

// ---------------------------------------------------------------------------
// 'shop.hours'
// ---------------------------------------------------------------------------

export const SHOP_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type ShopDay = (typeof SHOP_DAYS)[number];

/**
 * The opening hours the website SHOWS (footer, pages, JSON-LD, the share
 * images, the app manifest). Display only — ordering follows the shift
 * (owner, 28 Sep 2026: "website orders is connected with shift open close").
 * One opening and closing time for every open day (special and holiday
 * hours are the closed notice's job).
 */
export interface ShopHours {
  v: number;
  /** "HH:MM", 24 h, on a quarter hour, from TRADING_DAY_STARTS ("05:00") to "23:45". */
  opens: string;
  /**
   * "HH:MM" on a quarter hour: later than `opens` the same day, or after
   * midnight BEFORE "05:00" (the trading day's end) — "00:00" is midnight.
   * Never equal to `opens`.
   */
  closes: string;
  /** The days it opens: at least one, each once, Monday first. */
  days: ShopDay[];
}

/** The trading day starts at 05:00 Karachi time: a shop may open from then, and close up to just before it. */
export const TRADING_DAY_STARTS = '05:00';

// ---------------------------------------------------------------------------
// 'shop.website'
// ---------------------------------------------------------------------------

/** What the website may say is taken at the door or the counter (the rider hand-over's and Pay's own list). */
export const DOOR_PAYMENTS = ['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer'] as const;
export type DoorPayment = (typeof DOOR_PAYMENTS)[number];

export interface ShopWebsite {
  v: number;
  /**
   * The WhatsApp message every "order on WhatsApp" button starts with (the
   * site-wide one; the page-specific messages keep their words, with only
   * the name from 'shop.profile'). One line, no space at its start, ending
   * in ONE space (the customer types on after it).
   */
  whatsappGreeting: string;
  /**
   * What the rider takes, in the website's WORDS (the FAQ, the checkout,
   * JSON-LD paymentAccepted). Always includes 'cash' (v1): every "Cash on
   * delivery" line stays true. Never changes the till's Pay buttons, and a
   * web order is still 'cod'.
   */
  doorPayments: DoorPayment[];
  /** What the counter takes for a website pick-up, in the website's words. Always includes 'cash'. */
  pickupPayments: DoorPayment[];
  /** The allergy notice on the menu page and at checkout: never empty. */
  allergyNotice: string;
}

export const WHATSAPP_GREETING_MAX = 120;
export const ALLERGY_NOTICE_MIN = 40;
export const ALLERGY_NOTICE_MAX = 300;

// ---------------------------------------------------------------------------
// 'website.home'
// ---------------------------------------------------------------------------

/**
 * An item the home page features: the till's id (the owner's pick in the
 * Home page card; null in the defaults — the website code cannot know the
 * ids) and its name as the till has it ("Cheesy Star — Large"), which is
 * matched when the id is not on the published menu (a fresh-start import).
 */
export interface HomeItemRef {
  posItemId: string | null;
  name: string;
}

/**
 * One featured item. `headline` and `text` are the home page's own words for
 * it; absent (the default) = today's curated words for today's items, else
 * the item's own description from the till.
 *  - a pizza or the burger: `headline` = the short line under its name (the
 *    3D carousel), `text` = the card's description;
 *  - a deal: `text` = what is in it (the deal card's line); a deal takes no
 *    `headline` (the schema refuses one).
 */
export interface HomeEntry {
  itemRef: HomeItemRef;
  headline?: string;
  text?: string;
}

export interface WebsiteHome {
  v: number;
  /** The signature pizzas: the 3D carousel and the grid (1–8). */
  pizzas: HomeEntry[];
  /** The signature burger card (none = no burger card). */
  burger: HomeEntry | null;
  /** The value-deal cards (0–4). */
  deals: HomeEntry[];
}

export const HOME_PIZZAS_MIN = 1;
export const HOME_PIZZAS_MAX = 8;
export const HOME_DEALS_MAX = 4;
export const HOME_HEADLINE_MAX = 60;
export const HOME_TEXT_MAX = 240;
export const HOME_ITEM_NAME_MAX = 120;

// ---------------------------------------------------------------------------
// The frozen defaults: the website TODAY, byte for byte. NEVER edit one after
// release (two tills on different versions with a key unsaved would disagree;
// the website with no block stored shows these). Pinned by pos-domain
// shop-settings.test.ts.
// ---------------------------------------------------------------------------

const phone = (display: string, e164: string): ShopPhone => Object.freeze({ display, e164 });

/** Today's name, tagline, numbers, address, social profiles and price range (apps/web lib/business.ts before B4). */
export const DEFAULT_SHOP_PROFILE: Readonly<ShopProfile> = Object.freeze({
  v: 1,
  name: "Cheese O'Clock",
  // The printed menu's line (owner, 25 Sep 2026: "Hygienically", not "Cleanly").
  tagline: 'Hygienically Made. Deliciously Unforgettable.',
  // Matches the Google Business Profile listing (verified 27 Jul 2026).
  phone: phone('0300 9367865', '+923009367865'),
  // Both shop numbers take WhatsApp orders; the first is the default deep link.
  whatsappLines: Object.freeze([phone('0300 9367865', '+923009367865'), phone('0331 2188295', '+923312188295')]) as ShopPhone[],
  // The owner's corrected address (25 Sep 2026).
  address: Object.freeze({
    street: 'Shop 3, Ground Floor, 41-C, Sehar Lane No. 3, Rahat Commercial Area, DHA Phase 6',
    areaLine: 'Rahat Commercial Area, DHA Phase 6, Karachi',
    postalCode: '75500',
  }) as ShopAddress,
  // The shop's own profiles (owner, 5 Oct 2026: "add social media"; the poster and the posts print them):
  // the footer links them and JSON-LD names them (sameAs). Not the look-alike cheeseoclock.pk accounts.
  socialLinks: Object.freeze(['https://www.instagram.com/cheeseoclock_/', 'https://www.facebook.com/cheeseoclock.karachi']) as string[],
  priceRange: 'PKR 400–2,500',
}) as Readonly<ShopProfile>;

/**
 * Every day, 1 pm to 1 am (owner, 5 Oct 2026: "update the website timing to 1 to 1 am"; it was 12 noon to 1 am
 * from 25 Sep). Only the website's and the till's fallback: the hours the owner saves in the till
 * (Settings → Shop & logo → "Website: shop details") are published with the menu and win over this.
 */
export const DEFAULT_SHOP_HOURS: Readonly<ShopHours> = Object.freeze({
  v: 1,
  opens: '13:00',
  closes: '01:00',
  days: Object.freeze([...SHOP_DAYS]) as ShopDay[],
}) as Readonly<ShopHours>;

/** Today's greeting (with its trailing space), cash at the door and at the counter, and the printed menu's allergy words. */
export const DEFAULT_SHOP_WEBSITE: Readonly<ShopWebsite> = Object.freeze({
  v: 1,
  whatsappGreeting: "Hi Cheese O'Clock! I'd like to place an order: ",
  doorPayments: Object.freeze(['cash']) as DoorPayment[],
  pickupPayments: Object.freeze(['cash']) as DoorPayment[],
  // The printed menu's allergy words (owner 2026-09-26), word for word as v0.7.30's website printed
  // them (its apps/web lib/menu-view.ts ALLERGY_NOTICE, now gone: /menu and the checkout print this).
  allergyNotice:
    'Allergy? Tell us in the item’s “Allergy or special request” box and we’ll leave ingredients out. Our kitchen shares equipment, so we can’t guarantee any dish is allergen-free.',
}) as Readonly<ShopWebsite>;

const featured = (name: string): HomeEntry => Object.freeze({ itemRef: Object.freeze({ posItemId: null, name }) });

/**
 * Today's home page: the five signature pizzas (Large), the Signature Cheese
 * Dipped burger and the three value deals, each with today's curated words
 * (no headline or text of its own).
 */
export const DEFAULT_WEBSITE_HOME: Readonly<WebsiteHome> = Object.freeze({
  v: 1,
  pizzas: Object.freeze([
    featured('Cheesy Star — Large'),
    featured('Crown Crust — Large'),
    featured('Shawarma Pizza — Large'),
    featured('Meat Lovers — Large'),
    featured('Cheetos — Large'),
  ]) as HomeEntry[],
  burger: featured('Signature Cheese Dipped'),
  deals: Object.freeze([featured('Big Two'), featured('Family Feast'), featured('Perfect Pair')]) as HomeEntry[],
}) as Readonly<WebsiteHome>;

// ---------------------------------------------------------------------------
// Hours in words (the website's pages; the till's preview)
// ---------------------------------------------------------------------------

/** "HH:MM", 24 h, on a quarter hour. */
export const QUARTER_HOUR_RE = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;

/**
 * A clock time in the website's words: "12:00" → "12 noon", "00:00" →
 * "midnight", "01:00" → "1 am", "13:30" → "1:30 pm", "23:00" → "11 pm".
 */
export function timeWords(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  if (h === 12 && m === 0) return '12 noon';
  if (h === 0 && m === 0) return 'midnight';
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "12 noon – 1 am" (an en dash between spaces, as the website prints it). */
export function hoursRange(h: Pick<ShopHours, 'opens' | 'closes'>): string {
  return `${timeWords(h.opens)} – ${timeWords(h.closes)}`;
}

/** Open all seven days. */
export function everyDay(h: Pick<ShopHours, 'days'>): boolean {
  return SHOP_DAYS.every((d) => h.days.includes(d));
}

/** Closes after midnight (00:15–04:45): the late-night page's premise. Closing AT midnight is not after it. */
export function closesAfterMidnight(h: Pick<ShopHours, 'closes'>): boolean {
  return h.closes > '00:00' && h.closes < TRADING_DAY_STARTS;
}

/** Opens at or before `hhmm` ("Yes — lunch and dinner, from 12 noon" needs it open by lunch). */
export function opensBy(h: Pick<ShopHours, 'opens'>, hhmm: string): boolean {
  return h.opens <= hhmm;
}

const DAY_SHORT: Readonly<Record<ShopDay, string>> = Object.freeze({
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
});

/** The full English names JSON-LD's dayOfWeek takes, Monday first. */
export const SCHEMA_ORG_DAY: Readonly<Record<ShopDay, string>> = Object.freeze({
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
});

/** JSON-LD dayOfWeek for these days, Monday first ("Monday" … "Sunday" for every day: today's). */
export function schemaOrgDays(days: readonly ShopDay[]): string[] {
  return SHOP_DAYS.filter((d) => days.includes(d)).map((d) => SCHEMA_ORG_DAY[d]);
}

/**
 * The open days in words: "daily" for all seven; otherwise runs of three or
 * more as "Mon–Fri", the rest listed: "Mon–Fri, Sun", "Tue, Thu".
 */
export function daysWords(days: readonly ShopDay[]): string {
  const on = SHOP_DAYS.map((d) => days.includes(d));
  if (on.every(Boolean)) return 'daily';
  const parts: string[] = [];
  let i = 0;
  while (i < SHOP_DAYS.length) {
    if (!on[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < SHOP_DAYS.length && on[j + 1]) j += 1;
    const run = SHOP_DAYS.slice(i, j + 1).map((d) => DAY_SHORT[d]);
    if (run.length >= 3) parts.push(`${run[0]!}–${run[run.length - 1]!}`);
    else parts.push(...run);
    i = j + 1;
  }
  return parts.join(', ');
}

/** The footer's and the pages' line: "Open daily · 12 noon – 1 am" (today's), "Open Mon–Sat · 11 am – 11 pm". */
export function hoursLine(h: Pick<ShopHours, 'opens' | 'closes' | 'days'>): string {
  return `Open ${daysWords(h.days)} · ${hoursRange(h)}`;
}

/**
 * Why these hours can't be saved, in the owner's words — or null. THE rule
 * (the till's card, the till's Save and the website's check all call it):
 * quarter hours; opens from 05:00 to 23:45; closes later the same day, or
 * after midnight before 05:00; never equal; at least one day, each once,
 * Monday first.
 */
export function shopHoursProblem(h: Pick<ShopHours, 'opens' | 'closes' | 'days'>): string | null {
  if (!QUARTER_HOUR_RE.test(h.opens)) return 'The opening time is on a quarter hour (like 12:00 or 11:30)';
  if (!QUARTER_HOUR_RE.test(h.closes)) return 'The closing time is on a quarter hour (like 01:00 or 23:45)';
  if (h.opens < TRADING_DAY_STARTS) return 'The shop opens from 5 am (the trading day starts at 5 am)';
  if (h.closes === h.opens) return 'The closing time can’t be the opening time';
  if (!(h.closes > h.opens || h.closes < TRADING_DAY_STARTS)) {
    return 'After midnight the shop closes before 5 am (the trading day starts at 5 am)';
  }
  if (h.days.length === 0) return 'Pick at least one day the shop opens';
  const seen = new Set<string>();
  let last = -1;
  for (const d of h.days) {
    const at = (SHOP_DAYS as readonly string[]).indexOf(d);
    if (at < 0) return 'That is not a day of the week';
    if (seen.has(d)) return 'Each day once';
    if (at < last) return 'The days go Monday first';
    seen.add(d);
    last = at;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payments in words
// ---------------------------------------------------------------------------

/** Each way of paying as the website names it. */
export const DOOR_PAYMENT_LABEL: Readonly<Record<DoorPayment, string>> = Object.freeze({
  cash: 'Cash',
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank transfer',
});

/** Only cash is taken ('shop.website' at today's default): the "cash only" sentences stay true. */
export function cashOnly(payments: readonly DoorPayment[]): boolean {
  return payments.length === 1 && payments[0] === 'cash';
}

/** The list in the canonical order (cash, card, EasyPaisa, JazzCash, bank transfer), each once. */
export function canonicalPayments(payments: readonly DoorPayment[]): DoorPayment[] {
  return DOOR_PAYMENTS.filter((p) => payments.includes(p));
}

/**
 * JSON-LD paymentAccepted: ['cash'] → "Cash on Delivery" EXACTLY (today's);
 * more → "Cash on Delivery, Card, EasyPaisa, JazzCash, Bank transfer".
 */
export function paymentAccepted(doorPayments: readonly DoorPayment[]): string {
  const others = canonicalPayments(doorPayments).filter((p) => p !== 'cash');
  return ['Cash on Delivery', ...others.map((p) => DOOR_PAYMENT_LABEL[p])].join(', ');
}

/**
 * In a sentence, lower-case but for the names: "cash", "cash or card",
 * "cash, card or EasyPaisa".
 */
export function paymentsWords(payments: readonly DoorPayment[]): string {
  const words = canonicalPayments(payments).map((p) =>
    p === 'easypaisa' || p === 'jazzcash' ? DOOR_PAYMENT_LABEL[p] : DOOR_PAYMENT_LABEL[p].toLowerCase(),
  );
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]!}`;
}

// ---------------------------------------------------------------------------
// Names, numbers, links
// ---------------------------------------------------------------------------

/** The name in running text, with a curly apostrophe: "Cheese O'Clock" → "Cheese O’Clock". */
export function nameInProse(name: string): string {
  return name.replace(/'/g, '’');
}

/** The wa.me link of a line: "+923009367865" → "https://wa.me/923009367865". */
export function waUrl(e164: string): string {
  return `https://wa.me/${e164.replace(/^\+/, '')}`;
}

/** A wa.me link with a message: `${waUrl(e164)}?text=${encodeURIComponent(message)}` (encoded ONCE). */
export function waLinkWith(e164: string, message: string): string {
  return `${waUrl(e164)}?text=${encodeURIComponent(message)}`;
}

/** The tel: link of a line: "tel:+923009367865". */
export function telUrl(e164: string): string {
  return `tel:${e164}`;
}

/** A link's host, lower-case, without "www." (null when it is not a URL). */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

const SOCIAL_HOSTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)foodpanda\.pk$/, 'foodpanda'],
  [/(^|\.)(x\.com|twitter\.com)$/, 'X'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)(google\.com|goo\.gl|g\.page)$/, 'Google'],
];

/** The footer's label for a profile link, from its host: Instagram, Facebook, TikTok, YouTube, foodpanda, X… else the host. */
export function socialLabel(url: string): string {
  const host = hostOf(url) ?? url;
  for (const [re, label] of SOCIAL_HOSTS) if (re.test(host)) return label;
  return host;
}

/**
 * Why this is not a profile link the website can show, or null: https, at
 * most SOCIAL_LINK_MAX letters, no spaces, a real host, not the shop's own
 * website.
 */
export function socialLinkProblem(url: string): string | null {
  if (url.length > SOCIAL_LINK_MAX) return `Keep a link to ${SOCIAL_LINK_MAX} letters`;
  if (/\s/.test(url)) return 'A link has no spaces';
  if (!/^https:\/\//i.test(url)) return 'A link starts with https://';
  const host = hostOf(url);
  if (!host || !host.includes('.')) return 'That is not a web address';
  if (host === SHOP_OWN_DOMAIN || host.endsWith(`.${SHOP_OWN_DOMAIN}`)) return 'That is the shop’s own website, not a profile';
  return null;
}

/** Two links are the same profile (case of the host, a trailing slash). */
export function sameSocialLink(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// The home page's lineup: which published item each entry is. ONE matcher —
// the website's home page and the till's Home page card both call it.
// ---------------------------------------------------------------------------

/** " — " or " – " between an item's name and its size ("Cheesy Star — Large"), as the website splits it. */
const SIZE_SEPARATOR = /\s+[—–]\s+/;

/**
 * The key two names match on: the base and the size after the last " — ",
 * case- and space-folded, with ’ and ' the same. "Cheesy Star — Large",
 * "cheesy  star — LARGE" and "Cheesy Star – Large" are one item.
 */
export function homeNameKey(name: string): string {
  const fold = (s: string) => s.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const parts = name.split(SIZE_SEPARATOR);
  if (parts.length < 2) return `${fold(name)}\u0000`;
  const size = parts.pop()!;
  return `${fold(parts.join(' — '))}\u0000${fold(size)}`;
}

/** What the matcher needs of a published (or to-be-published) item. */
export interface HomeMenuItem {
  posItemId: string;
  name: string;
  basePriceCents: number;
  sortOrder: number;
}

/** What the matcher needs of a menu: its categories (any order; matched in display order). */
export interface HomeMenu<I extends HomeMenuItem = HomeMenuItem> {
  categories: ReadonlyArray<{ displayOrder: number; items: readonly I[] }>;
}

/** The menu's items in its order (categories by displayOrder, items by sortOrder; ties keep the given order), delivery charges left out. */
function itemsInOrder<I extends HomeMenuItem>(menu: HomeMenu<I>, feeItemIds: ReadonlySet<string> | null | undefined): I[] {
  const cats = menu.categories.map((c, i) => ({ c, i })).sort((a, b) => a.c.displayOrder - b.c.displayOrder || a.i - b.i);
  const out: I[] = [];
  for (const { c } of cats) {
    const items = c.items.map((it, i) => ({ it, i })).sort((a, b) => a.it.sortOrder - b.it.sortOrder || a.i - b.i);
    for (const { it } of items) {
      if (isDeliveryChargeMenuItem({ id: it.posItemId, name: it.name }, feeItemIds)) continue;
      out.push(it);
    }
  }
  return out;
}

/**
 * The item a featured entry is on this menu, or null (then the website HIDES
 * its card, slide or deal — never "Rs 0"):
 *  1. the item with its posItemId, when there is one — priced at 0 or less
 *     it counts as missing;
 *  2. else the FIRST item in menu order (categories by displayOrder, items
 *     by sortOrder) priced above 0 whose name matches (homeNameKey).
 * Delivery charges are never matched (an area's feeItemId, or a name like
 * "Delivery Charge (Rs 200)"). Only published items can match: an item off
 * the website is not on the menu, so it is missing like a removed one.
 */
export function matchHomeItem<I extends HomeMenuItem>(
  ref: HomeItemRef,
  menu: HomeMenu<I>,
  feeItemIds?: ReadonlySet<string> | null,
): I | null {
  const items = itemsInOrder(menu, feeItemIds);
  if (ref.posItemId) {
    const byId = items.find((i) => i.posItemId === ref.posItemId);
    if (byId) return byId.basePriceCents > 0 ? byId : null;
  }
  const key = homeNameKey(ref.name);
  return items.find((i) => i.basePriceCents > 0 && homeNameKey(i.name) === key) ?? null;
}

export interface HomeLineupEntry<I extends HomeMenuItem> {
  entry: HomeEntry;
  /** The published item, or null: missing (hidden). */
  item: I | null;
}

export interface HomeLineup<I extends HomeMenuItem> {
  pizzas: Array<HomeLineupEntry<I>>;
  burger: HomeLineupEntry<I> | null;
  deals: Array<HomeLineupEntry<I>>;
}

/** Every entry of the lineup with its item on this menu (matchHomeItem), in the lineup's order. */
export function homeLineup<I extends HomeMenuItem>(
  home: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>,
  menu: HomeMenu<I>,
  feeItemIds?: ReadonlySet<string> | null,
): HomeLineup<I> {
  const one = (entry: HomeEntry): HomeLineupEntry<I> => ({ entry, item: matchHomeItem(entry.itemRef, menu, feeItemIds) });
  return {
    pizzas: home.pizzas.map(one),
    burger: home.burger ? one(home.burger) : null,
    deals: home.deals.map(one),
  };
}

/**
 * The featured items this menu lacks (PublishMenuResult.homeMissing): each
 * missing entry's itemRef.name — the pizzas, then the burger, then the deals,
 * in the lineup's order. [] when every one is found.
 */
export function homeMissing(
  home: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>,
  menu: HomeMenu,
  feeItemIds?: ReadonlySet<string> | null,
): string[] {
  const l = homeLineup(home, menu, feeItemIds);
  return [...l.pizzas, ...(l.burger ? [l.burger] : []), ...l.deals].filter((e) => e.item === null).map((e) => e.entry.itemRef.name);
}

/**
 * Why a lineup can't be saved as it is, or null: two entries that are the
 * same item (the same posItemId, or the same name when there is no id to
 * tell them apart).
 */
export function homeDuplicateProblem(home: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>): string | null {
  const all = [...home.pizzas, ...(home.burger ? [home.burger] : []), ...home.deals];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const e of all) {
    const id = e.itemRef.posItemId;
    if (id) {
      if (ids.has(id)) return `“${e.itemRef.name}” is on the home page twice`;
      ids.add(id);
    }
    const key = homeNameKey(e.itemRef.name);
    if (names.has(key)) return `“${e.itemRef.name}” is on the home page twice`;
    names.add(key);
  }
  return null;
}
