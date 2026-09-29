/**
 * Settings → Shop & logo → "Website: shop details (both tills)" (sweep B2 +
 * B4; shared-types website-shop.ts): what is typed ↔ the four keys'
 * values, and the words. The website gets them in the shop block (THE SHOP
 * BLOCK, web-bridge.ts) a few seconds after a Save.
 *
 * Two keys hold more than one card: 'shop.profile' (Shop details; WhatsApp
 * numbers & social links) and 'shop.website' (Payments at the door; WhatsApp
 * greeting; Allergy notice). Each card saves the WHOLE value — its own
 * fields from the form, every other field exactly as saved, in this
 * version's format — and its "Put back the default" puts back ITS fields
 * only (cardPart, B1's part helpers made general). The main process checks
 * every value again with the key's schema; this says what is wrong before
 * Save in the same words (the same schema runs here).
 */
import { shopHoursSchema, shopProfileSchema, shopWebsiteSchema, websiteHomeSchema } from '@cheeseoclock/shared-schemas';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  DOOR_PAYMENTS,
  DOOR_PAYMENT_LABEL,
  SHOP_DAYS,
  SHOP_SETTING_DEFAULTS,
  SHOP_SETTING_FORMAT,
  TRADING_DAY_STARTS,
  canonicalPayments,
  cashOnly,
  closesAfterMidnight,
  everyDay,
  homeLineup,
  hoursLine,
  isDeliveryChargeMenuItem,
  normalizePhone,
  opensBy,
  paymentAccepted,
  paymentsWords,
  socialLabel,
  timeWords,
  waLinkWith,
  type Category,
  type DoorPayment,
  type HomeEntry,
  type MenuItem,
  type ShopDay,
  type ShopHours,
  type ShopProfile,
  type ShopSettingCard,
  type ShopSettingKey,
  type ShopSettingValues,
  type ShopWebsite,
  type WebsiteHome,
} from '@cheeseoclock/shared-types';
import type { Parsed } from './foodpandaForm';
import { andList } from './foodpandaWords';
import { goesToWebsite, itemWebsiteState } from './publishWords';

// ---------------------------------------------------------------------------
// One card's part of a key (B1's onlineOptionsPart, for any key and fields)
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The fields each card of the website's shop details owns. */
export const SHOP_CARD_FIELDS = {
  details: ['name', 'tagline', 'phone', 'address', 'priceRange'],
  contact: ['whatsappLines', 'socialLinks'],
  payments: ['doorPayments', 'pickupPayments'],
  greeting: ['whatsappGreeting'],
  allergy: ['allergyNotice'],
} as const satisfies {
  details: ReadonlyArray<keyof ShopProfile>;
  contact: ReadonlyArray<keyof ShopProfile>;
  payments: ReadonlyArray<keyof ShopWebsite>;
  greeting: ReadonlyArray<keyof ShopWebsite>;
  allergy: ReadonlyArray<keyof ShopWebsite>;
};

/** The whole value in this version's format: `current`, with `fields` taken from `from`. */
export function withFields<K extends ShopSettingKey>(
  key: K,
  current: ShopSettingValues[K],
  from: Partial<ShopSettingValues[K]>,
  fields: ReadonlyArray<keyof ShopSettingValues[K]>,
): ShopSettingValues[K] {
  const out = { ...clone(current), v: SHOP_SETTING_FORMAT[key] } as ShopSettingValues[K];
  for (const f of fields) if (from[f] !== undefined) out[f] = clone(from[f]) as ShopSettingValues[K][typeof f];
  return out;
}

/** The same fields in two values (what one card shows). */
export function sameFields<V>(a: V, b: V, fields: ReadonlyArray<keyof V>): boolean {
  return fields.every((f) => JSON.stringify(a[f]) === JSON.stringify(b[f]));
}

/**
 * The card as ONE part of a key shows it: its own "Default" badge, a "Put
 * back the default" that writes only its fields (the rest kept as saved),
 * and its own History and "last changed" — the saves that changed ITS
 * fields; the oldest weighed against the default. A line this version
 * can't read is kept (it may have changed them). Whether the other till has
 * the key yet stays the key's.
 */
export function cardPart<K extends ShopSettingKey>(
  card: ShopSettingCard<K>,
  fields: ReadonlyArray<keyof ShopSettingValues[K]>,
): ShopSettingCard<K> {
  const defaults = SHOP_SETTING_DEFAULTS[card.key] as ShopSettingValues[K];
  const history = card.history.filter((h, i) => {
    if (!h.value) return true;
    const before = i + 1 < card.history.length ? card.history[i + 1]!.value : defaults;
    return !before || !sameFields(h.value, before, fields);
  });
  const last = history[0];
  const isDefault = !card.readOnly && sameFields(card.value, defaults, fields);
  return {
    ...card,
    isDefault,
    defaultValue: withFields(card.key, card.value, defaults, fields),
    history,
    lastChanged: last ? { at: last.at, byName: last.byName, onThisTill: last.onThisTill } : isDefault ? null : card.lastChanged,
  };
}

/** A value through the key's write schema: the value, or the schema's first message. */
function checked<V>(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }, value: V, what: string): Parsed<V> {
  const r = schema.safeParse(value);
  if (r.success) return { value, problem: null };
  return { value: null, problem: r.error?.issues[0]?.message ?? `Check ${what}.` };
}

// ---------------------------------------------------------------------------
// The words every card shares
// ---------------------------------------------------------------------------

export const WEBSITE_SHOP_WORDS = {
  group:
    'What the website shows about the shop. Saved here, it is on both tills and reaches the website by itself a few seconds later — never menu changes you have not published. Nothing here changes receipts or the till’s Pay buttons.',
  google:
    'Change your Google listing the same day, to the same words: Google checks that the website and the listing agree.',
  name:
    'The website’s name for the shop: page titles, search results, the footer, the share pictures and WhatsApp messages. Not the printed receipt (Receipt: shop details, above, each till its own) and not the FBR invoice (Settings → FBR).',
  nameRebrand:
    'The logo, the website address and the printed menu don’t change by themselves. Lines built on today’s name (like “It’s always Cheese O’Clock”) switch to plain words.',
  address:
    'The map pin, the Maps link and the Google listing stay as they are, and so do a few sentences that name the area (“our DHA Phase 6 kitchen”, “Rahat Commercial”) — ask whoever looks after the website to change those.',
  priceRange: 'For search engines (it is not shown on the pages). It should match the price range on your Google listing.',
  hours:
    'Display only: website orders still open and close with the shift. The website shows these hours in its footer, its pages and what it tells search engines.',
  payments:
    'Website words only: what the website says the rider and the counter take. The till’s Pay buttons don’t change, and a website order is still paid at the door. Cash is always taken.',
  contact:
    'The first WhatsApp number is the “Order on WhatsApp” link. Social links show in the website’s footer and tell search engines they are yours — live profiles only.',
  greeting: 'The message every “Order on WhatsApp” button starts with. The pages’ own messages (pizza, burgers, late night, an area) keep their words, with the name from Shop details.',
  allergy:
    'Shown on the menu page and at checkout. Keep the “shares equipment, can’t guarantee” sentence: it is what protects the shop. It is the printed menu’s wording too.',
  home:
    'Which items the home page features. Prices come from the menu. An item not on the website’s menu (hidden, off the website, renamed or deleted) is left off the home page — never shown at Rs 0. Drink brand names are never shown.',
} as const;

// ---------------------------------------------------------------------------
// Shop details ('shop.profile': name, tagline, phone, address, price range)
// ---------------------------------------------------------------------------

export interface ShopDetailsWebForm {
  name: string;
  tagline: string;
  phone: string;
  street: string;
  areaLine: string;
  postalCode: string;
  priceRange: string;
}

export function shopDetailsToForm(p: ShopProfile): ShopDetailsWebForm {
  return {
    name: p.name,
    tagline: p.tagline,
    phone: p.phone.display,
    street: p.address.street,
    areaLine: p.address.areaLine,
    postalCode: p.address.postalCode,
    priceRange: p.priceRange,
  };
}

/** One line as saved: spaces at its ends dropped, runs of spaces kept as typed. */
const line = (t: string) => t.trim();

export function shopDetailsFromForm(f: ShopDetailsWebForm, saved: ShopProfile): Parsed<ShopProfile> {
  const display = line(f.phone);
  const e164 = normalizePhone(display);
  if (!e164) return { value: null, problem: 'Type the phone number as it is dialled in Pakistan (like 0300 1234567).' };
  const value = withFields(
    'shop.profile',
    saved,
    {
      name: line(f.name),
      tagline: line(f.tagline),
      phone: { display, e164 },
      address: { street: line(f.street), areaLine: line(f.areaLine), postalCode: line(f.postalCode) },
      priceRange: line(f.priceRange),
    },
    SHOP_CARD_FIELDS.details,
  );
  return checked(shopProfileSchema, value, 'the shop details');
}

/** The Shop details card's part in one line (History, "Put back"). */
export function shopDetailsSummary(p: ShopProfile): string {
  return `${p.name} · ${p.phone.display} · ${p.address.street}, Karachi ${p.address.postalCode}`;
}

/** Which of the Google listing's details this change touches (name, phone, address), in words; [] when none. */
export function googleListingChanges(saved: ShopProfile, next: ShopProfile): string[] {
  const out: string[] = [];
  if (saved.name !== next.name) out.push('the name');
  if (saved.phone.e164 !== next.phone.e164 || saved.phone.display !== next.phone.display) out.push('the phone number');
  if (JSON.stringify(saved.address) !== JSON.stringify(next.address)) out.push('the address');
  return out;
}

/**
 * The menu's real price range, for the price-range hint: the cheapest and
 * the dearest item going to the website (delivery charges left out), or null
 * when there is none.
 */
export function menuPriceHint(prices: readonly number[]): string | null {
  const shown = prices.filter((c) => c > 0);
  if (shown.length === 0) return null;
  const lo = Math.min(...shown);
  const hi = Math.max(...shown);
  return lo === hi ? `Your menu on the website: ${formatCents(lo)}.` : `Your menu on the website: ${formatCents(lo)} to ${formatCents(hi)}.`;
}

// ---------------------------------------------------------------------------
// Opening hours ('shop.hours')
// ---------------------------------------------------------------------------

export interface HoursForm {
  opens: string;
  closes: string;
  days: ShopDay[];
}

export function hoursToForm(h: ShopHours): HoursForm {
  return { opens: h.opens, closes: h.closes, days: [...h.days] };
}

const pad = (n: number) => String(n).padStart(2, '0');
const quarterHours = (fromMin: number, toMin: number) => {
  const out: string[] = [];
  for (let m = fromMin; m <= toMin; m += 15) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  return out;
};
const [startH = 5] = TRADING_DAY_STARTS.split(':').map(Number);

/** The opening times the card offers: 5 am to 11:45 pm, every quarter hour. */
export const OPENING_TIMES: readonly string[] = quarterHours(startH * 60, 23 * 60 + 45);
/** The closing times it offers: from the opening time to 11:45 pm, then midnight to 4:45 am. */
export function closingTimes(opens: string): string[] {
  const [h = 0, m = 0] = opens.split(':').map(Number);
  return [...quarterHours(h * 60 + m + 15, 23 * 60 + 45), ...quarterHours(0, startH * 60 - 15)];
}

export function hoursFromForm(f: HoursForm, saved: ShopHours): Parsed<ShopHours> {
  const value: ShopHours = {
    ...clone(saved),
    v: SHOP_SETTING_FORMAT['shop.hours'],
    opens: f.opens,
    closes: f.closes,
    // Monday first, each once, whatever order they were ticked in.
    days: SHOP_DAYS.filter((d) => f.days.includes(d)),
  };
  return checked(shopHoursSchema, value, 'the opening hours');
}

export function hoursSummary(h: Pick<ShopHours, 'opens' | 'closes' | 'days'>): string {
  return hoursLine(h);
}

/** What else on the website follows these hours (said on the card), in the owner's words. */
export function hoursEffects(h: Pick<ShopHours, 'opens' | 'closes' | 'days'>): string[] {
  const out: string[] = [];
  if (!everyDay(h)) out.push('The website stops saying “daily” and “every day”, and lists the days you open.');
  if (!closesAfterMidnight(h)) {
    out.push('The late-night page stops saying you deliver after midnight (its address stays the same): it needs a closing time after midnight.');
  }
  if (!opensBy(h, '13:00')) out.push('The website stops saying you do lunch.');
  return out;
}

/** "12 noon" for a time, for the card's lists. */
export const timeLabel = timeWords;

// ---------------------------------------------------------------------------
// Payments at the door ('shop.website' doorPayments, pickupPayments)
// ---------------------------------------------------------------------------

export interface PaymentsForm {
  door: DoorPayment[];
  pickup: DoorPayment[];
}

export function paymentsToForm(w: ShopWebsite): PaymentsForm {
  return { door: [...w.doorPayments], pickup: [...w.pickupPayments] };
}

/** Tick or untick one way of paying (cash stays ticked: it is always taken). */
export function togglePayment(list: readonly DoorPayment[], p: DoorPayment): DoorPayment[] {
  if (p === 'cash') return canonicalPayments(list);
  return canonicalPayments(list.includes(p) ? list.filter((x) => x !== p) : [...list, p]);
}

export function paymentsFromForm(f: PaymentsForm, saved: ShopWebsite): Parsed<ShopWebsite> {
  const value = withFields(
    'shop.website',
    saved,
    { doorPayments: canonicalPayments(['cash', ...f.door]), pickupPayments: canonicalPayments(['cash', ...f.pickup]) },
    SHOP_CARD_FIELDS.payments,
  );
  return checked(shopWebsiteSchema, value, 'the payments');
}

export function paymentsSummary(w: ShopWebsite): string {
  return `At the door: ${paymentsWords(w.doorPayments)}; for a pick-up: ${paymentsWords(w.pickupPayments)}`;
}

/** What the website will say, in the owner's words. */
export function paymentsEffect(w: Pick<ShopWebsite, 'doorPayments' | 'pickupPayments'>): string {
  const door = cashOnly(w.doorPayments)
    ? 'The website says a delivery is paid in cash to the rider (as today).'
    : `The website stops saying “cash only” and says the rider takes ${paymentsWords(w.doorPayments)}. For search engines: “${paymentAccepted(w.doorPayments)}”.`;
  const pickup = cashOnly(w.pickupPayments)
    ? 'A pick-up is paid in cash at the counter (as today).'
    : `A pick-up is paid at the counter by ${paymentsWords(w.pickupPayments)}.`;
  return `${door} ${pickup}`;
}

export const PAYMENT_CHOICES: ReadonlyArray<{ id: DoorPayment; label: string }> = DOOR_PAYMENTS.map((id) => ({ id, label: DOOR_PAYMENT_LABEL[id] }));

// ---------------------------------------------------------------------------
// WhatsApp numbers & social links ('shop.profile' whatsappLines, socialLinks)
// ---------------------------------------------------------------------------

export interface ContactForm {
  /** Each WhatsApp number as typed (the first = the order link). */
  lines: string[];
  /** Each social link as typed ('' rows are left out). */
  links: string[];
}

export function contactToForm(p: ShopProfile): ContactForm {
  return { lines: p.whatsappLines.map((l) => l.display), links: [...p.socialLinks] };
}

export function contactFromForm(f: ContactForm, saved: ShopProfile): Parsed<ShopProfile> {
  const whatsappLines: ShopProfile['whatsappLines'] = [];
  for (const typed of f.lines.map(line).filter((t) => t !== '')) {
    const e164 = normalizePhone(typed);
    if (!e164) return { value: null, problem: `${typed} is not a Pakistani phone number (like 0300 1234567).` };
    whatsappLines.push({ display: typed, e164 });
  }
  const socialLinks = f.links.map(line).filter((t) => t !== '');
  const value = withFields('shop.profile', saved, { whatsappLines, socialLinks }, SHOP_CARD_FIELDS.contact);
  return checked(shopProfileSchema, value, 'the WhatsApp numbers and links');
}

export function contactSummary(p: ShopProfile): string {
  const lines = `WhatsApp ${andList(p.whatsappLines.map((l) => l.display))}`;
  return p.socialLinks.length === 0 ? `${lines}; no social links` : `${lines}; ${andList(p.socialLinks.map(socialLabel))}`;
}

// ---------------------------------------------------------------------------
// WhatsApp greeting ('shop.website' whatsappGreeting)
// ---------------------------------------------------------------------------

/** The box shows the greeting without its trailing space. */
export function greetingToForm(w: ShopWebsite): string {
  return w.whatsappGreeting.replace(/\s+$/, '');
}

/** As saved: the words, then ONE space (the customer types on after it). */
export function greetingOf(typed: string): string {
  const words = typed.replace(/\s+$/, '').replace(/^\s+/, '');
  return words === '' ? '' : `${words} `;
}

export function greetingFromForm(typed: string, saved: ShopWebsite): Parsed<ShopWebsite> {
  const whatsappGreeting = greetingOf(typed);
  if (whatsappGreeting === '') return { value: null, problem: 'Type the WhatsApp greeting' };
  return checked(shopWebsiteSchema, withFields('shop.website', saved, { whatsappGreeting }, SHOP_CARD_FIELDS.greeting), 'the greeting');
}

export function greetingSummary(w: ShopWebsite): string {
  return `“${w.whatsappGreeting.trim()}”`;
}

/** The link an "Order on WhatsApp" button opens with this greeting (the first WhatsApp number). */
export function greetingLink(greeting: string, profile: Pick<ShopProfile, 'whatsappLines'>): string | null {
  const first = profile.whatsappLines[0];
  return first ? waLinkWith(first.e164, greeting) : null;
}

// ---------------------------------------------------------------------------
// Allergy notice ('shop.website' allergyNotice)
// ---------------------------------------------------------------------------

export function allergyFromForm(typed: string, saved: ShopWebsite): Parsed<ShopWebsite> {
  return checked(shopWebsiteSchema, withFields('shop.website', saved, { allergyNotice: line(typed) }, SHOP_CARD_FIELDS.allergy), 'the allergy notice');
}

export function allergySummary(w: ShopWebsite): string {
  return w.allergyNotice.length > 70 ? `${w.allergyNotice.slice(0, 67)}…` : w.allergyNotice;
}

/** A notice without the "shares equipment / can't guarantee" words: the card warns (not refused). */
export function allergyLacksGuarantee(text: string): boolean {
  return !/equipment/i.test(text) || !/guarantee/i.test(text);
}

// ---------------------------------------------------------------------------
// The home page ('website.home')
// ---------------------------------------------------------------------------

/** An item the Home card can feature: on the website (not a delivery charge), in the menu's order. */
export interface PickableItem {
  id: string;
  name: string;
  priceCents: number;
  categoryName: string;
  sortOrder: number;
  categoryOrder: number;
}

/**
 * The items the home page can feature: those the next publish sends
 * (publishWords itemWebsiteState: on the website or pick-up only), never a
 * delivery charge, in the menu's order (categories by display order).
 */
export function pickableItems(
  items: readonly MenuItem[],
  categories: readonly Category[],
  feeItemIds: ReadonlySet<string>,
): PickableItem[] {
  const cats = new Map(categories.map((c) => [c.id, c]));
  return items
    .filter((i) => {
      const fee = isDeliveryChargeMenuItem(i, feeItemIds);
      const state = itemWebsiteState(i, cats.get(i.categoryId), fee);
      return state !== 'fee' && goesToWebsite(state);
    })
    .map((i) => ({
      id: i.id,
      name: i.name,
      priceCents: i.basePriceCents,
      categoryName: cats.get(i.categoryId)?.name ?? '',
      sortOrder: i.sortOrder,
      categoryOrder: cats.get(i.categoryId)?.displayOrder ?? 0,
    }))
    .sort((a, b) => a.categoryOrder - b.categoryOrder || a.sortOrder - b.sortOrder);
}

/** The pickable items as the shared matcher reads a menu (one category each, in order). */
function asHomeMenu(items: readonly PickableItem[]) {
  return {
    categories: items.map((i) => ({
      displayOrder: i.categoryOrder,
      items: [{ posItemId: i.id, name: i.name, basePriceCents: i.priceCents, sortOrder: i.sortOrder }],
    })),
  };
}

/** Each entry with the item it is on the menu the website will get (THE matcher, shared with the website), or null: missing. */
export function homePreview(home: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>, items: readonly PickableItem[]) {
  const l = homeLineup(home, asHomeMenu(items));
  const byId = new Map(items.map((i) => [i.id, i]));
  const at = (e: { entry: HomeEntry; item: { posItemId: string } | null }) => ({ entry: e.entry, item: e.item ? (byId.get(e.item.posItemId) ?? null) : null });
  return { pizzas: l.pizzas.map(at), burger: l.burger ? at(l.burger) : null, deals: l.deals.map(at) };
}

/** The entries the preview can't find, by name, pizzas then the burger then the deals. */
export function homeMissingHere(home: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>, items: readonly PickableItem[]): string[] {
  const p = homePreview(home, items);
  return [...p.pizzas, ...(p.burger ? [p.burger] : []), ...p.deals].filter((e) => e.item === null).map((e) => e.entry.itemRef.name);
}

/** "Not on the website’s menu, so left off the home page: A and B." (null when all are there) */
export function homeMissingWords(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `Not on the website’s menu, so left off the home page: ${andList(names.map((n) => `“${n}”`))}. Put the item on the website (Menu), or pick another here.`;
}

/** An entry for a picked item: its id and its name as the till has it; the words kept. */
export function pickedEntry(item: Pick<PickableItem, 'id' | 'name'>, words: Pick<HomeEntry, 'headline' | 'text'> = {}): HomeEntry {
  return {
    itemRef: { posItemId: item.id, name: item.name },
    ...(words.headline !== undefined ? { headline: words.headline } : {}),
    ...(words.text !== undefined ? { text: words.text } : {}),
  };
}

/** An entry with its words as typed (kept as typed while the box is being filled; '' = none: the website's own words). */
export function withWords(e: HomeEntry, words: { headline?: string; text?: string }): HomeEntry {
  const headline = words.headline === undefined ? e.headline : words.headline === '' ? undefined : words.headline;
  const text = words.text === undefined ? e.text : words.text === '' ? undefined : words.text;
  return { itemRef: { ...e.itemRef }, ...(headline !== undefined ? { headline } : {}), ...(text !== undefined ? { text } : {}) };
}

/** An entry as saved: its words without spaces at their ends, and none when only spaces were typed. */
function savedEntry(e: HomeEntry): HomeEntry {
  const headline = e.headline === undefined ? undefined : line(e.headline) || undefined;
  const text = e.text === undefined ? undefined : line(e.text) || undefined;
  return { itemRef: { posItemId: e.itemRef.posItemId, name: e.itemRef.name }, ...(headline !== undefined ? { headline } : {}), ...(text !== undefined ? { text } : {}) };
}

export function homeFromForm(f: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>, saved: WebsiteHome): Parsed<WebsiteHome> {
  const value: WebsiteHome = {
    ...clone(saved),
    v: SHOP_SETTING_FORMAT['website.home'],
    pizzas: f.pizzas.map(savedEntry),
    burger: f.burger ? savedEntry(f.burger) : null,
    deals: f.deals.map(savedEntry),
  };
  return checked(websiteHomeSchema, value, 'the home page');
}

export function homeSummary(h: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return `${n(h.pizzas.length, 'pizza', 'pizzas')}, ${h.burger ? 'a burger' : 'no burger'}, ${n(h.deals.length, 'deal', 'deals')}`;
}

/** Move an entry up (-1) or down (+1) in its list. */
export function moved<T>(list: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
