import {
  BUY_1_GET_1_NAME_RE,
  groupDisplayName,
  isBuy1Get1Category,
  isFixedChoiceGroup,
  normalizeAreaText,
  type PublishedMenu,
  type PublishedMenuItem,
  type PublishedModifierGroup,
} from '@cheeseoclock/shared-types';
import { zoneNameWithLocalNames, type FactZone } from './delivery-facts';
import { formatCents } from './format';
import { isDealSection, isPickupOnly } from './menu-view';
import { validateModifierSelection } from './order-validation';
import type { WaOut } from './whatsapp-send';

/**
 * The WhatsApp ordering bot (26 Oct 2026, the user: "customers chat with bot and select menu and confirm order there").
 * A customer orders inside the chat with WhatsApp's tap-to-pick lists and buttons, or by typing. Before they confirm,
 * the website's own order route prices it (api/orders dryRun), so the total they see is the till's; confirming places
 * it there like a website order (the personal link token marks it as WhatsApp's), and the till pulls it as any other.
 *
 * Fewer steps (27 Oct 2026, the user: "people got confused how to use it make it easy simple steps not long"). Of the
 * five people a Click-to-WhatsApp ad brought that day, three left at the old three-button welcome, one typed what they
 * wanted instead of tapping and was pointed back at the list twice, and one asked for staff. Now:
 *  - the first reply is the menu itself: the deals, one pick away (no "Order karein" button first);
 *  - an item with its choices goes straight into the order (no "how many?" step: a number typed changes it), and the
 *    order's message asks Delivery or Pick-up;
 *  - delivery asks one thing, the address: the area is read from it (the till's own spellings for the areas), and the
 *    area list comes only when it names none;
 *  - the WhatsApp name is the order's name (asked only when it is not a name), and there is no note step: what they
 *    type at the confirm step goes on the order as its note;
 *  - typing works where tapping does: an item's name finds it, a choice's name picks it, "ok" confirms.
 * A message from the old steps (a "how many" button, the name and note buttons) still finishes its order.
 *
 * No buttons (28 Oct 2026, the user: "show them all without button and let them choose the option via typing number or
 * name of the deal keyword"; "bot should reply every deals and menu prices according to keyword and also show the 20
 * percent off on regular pizzas"). A list showed its items only behind its button, so people asked "Price", "Price
 * list", "Price plz" after every list and staff answered them all. Every message is now plain text with its options
 * numbered and the prices in it, the website's % off shown on them; a number typed picks that option, a name or a
 * word ("price", "deals", "pizza", "buy 1 get 1") answers with those prices. A tap on an older list still works.
 *
 * Pure apart from what `deps` does: one customer message in, the next step and the messages to send out. The route
 * keeps the step (lib/whatsapp-store wa_sessions) and sends the messages (lib/whatsapp-send).
 */

/** The steps. `qty`, `fulfilment` and `notes` are the old bot's: only a session saved before 27 Oct 2026 is in them. */
export type BotState =
  | 'idle'
  | 'menu'
  | 'items'
  | 'choice'
  | 'qty'
  | 'cart'
  | 'fulfilment'
  | 'zones'
  | 'address'
  | 'name'
  | 'notes'
  | 'social'
  | 'confirm';

export interface CartLine {
  posItemId: string;
  quantity: number;
  modifierIds: string[];
}

export interface BotData {
  cart: CartLine[];
  /**
   * The item being put together: its choices so far and which of its required choices is being asked; `quantity`
   * when it is already known (a catalog cart's count, or a number typed with the item's name).
   */
  pending?: { posItemId: string; modifierIds: string[]; step: number; quantity?: number } | null;
  /** The rest of a catalog cart, waiting for their choices one item at a time. */
  queue?: Array<{ posItemId: string; quantity: number }>;
  fulfilment?: 'delivery' | 'pickup';
  zoneId?: string;
  address?: string;
  name?: string;
  notes?: string | null;
  social?: string | null;
  /** The order's id from its first quote on: confirming twice places it once (api/orders clientOrderId). */
  orderId?: string;
  /** The customer's personal link token (lib/whatsapp-store): the order is WhatsApp's, the number trusted. */
  token?: string;
  /** Helped once after a message the step could not use; after that the bot keeps quiet for staff. */
  nudged?: boolean;
  /** The options the bot's last message numbered, in order (the ids a tap would send): a number typed is one of them. */
  choices?: string[];
}

/** What the bot knows of the shop for this message (the route reads it). */
export interface BotShop {
  /** What customers can order: no drink brand, Buy 1 Get 1 only while for sale. */
  menu: PublishedMenu;
  zones: readonly FactZone[];
  open: boolean;
  pickupAvailable: boolean;
  pickupPercent: number;
  /**
   * The website's % off a delivery's food, and the categories with a % of their own (the regular pizzas' 20%) on a
   * pick-up and on a delivery (lib/store-status): the prices the bot shows are the ones the order is charged.
   */
  deliveryPercent?: number;
  pickupCategoryPercents?: ReadonlyArray<{ categoryId: string; percent: number }>;
  deliveryCategoryPercents?: ReadonlyArray<{ categoryId: string; percent: number }>;
  /** Buy 1 Get 1's hours in words ("12–7 PM") while the offer is on, and whether it sells right now. */
  buy1Get1Hours?: string | null;
  buy1Get1Open?: boolean;
  /**
   * The printed deal menu as a picture (28 Oct 2026, the user: customers are "really uneducated"): its address, and
   * the deals' names in the order the picture numbers them. The bot sends it while every one of those names is on the
   * menu, so a number typed is the deal printed with it; else the deals go out as text.
   */
  menuPicture?: { url: string; deals: readonly string[] } | null;
  /** What to say while the shop takes no orders (the hours). */
  closedText: string;
}

/** The website's order answer (api/orders), as the bot reads it. */
export type OrderAnswer =
  | {
      ok: true;
      orderId?: string;
      subtotalCents: number;
      discountCents: number;
      taxCents: number;
      totalCents: number;
      /** The order's lines as stored (shared-types WebOrderItem): the unit price includes the choices. */
      lines?: Array<{ posItemId: string; name: string; quantity: number; unitPriceCents: number; modifiers: Array<{ posModifierId: string; name: string }> }>;
    }
  | { ok: false; error: string; message?: string };

export interface BotDeps {
  /** Prices it as a real order would be (dryRun) or places it (api/orders). */
  order(body: Record<string, unknown>): Promise<OrderAnswer>;
  /** A personal link token for this customer. */
  link(): Promise<string>;
  /** A new order id. */
  newId(): string;
  /** The order's tracking page. */
  trackUrl(orderId: string, phone: string): string;
  /** The day's link message (the "Website" row). */
  websiteText(token: string): string;
  /** An order went through (the route tells Meta when an ad brought the chat: lib/whatsapp-conversions). */
  placed?(order: { orderId: string; totalCents: number }): void;
}

export interface BotTurn {
  waId: string;
  profileName: string | null;
  text: string | null;
  reply: { id: string; title: string } | null;
  /** A cart sent from the WhatsApp catalog (lib/meta-catalog). */
  order?: Array<{ posItemId: string; quantity: number }> | null;
  /** The day's hello (helloLine), when this message is the customer's first of the day: put over the menu if it is shown. */
  hello?: string | null;
}

export interface BotStep {
  state: BotState;
  data: BotData;
  out: WaOut[];
}

/** Words that start an order, end it, or ask for a person, whatever the step. */
const START = /^(menu|order|start|order karna hai|menu bhejein|menu bhejo)$/i;
const CANCEL = /^(cancel|band|band karo|stop)$/i;
const STAFF = /^(staff|human|insaan|baat karni hai)$/i;
/** Yes at the confirm step: "ok", "haan ji", "confirm kar do" — only such words, and one of them a yes. */
const YES_WORDS = new Set(['confirm', 'confirmed', 'ok', 'okay', 'okk', 'yes', 'yess', 'haan', 'han', 'ji', 'jee', 'done', 'theek', 'thik', 'sure', 'bilkul', 'sahi', 'hai', 'kar', 'karo', 'kardo', 'do', 'dein', 'order', 'please', 'plz']);
const YES_SURE = new Set(['confirm', 'confirmed', 'ok', 'okay', 'okk', 'yes', 'yess', 'haan', 'han', 'ji', 'jee', 'done', 'theek', 'thik', 'sure', 'bilkul', 'sahi', 'kardo']);
function saysYes(said: readonly string[]): boolean {
  return said.length > 0 && said.length <= 5 && said.every((w) => YES_WORDS.has(w)) && said.some((w) => YES_SURE.has(w));
}
/** "2x", "x2", "2 deals": a count on its own (a bare "2" picks option 2 when the message numbered its options). */
const COUNT = /^x?(\d{1,2})x?( (deals?|pizzas?|burgers?|plates?|drinks?|dips?|pcs|pieces?))?$/;
/** The website's order link, and the order so far, whatever the step. */
const WEB = /^(website|web site|site|link|website link)$/i;
const CART_WORDS = /^(cart|mera order|my order|order dekhein|order dekhna hai)$/i;
/**
 * A hello, or an ask for the menu, the prices or "more info" — Meta's own words when an ad is tapped ("Hello! Can I get
 * more info on this?"): the menu, never "not understood".
 */
const MENU_ASK = new Set(['hello', 'helo', 'hey', 'salam', 'slam', 'aoa', 'menu', 'info', 'information', 'details', 'detail', 'price', 'prices', 'rate', 'rates', 'list', 'deal', 'deals']);
function asksForMenu(said: readonly string[]): boolean {
  return said.length > 0 && said.length <= 12 && said.some((w) => MENU_ASK.has(w) || /^hi+$/.test(w) || /^as+a?lam/.test(w));
}

/** "price", "rate", "qeemat", "kitne ka", "kitne mein", "how much": an ask for prices ("kitni der" is time, not price). */
const PRICE_WORDS = new Set(['price', 'prices', 'pricing', 'rate', 'rates', 'qeemat', 'qimat', 'keemat', 'kimat', 'cost', 'pricelist', 'ratelist']);
const HOW_MUCH = new Set(['kitne', 'kitna', 'kitni', 'kitnay', 'kitny', 'kitnai']);
const HOW_MUCH_THEN = new Set(['ka', 'ki', 'ke', 'kay', 'mein', 'me', 'main', 'hai', 'hain', 'ho', 'rs', 'rupay', 'rupees', 'rupee', 'pkr']);
function asksPrice(said: readonly string[]): boolean {
  return (
    said.some((w, i) => PRICE_WORDS.has(w) || (HOW_MUCH.has(w) && (i === said.length - 1 || HOW_MUCH_THEN.has(said[i + 1]!)))) ||
    (said.includes('how') && said.includes('much'))
  );
}
/** The deals and the offers: "deals", "koi offer hai?", "discount", "20% off". */
const DEAL_WORDS = new Set(['deal', 'deals', 'offer', 'offers', 'discount', 'discounts', 'off', 'sale', 'promo', 'promotion']);
/** "buy 1 get 1", "buy one get one", "bogo", "b1g1". */
function asksBuy1Get1(text: string, said: readonly string[]): boolean {
  return BUY_1_GET_1_NAME_RE.test(text) || said.some((w) => w === 'bogo' || w === 'b1g1' || w === 'b1g1f');
}
/** A size asked about ("small medium aur large?"): the pizzas, which come in sizes. */
const SIZE_WORDS = new Set(['small', 'medium', 'large', 'size', 'sizes']);
/** Words that ask the bot for something even in a chat it is not in: the menu or the list, the deals and the offers. */
const ASK_WORDS = new Set(['menu', 'list', 'deal', 'deals', 'offer', 'offers', 'discount', 'discounts']);

/**
 * Asks for the prices, the deals, Buy 1 Get 1, the offers or the menu: the bot answers them even in a chat it is not
 * in, while staff are not in it either (lib/whatsapp-bot-run). A hello on its own is not one (it may be for staff).
 */
export function asksBot(text: string): boolean {
  const said = wordsOf(text);
  return said.length > 0 && said.length <= 12 && (asksPrice(said) || asksBuy1Get1(text, said) || said.some((w) => ASK_WORDS.has(w)));
}

/** "3", "no 3", "#3", "3." → [3]; "1 4 6", "1,4,6" → [1, 4, 6]; anything else → null. Urdu digits read as digits. */
function numbersTyped(text: string): number[] | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/^(?:no\.?|number|num|#)\s*/, '')
    .replace(/\s*(?:no\.?|number)$/, '')
    .replace(/\.$/, '');
  if (!/^\d{1,3}(?:\s*[,\s]\s*\d{1,3})*$/.test(t)) return null;
  const ns = t.split(/[\s,]+/).map(Number).filter((n) => n > 0);
  return ns.length > 0 ? ns : null;
}

/** A word that starts, stops or hands over an order whatever the step ("menu", "cancel", "staff"). */
export function isBotCommand(text: string): boolean {
  const t = text.trim();
  return START.test(t) || CANCEL.test(t) || STAFF.test(t);
}

/**
 * The bot's first messages of the day to a customer while the shop is open (the route sends them and keeps the step):
 * the whole menu, numbered, with a hello.
 */
export function welcomeStep(o: { shopName: string; profileName: string | null; shop: BotShop }): BotStep {
  const data: BotData = { cart: [] };
  const v = startView(o.shop, helloLine(o));
  return { state: 'menu', data: { ...data, choices: v.choices }, out: v.out };
}

/** "Assalam o Alaikum Ali! Cheese O'Clock mein khush aamdeed 🧀" */
export function helloLine(o: { shopName: string; profileName: string | null }): string {
  const name = firstName(o.profileName);
  return `Assalam o Alaikum${name ? ` ${name}` : ''}! ${o.shopName} mein khush aamdeed 🧀`;
}

/** "Ali" from "Ali Raza": a first name of letters only, else nothing. */
function firstName(profileName: string | null): string | null {
  const first = profileName?.trim().split(/\s+/)[0] ?? '';
  return /^\p{L}{2,20}$/u.test(first) ? first : null;
}

/** The WhatsApp name as an order's name: letters, spaces and dots, 2–40 long; else none. */
function orderName(profileName: string | null): string | null {
  const n = profileName?.replace(/\s+/g, ' ').trim() ?? '';
  return /^[\p{L} .'-]{2,40}$/u.test(n) && /\p{L}/u.test(n) ? n : null;
}

// ---------------------------------------------------------------------------
// The menu as the bot shows it

/** The delivery-charge items: never on the bot's menu (the area adds its charge). */
function feeIds(shop: BotShop): Set<string> {
  return new Set(shop.zones.map((z) => z.feeItemId).filter((id): id is string => Boolean(id)));
}

interface BotCategory {
  id: string;
  name: string;
  items: PublishedMenuItem[];
}

/** The categories a customer can order from, with their items (no delivery charges). */
function categoriesOf(shop: BotShop): BotCategory[] {
  const fees = feeIds(shop);
  return shop.menu.categories
    .filter((c) => !/delivery charge/i.test(c.name))
    .map((c) => ({ id: c.posCategoryId, name: c.name, items: c.items.filter((i) => !fees.has(i.posItemId)) }))
    .filter((c) => c.items.length > 0);
}

function categoryOfItem(shop: BotShop, posItemId: string): BotCategory | undefined {
  return categoriesOf(shop).find((c) => c.items.some((i) => i.posItemId === posItemId));
}

function itemOf(shop: BotShop, posItemId: string): PublishedMenuItem | undefined {
  return categoriesOf(shop)
    .flatMap((c) => c.items)
    .find((i) => i.posItemId === posItemId);
}

/** The choices the customer must make (a deal's fixed parts are not asked: they come with it). */
function requiredGroups(item: PublishedMenuItem): PublishedModifierGroup[] {
  return item.modifierGroups.filter((g) => (g.isRequired || g.minSelect > 0) && !isFixedChoiceGroup(g));
}

/**
 * A choice the bot makes itself, the usual one, shown on the order and changed by typing its name (28 Oct 2026, the
 * user: the steps were too many for customers who are "really uneducated"): a deal's or a burger's drink and dip. A
 * drink's own flavour is asked: the drink is what they ordered.
 */
function usualGroup(item: PublishedMenuItem, g: PublishedModifierGroup): boolean {
  return !/\bdrinks?\b/i.test(item.name) && /\b(drinks?|dips?|sauces?|flavours?)\b/i.test(g.name);
}

/** The usual pick of a group: the till's default, else its first (cola, the signature dip), as many as it needs. */
function usualIds(g: PublishedModifierGroup): string[] {
  const ordered = [...g.modifiers.filter((m) => m.isDefault), ...g.modifiers.filter((m) => !m.isDefault)];
  return ordered.slice(0, Math.max(1, g.minSelect)).map((m) => m.posModifierId);
}

/** The choices the customer is asked: the required ones that are not the bot's usual picks. */
function askedGroups(item: PublishedMenuItem): PublishedModifierGroup[] {
  return requiredGroups(item).filter((g) => !usualGroup(item, g));
}

/**
 * What an item starts with, as the website's sheet does: its fixed parts, the usual drink and dip, and the till's
 * defaults where nothing is asked.
 */
function startIds(item: PublishedMenuItem): string[] {
  const asked = new Set(askedGroups(item).map((g) => g.posGroupId));
  const required = new Set(requiredGroups(item).map((g) => g.posGroupId));
  return item.modifierGroups.flatMap((g) =>
    isFixedChoiceGroup(g)
      ? g.modifiers.map((m) => m.posModifierId)
      : asked.has(g.posGroupId)
        ? []
        : required.has(g.posGroupId)
          ? usualIds(g)
          : g.modifiers.filter((m) => m.isDefault).map((m) => m.posModifierId),
  );
}

/** A choice group as the customer reads it: "Deal: Large pizza" → "Large pizza", "Deal: dip" → "Dip". */
function groupLabelOf(group: PublishedModifierGroup): string {
  const label = groupDisplayName(group.name).replace(/^Deal:\s*/i, '');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** A choice without the group's word the till puts first ("Large: Fajita Pizza" → "Fajita Pizza"). */
function choiceName(name: string): string {
  return name.replace(/^[^:]{1,20}:\s*/, '') || name;
}

/** A line's price before tax and charges: the item and its choices, times how many. */
function lineCents(item: PublishedMenuItem, line: CartLine): number {
  const deltas = item.modifierGroups
    .flatMap((g) => g.modifiers)
    .filter((m) => line.modifierIds.includes(m.posModifierId))
    .reduce((sum, m) => sum + m.priceDeltaCents, 0);
  return (item.basePriceCents + deltas) * line.quantity;
}

/** What was picked on a line, in short words ("Fajita · Cola 1 litre · Signature Orange Dip"). */
function pickedWords(item: PublishedMenuItem, ids: readonly string[]): string {
  return requiredGroups(item)
    .flatMap((g) => g.modifiers.filter((m) => ids.includes(m.posModifierId)).map((m) => choiceName(m.name)))
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Reading what the customer typed

/** Lower-case words, accents and punctuation gone: "Large & Chilled!" → ["large", "chilled"]. */
function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Words that never pick one item or choice out of the rest ("pizza" in "Fajita Pizza", "ml" in "Pepsi 345 ml"). */
const GENERIC = new Set(['deal', 'deals', 'pizza', 'pizzas', 'burger', 'burgers', 'chicken', 'and', 'with', 'the', 'or', 'large', 'medium', 'regular', 'free', 'ml', 'litre', 'liter', '2nd']);

/** The brands people say for the flavours the menu names (it never names a brand: lib/menu-view drinkFlavourName). */
const SAID_AS: Record<string, string> = {
  coke: 'cola',
  pepsi: 'cola',
  coca: 'cola',
  '7up': 'lemon lime',
  sprite: 'lemon lime',
  mirinda: 'orange',
  fanta: 'orange',
  dew: 'citrus',
  mountain: 'citrus',
};

/** One word of a name, said: the same word, a plural of it, or its start (four letters at least: "partner", "chill"). */
function wordSaid(word: string, said: readonly string[]): boolean {
  return said.some((w) => w === word || w === `${word}s` || word === `${w}s` || (w.length >= 4 && word.startsWith(w)));
}

/** The words of a name that tell it apart (all of them when every one is generic), numbers left out. */
function tellingWords(name: string): string[] {
  const all = wordsOf(name).filter((w) => w.length >= 2 && !/^\d+$/.test(w));
  const telling = all.filter((w) => !GENERIC.has(w));
  return telling.length > 0 ? telling : all;
}

/**
 * The items a message names: every telling word of an item's name is in it ("cheese partner" → Cheese Partners,
 * "fajita" → both Fajita pizzas). A size said too ("fajita large") keeps that size.
 */
function itemsNamed(shop: BotShop, said: readonly string[]): PublishedMenuItem[] {
  if (said.length === 0) return [];
  const hits = categoriesOf(shop)
    .flatMap((c) => c.items)
    .filter((i) => {
      const need = tellingWords(i.name.split(' — ')[0] ?? i.name);
      return need.length > 0 && need.every((w) => wordSaid(w, said));
    });
  // A name said in full wins ("Classic Crispy Deal order karni hai": the deal, not the Classic Crispy burger too) —
  // an ad's pre-filled message names its deal so (28 Oct 2026).
  const whole = ` ${said.join(' ')} `;
  const full = hits.filter((i) => whole.includes(` ${wordsOf(i.name).join(' ')} `));
  if (full.length > 0) {
    const longest = Math.max(...full.map((i) => i.name.length));
    return full.filter((i) => i.name.length === longest);
  }
  const sized = hits.filter((i) => {
    const size = i.name.split(' — ')[1];
    return size !== undefined && wordsOf(size).every((w) => wordSaid(w, said));
  });
  return sized.length > 0 ? sized : hits;
}

/** The categories a message names ("burger" → Burgers, "dip" → Dips), by index. */
function categoriesNamed(shop: BotShop, said: readonly string[]): number[] {
  return categoriesOf(shop)
    .map((c, i) => ({ i, words: wordsOf(c.name).filter((w) => w.length >= 3 && !['and', 'the', 'buy', 'get'].includes(w)) }))
    .filter((c) => c.words.some((w) => wordSaid(w, said)))
    .map((c) => c.i);
}

/** "2 cheese partners", "2x …": how many, when the message starts with a number (1–20); else one. */
function countSaid(said: readonly string[]): number {
  const m = /^(\d{1,2})x?$/.exec(said[0] ?? '');
  return m ? Math.min(20, Math.max(1, Number(m[1]))) : 1;
}

/** The one choice of a group a message names ("fajita", "coke" → Cola), or null when it names none or several. */
function choiceNamed(group: PublishedModifierGroup, picked: readonly string[], text: string): string | null {
  const said = wordsOf(text).flatMap((w) => (SAID_AS[w] ?? w).split(' '));
  if (said.length === 0) return null;
  const left = group.modifiers.filter((m) => !picked.includes(m.posModifierId));
  const exact = left.filter((m) => wordsOf(choiceName(m.name)).join(' ') === said.join(' '));
  if (exact.length === 1) return exact[0]!.posModifierId;
  const hits = left.filter((m) => {
    const need = tellingWords(choiceName(m.name));
    return need.length > 0 && need.every((w) => wordSaid(w, said));
  });
  return hits.length === 1 ? hits[0]!.posModifierId : null;
}

/**
 * The open area an address names, in the till's own spellings for it (lib pos-domain delivery-areas does the same on
 * the till): "House 12, Street 4, DHA Phase 6", "ph 6", "Clifton Block 5", "Emaar". Null when it names none, or more
 * than one ("near Clifton Block 5, DHA Phase 1"): then the customer picks from the list. "Block 5" alone names nothing
 * (it could be Gulshan's).
 */
export function zoneInText(zones: readonly FactZone[], text: string): FactZone | null {
  let left = ` ${normalizeAreaText(text)} `;
  const keys = zones
    .filter((z) => z.active)
    .flatMap((z) => [z.name, ...z.aliases].map((a) => ({ key: normalizeAreaText(a), zone: z })))
    .filter((k) => k.key !== '' && !/^(\d+|(block|blk) \d+)$/.test(k.key))
    .sort((a, b) => b.key.length - a.key.length);
  const found = new Map<string, FactZone>();
  for (const k of keys) {
    // The longest name first, and what it covered taken out: "dha phase 2 extension" is not "dha phase 2" too.
    if (!left.includes(` ${k.key} `)) continue;
    found.set(k.zone.id, k.zone);
    left = left.split(` ${k.key} `).join('  ');
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

// ---------------------------------------------------------------------------
// The steps' messages (29 Oct 2026, buttons): the printed deal menu as a picture with three tap buttons under it, then
// one short question at a time — its options as WhatsApp's own tap buttons (three or fewer) or behind one clearly named
// list button (more), the message ending with what to tap ("👇 Neeche button dabayein"). A number or a name typed
// still picks (the picture's printed numbers above all).

/** A step's messages and the options they offer, in order (what a tap sends; a number typed picks one of them too). */
interface View {
  out: WaOut[];
  choices: string[];
}

/** An option to tap: its id (what a tap sends), what the button or row says, and a row's second line. */
interface Option {
  id: string;
  title: string;
  description?: string;
}

/** WhatsApp takes 4,096 letters in a text message: a longer one goes out as more, split between its blocks. */
const TEXT_MAX = 3900;
/** The most rows in one WhatsApp list; a button's words at most 20 letters, a row's title 24. */
const LIST_ROWS = 10;
const BUTTON_WORDS = 20;
const ROW_TITLE = 24;

function texts(blocks: ReadonlyArray<string | null | undefined>): WaOut[] {
  const bodies: string[] = [];
  const add = (b: string, gap: string) => {
    const last = bodies.at(-1);
    if (last !== undefined && last.length + gap.length + b.length <= TEXT_MAX) bodies[bodies.length - 1] = `${last}${gap}${b}`;
    else bodies.push(b);
  };
  for (const b of blocks) {
    if (!b) continue;
    if (b.length <= TEXT_MAX) add(b, '\n\n');
    else b.split('\n').forEach((line, k) => add(line, k === 0 ? '\n\n' : '\n')); // a list too long for one message
  }
  return bodies.map((body) => ({ type: 'text', body }));
}

const KEYS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** Option numbers in text: big number keys (1️⃣ … 🔟) while a list has ten or fewer, plain bold numbers in a longer one. */
function keyFor(count: number): (n: number) => string {
  return count <= 10 ? (n) => KEYS[n]! : (n) => `*${n}.*`;
}

/**
 * Options as WhatsApp's own: three or fewer whose words fit a button are tap buttons under the message (`image` on
 * top when given); more, up to a list's ten, go behind one clearly named list button (`label`); more than that go as
 * numbered text. The message ends with what to tap.
 */
function tapView(body: readonly string[], options: readonly Option[], label: string, image?: string): View {
  const choices = options.map((o) => o.id);
  if (options.length > 0 && options.length <= 3 && options.every((o) => o.title.length <= BUTTON_WORDS)) {
    return {
      out: [{ type: 'buttons', body: [...body, '', '👇 *Neeche button dabayein*'].join('\n'), buttons: options.map((o) => ({ id: o.id, title: o.title })), ...(image ? { image } : {}) }],
      choices,
    };
  }
  if (options.length > 0 && options.length <= LIST_ROWS) {
    return {
      out: [
        {
          type: 'list',
          body: [...body, '', `👇 Neeche *${label}* button dabayein`].join('\n'),
          button: label,
          sections: [
            {
              title: label,
              rows: options.map((o) => ({
                id: o.id,
                title: o.title,
                // a title too long for a row is said in full under it
                ...(o.title.length > ROW_TITLE || o.description ? { description: [o.title.length > ROW_TITLE ? o.title : null, o.description].filter(Boolean).join(' · ') } : {}),
              })),
            },
          ],
        },
      ],
      choices,
    };
  }
  const key = keyFor(options.length);
  return { out: texts([[...body, '', ...options.map((o, k) => `${key(k + 1)} ${o.title}${o.description ? ` — ${o.description}` : ''}`), '', '👉 *Number* bhejein'].join('\n')]), choices };
}

/** An item's emoji: pizza (the deals are pizza-led), fries and sides, a drink, a dip, a burger. */
function emojiOf(name: string): string {
  if (/pizza/i.test(name)) return '🍕';
  if (/fries|nuggets|wings/i.test(name)) return '🍟';
  if (/drink|\bcola\b/i.test(name)) return '🥤';
  if (/\bdip\b/i.test(name)) return '🥫';
  if (/burger|crispy|nashville|dipped/i.test(name) && !/large|medium/i.test(name)) return '🍔';
  return '🍕';
}

/**
 * The website's % off a category's food on every order (lib/store-status, lib/pricing): the category's own % when it
 * has one (the regular pizzas' 20%), else the food %; the lower of pick-up's and delivery's, so it holds either way.
 */
function categoryPercent(shop: BotShop, categoryId: string): number {
  const own = (list: BotShop['pickupCategoryPercents']) => list?.find((c) => c.categoryId === categoryId)?.percent;
  const delivery = own(shop.deliveryCategoryPercents) ?? shop.deliveryPercent ?? 0;
  return shop.pickupAvailable ? Math.min(own(shop.pickupCategoryPercents) ?? shop.pickupPercent, delivery) : delivery;
}

/** An item's % off: never a deal's (the menu marks the deals no-discount: their price is already the deal). */
function offPercent(shop: BotShop, item: PublishedMenuItem): number {
  const cat = categoryOfItem(shop, item.posItemId);
  return item.noDiscount || !cat ? 0 : categoryPercent(shop, cat.id);
}

/** A price after its % off. */
function afterOff(cents: number, off: number): number {
  return Math.round((cents * (100 - off)) / 100);
}

/** In a message: the price, or with a % off the menu price struck through and the price after it in bold. */
function priceShown(cents: number, off: number): string {
  return off > 0 ? `~${formatCents(cents)}~ *${formatCents(afterOff(cents, off))}*` : formatCents(cents);
}

/** On a button or a list row (no bold or strike there): the price, with "pehle" (before) when a % is off. */
function pricePlain(cents: number, off: number): string {
  return off > 0 ? `${formatCents(afterOff(cents, off))} (pehle ${formatCents(cents)})` : formatCents(cents);
}

/** A category's name as shown: the till's "Pizza" is the regular pizzas (the signature ones have their own category). */
function categoryTitle(name: string): string {
  return /^pizzas?$/i.test(name.trim()) ? 'Regular pizza' : name;
}

/** "Fajita Pizza — Medium" and "— Large" are one family in two sizes: a category's families, in its order. */
function familiesOf(cat: BotCategory): Array<{ name: string; items: PublishedMenuItem[] }> {
  const out: Array<{ name: string; items: PublishedMenuItem[] }> = [];
  for (const i of cat.items) {
    const name = (i.name.split(' — ')[0] ?? i.name).trim();
    const f = out.find((x) => x.name === name);
    if (f) f.items.push(i);
    else out.push({ name, items: [i] });
  }
  return out;
}

/** An item's size ("Fajita Pizza — Large" → "Large"), or its name when it has none. */
function sizeOf(item: PublishedMenuItem): string {
  return item.name.split(' — ')[1]?.trim() ?? item.name;
}

/** An item's name to read on the order: "Fajita Pizza — Large" → "Fajita Pizza (Large)". */
function shownName(name: string): string {
  return name.replace(/ — (.+)$/, ' ($1)');
}

/** The picture's deals on today's menu, in its order; null when one is missing or unclear (then the deals as a list). */
function pictureDeals(shop: BotShop): PublishedMenuItem[] | null {
  const p = shop.menuPicture;
  if (!p || p.deals.length === 0) return null;
  const deals = valueDeals(shop);
  const found = p.deals.map((name) => deals.filter((i) => ` ${wordsOf(i.name).join(' ')} `.startsWith(` ${wordsOf(name).join(' ')} `)));
  return found.every((f) => f.length === 1) ? found.map((f) => f[0]!) : null;
}

/** The deals that are not Buy 1 Get 1, in the menu's order. */
function valueDeals(shop: BotShop): PublishedMenuItem[] {
  return categoriesOf(shop)
    .filter((c) => isDealSection(c.name) && !isBuy1Get1Category(c.name))
    .flatMap((c) => c.items);
}

/** The Buy 1 Get 1 deals on the menu. */
function buy1Get1Items(shop: BotShop): PublishedMenuItem[] {
  return categoriesOf(shop)
    .filter((c) => isBuy1Get1Category(c.name))
    .flatMap((c) => c.items);
}

/** Buy 1 Get 1 sells now (its deals are offered only then). */
function buy1Get1Now(shop: BotShop): boolean {
  return shop.buy1Get1Open !== false && buy1Get1Items(shop).length > 0;
}

/**
 * Where an order starts (the day's welcome, "menu", a price ask): the printed deal menu as a picture with three tap
 * buttons under it (the deals, Buy 1 Get 1 while it sells or the pizzas, the burgers); a deal's printed number typed
 * picks it. Without a picture for today's menu: the deals behind a list button.
 */
function startView(shop: BotShop, first?: string): View {
  const pictured = pictureDeals(shop);
  const b1 = buy1Get1Now(shop) ? buy1Get1Items(shop) : [];
  const b1Line = b1.length > 0 ? `🎁 Buy 1 Get 1 abhi chal raha hai${shop.buy1Get1Hours ? ` (${shop.buy1Get1Hours})` : ''}` : buy1Get1Items(shop).length > 0 && shop.buy1Get1Hours ? `🎁 Buy 1 Get 1: roz ${shop.buy1Get1Hours}` : null;
  if (shop.menuPicture && pictured) {
    const buttons: Option[] = [
      { id: 'o:deals', title: '🔥 Deals' },
      ...(b1.length > 0 ? [{ id: 'o:b1g1', title: '🎁 Buy 1 Get 1' }] : []),
      { id: 'o:pizza', title: '🍕 Pizza' },
      ...(b1.length > 0 ? [] : [{ id: 'o:burger', title: '🍔 Burger' }]),
    ];
    const v = tapView([...(first ? [first] : []), '👆 Picture mein hamari deals hain — deal ka *number* bhejein (jaise *5*)', ...(b1Line ? [b1Line] : [])], buttons, 'Chunein', shop.menuPicture.url);
    // A number typed is the deal printed with it (Buy 1 Get 1 after them while it sells).
    return { out: v.out, choices: [...pictured.map((i) => `i:${i.posItemId}`), ...b1.map((i) => `i:${i.posItemId}`)] };
  }
  return dealsView(shop, first);
}

/** The deals behind one list button, numbered as the picture numbers them, their price and contents under each. */
function dealsView(shop: BotShop, first?: string): View {
  const deals = pictureDeals(shop) ?? valueDeals(shop);
  const b1 = buy1Get1Now(shop) ? buy1Get1Items(shop) : [];
  const rows: Option[] = [
    ...deals.map((i, k) => ({ id: `i:${i.posItemId}`, title: `${k + 1}. ${i.name}`, description: [formatCents(i.basePriceCents), i.description].filter(Boolean).join(' · ') })),
    ...b1.map((i) => ({ id: `i:${i.posItemId}`, title: `🎁 ${i.name}`, description: [formatCents(i.basePriceCents), i.description].filter(Boolean).join(' · ') })),
  ];
  // a list takes ten rows: the deals first; Buy 1 Get 1 (its own button and words) and the pizzas and burgers if they fit
  const more: Option[] = [{ id: 'o:pizza', title: '🍕 Pizza' }, { id: 'o:burger', title: '🍔 Burger' }];
  const b1Cut = rows.length > LIST_ROWS && b1.length > 0;
  const kept = b1Cut ? rows.slice(0, deals.length).slice(0, LIST_ROWS) : rows.slice(0, LIST_ROWS);
  const fitted = [...kept, ...(kept.length + more.length <= LIST_ROWS ? more : [])];
  return tapView(
    [...(first ? [first, ''] : []), '🔥 *Hamari deals* (tax shamil)', ...(b1Cut ? ['🎁 Buy 1 Get 1 abhi chal raha hai — *buy 1 get 1* likhein'] : [])],
    fitted,
    'Deal chunein',
  );
}

/** Buy 1 Get 1's deals behind one list button, their price and contents under each. */
function buy1Get1View(shop: BotShop): View {
  const b1 = buy1Get1Items(shop);
  return tapView(
    [`🎁 *Buy 1 Get 1*${shop.buy1Get1Hours ? ` · roz ${shop.buy1Get1Hours}` : ''} (tax shamil)`],
    b1.map((i) => ({ id: `i:${i.posItemId}`, title: i.name, description: [formatCents(i.basePriceCents), i.description].filter(Boolean).join(' · ') })),
    'Deal chunein',
  );
}

/** The list button's words for a category or a choice: what is being chosen. */
function chooseLabel(what: string): string {
  if (/pizza/i.test(what)) return 'Pizza chunein';
  if (/burger/i.test(what)) return 'Burger chunein';
  if (/drink|flavour/i.test(what)) return 'Drink chunein';
  if (/fries|side/i.test(what)) return 'Chunein';
  return 'Chunein';
}

/**
 * Categories (the regular pizzas, the burgers, the drinks): one option per family ("Fajita Pizza", its size asked
 * next), the sizes' prices and the % off said once on top; `more`: options after them (the signature pizzas).
 */
function familyView(shop: BotShop, at: readonly number[], more: readonly Option[] = []): View {
  const cats = categoriesOf(shop);
  // the regular pizzas before the signature ones; otherwise the till's order
  const order = [...at].sort((a, b) => Number(/^pizzas?$/i.test(cats[b]!.name.trim())) - Number(/^pizzas?$/i.test(cats[a]!.name.trim())));
  const options: Option[] = [];
  const heads: string[] = [];
  for (const i of order) {
    const cat = cats[i]!;
    const families = familiesOf(cat);
    const offs = cat.items.map((x) => offPercent(shop, x));
    const off = offs.every((p) => p === offs[0]) ? (offs[0] ?? 0) : 0;
    const tax = cat.items.every((x) => x.taxIncluded) ? ' (tax shamil)' : cat.items.every((x) => !x.taxIncluded) ? ' (+ tax)' : '';
    const sizesPlain = (f: { items: PublishedMenuItem[] }) => f.items.map((x) => `${sizeOf(x)} ${formatCents(afterOff(x.basePriceCents, offPercent(shop, x)))}`).join(' · ');
    const same = families.every((f) => f.items.length > 1 && f.items.map((x) => `${sizeOf(x)}${x.basePriceCents}`).join() === families[0]!.items.map((x) => `${sizeOf(x)}${x.basePriceCents}`).join());
    heads.push(`${emojiOf(cat.items[0]?.name ?? cat.name)} *${categoryTitle(cat.name)}*${off > 0 ? ` — 🔥 *${off}% OFF*` : ''}${tax}`);
    if (same) heads.push(families[0]!.items.map((x) => `${sizeOf(x)} ${priceShown(x.basePriceCents, offPercent(shop, x))}`).join(' · '));
    for (const f of families) {
      options.push({
        id: f.items.length > 1 ? `p:${f.items[0]!.posItemId}` : `i:${f.items[0]!.posItemId}`,
        title: f.name,
        description: f.items.length > 1 ? sizesPlain(f) : pricePlain(f.items[0]!.basePriceCents, offPercent(shop, f.items[0]!)),
      });
    }
  }
  const label = chooseLabel(order.map((i) => cats[i]!.name).join(' '));
  return tapView(heads, [...options, ...more], label);
}

/** A family's sizes as tap buttons, their price after the % off on each. */
function sizeView(shop: BotShop, items: readonly PublishedMenuItem[]): View {
  const name = (items[0]?.name.split(' — ')[0] ?? '').trim();
  const off = items.length > 0 ? offPercent(shop, items[0]!) : 0;
  return tapView(
    [`${emojiOf(name)} *${name}* — kaunsa size?`, ...(off > 0 ? [`🔥 ${off}% OFF laga hua${items.some((i) => !i.taxIncluded) ? ' (+ tax)' : ''}`] : items.some((i) => !i.taxIncluded) ? ['(+ tax)'] : [])],
    items.map((i) => ({ id: `i:${i.posItemId}`, title: `${sizeOf(i)} · ${formatCents(afterOff(i.basePriceCents, offPercent(shop, i)))}` })),
    'Size chunein',
  );
}

/** The items a typed message named, with their prices, to pick one. */
function foundView(shop: BotShop, items: readonly PublishedMenuItem[]): View {
  return tapView(
    ['Ye mile 👇'],
    items.slice(0, LIST_ROWS).map((i) => ({ id: `i:${i.posItemId}`, title: shownName(i.name), description: `${pricePlain(i.basePriceCents, offPercent(shop, i))}${i.taxIncluded ? '' : ' + tax'}` })),
    'Chunein',
  );
}

/** One choice an item needs, the item and its price on top (so "Price?" at this step is answered too). */
function choiceView(shop: BotShop, item: PublishedMenuItem, group: PublishedModifierGroup, step: number, of: number, picked: readonly string[]): View {
  const left = group.modifiers.filter((m) => !picked.includes(m.posModifierId));
  const need = Math.max(1, group.minSelect) - picked.length;
  const label = groupLabelOf(group);
  const ask = need > 1 ? `${label}: koi *${need}* chunein (ek ek kar ke)` : `${label} kaunsa?`;
  return tapView(
    [`${emojiOf(item.name)} *${item.name}* — ${priceShown(item.basePriceCents, offPercent(shop, item))}${item.taxIncluded ? '' : ' + tax'} ✅`, '', `${ask}${of > 1 ? ` (${step + 1}/${of})` : ''}`],
    left.map((m) => ({ id: `m:${m.posModifierId}`, title: choiceName(m.name), ...(m.priceDeltaCents > 0 ? { description: `+${formatCents(m.priceDeltaCents)}` } : {}) })),
    chooseLabel(label),
  );
}

/** A line of the order: emoji, count, name and its price after the % off, the picks under it. */
function orderLines(shop: BotShop, line: CartLine): string[] {
  const item = itemOf(shop, line.posItemId);
  if (!item) return [];
  const picks = pickedWords(item, line.modifierIds);
  return [
    `${emojiOf(item.name)} *${line.quantity > 1 ? `${line.quantity}× ` : ''}${shownName(item.name)}* — ${priceShown(lineCents(item, line), offPercent(shop, item))}`,
    ...(picks ? [`      ${picks}`] : []),
  ];
}

/** The order so far, then Delivery, Pick-up or more as tap buttons. `note`: "added", "changed" on top. */
function cartView(shop: BotShop, data: BotData, note?: string): View {
  const options: Option[] = shop.pickupAvailable
    ? [{ id: 'f:delivery', title: '🛵 Delivery' }, { id: 'f:pickup', title: pickupTitle(shop) }, { id: 'k:add', title: '➕ Aur add karein' }]
    : [{ id: 'f:delivery', title: '🛵 Delivery' }, { id: 'k:add', title: '➕ Aur add karein' }, { id: 'k:clear', title: '🗑️ Khali karein' }];
  return tapView(
    [...(note ? [note, ''] : []), ...data.cart.flatMap((l) => orderLines(shop, l)), '', shop.pickupAvailable ? '*Delivery ya pick-up?*' : '*Delivery* ke liye button dabayein'],
    options,
    'Chunein',
  );
}

/** "🏃 Pick-up", with its % when a pick-up gets more off than a delivery. */
function pickupTitle(shop: BotShop): string {
  return `🏃 Pick-up ${shop.pickupPercent > (shop.deliveryPercent ?? 0) ? `${shop.pickupPercent}% off` : ''}`.trim();
}

/** The old bot's question after Checkout (a session saved before 27 Oct 2026 may still tap Checkout). */
function fulfilmentView(shop: BotShop): View {
  return tapView(['*Delivery ya pick-up?*'], [{ id: 'f:delivery', title: '🛵 Delivery' }, { id: 'f:pickup', title: pickupTitle(shop) }], 'Chunein');
}

function addressMessage(zone: FactZone | undefined): WaOut {
  return {
    type: 'text',
    body: zone
      ? `📍 *${zone.name}* — ghar no. aur street likh kar bhejein`
      : '📍 Apna *address* likh kar bhejein\n_(ghar no., street aur area — jaise House 12, Street 4, DHA Phase 6)_',
  };
}

/** The open areas, in the owner's groups ("DHA", "Clifton"), in order. */
function zoneGroups(shop: BotShop): Array<{ group: string; zones: FactZone[] }> {
  const groups: Array<{ group: string; zones: FactZone[] }> = [];
  for (const z of shop.zones.filter((x) => x.active)) {
    const g = groups.find((x) => x.group === z.group);
    if (g) g.zones.push(z);
    else groups.push({ group: z.group, zones: [z] });
  }
  return groups;
}

const NOT_LISTED: Option = { id: 'z:none', title: '❌ Mera area nahi hai', description: 'Pick-up karein ya staff se baat karein' };

function zoneOption(z: FactZone): Option {
  const name = zoneNameWithLocalNames(z.name);
  return {
    id: `z:${z.id}`,
    title: z.name,
    description: `${name.length > z.name.length ? `${name.slice(z.name.length).trim()} · ` : ''}${z.feeCents === 0 ? 'free delivery' : `delivery ${formatCents(z.feeCents)}`}`,
  };
}

/**
 * The open areas behind a list button: all of them when they fit one list, else their groups first ("DHA",
 * "Clifton"), then a group's areas (nine at a time, then "Aur ➡️"). "Not my area" with them.
 */
function zonesView(shop: BotShop, body = '📍 Aapka area kaunsa hai?', group?: number, page = 0): View {
  const groups = zoneGroups(shop);
  const all = groups.flatMap((g) => g.zones);
  if (group === undefined) {
    if (all.length + 1 <= LIST_ROWS) return tapView([body], [...all.map(zoneOption), NOT_LISTED], 'Area chunein');
    return tapView([body], [...groups.slice(0, LIST_ROWS - 1).map((g, gi) => ({ id: `zg:${gi}`, title: g.group, description: `${g.zones.length} areas` })), NOT_LISTED], 'Area chunein');
  }
  const zones = groups[group]?.zones ?? [];
  const rows = zones.length <= LIST_ROWS ? zones : zones.slice(page * (LIST_ROWS - 1), (page + 1) * (LIST_ROWS - 1));
  const more = zones.length > LIST_ROWS && (page + 1) * (LIST_ROWS - 1) < zones.length;
  return tapView([`📍 ${groups[group]?.group ?? ''} mein kahan?`], [...rows.map(zoneOption), ...(more ? [{ id: `zp:${group}:${page + 1}`, title: 'Aur areas ➡️' }] : [])], 'Area chunein');
}

function confirmView(shop: BotShop, data: BotData, q: Extract<OrderAnswer, { ok: true }>, phone: string): View {
  const fees = feeIds(shop);
  const lines = (q.lines ?? []).flatMap((l) => {
    if (fees.has(l.posItemId) || /delivery charge/i.test(l.name)) return [`🛵 Delivery — ${formatCents(l.unitPriceCents * l.quantity)}`];
    const item = itemOf(shop, l.posItemId);
    const picks = item ? pickedWords(item, l.modifiers.map((m) => m.posModifierId)) : '';
    return [`${emojiOf(l.name)} ${l.quantity > 1 ? `${l.quantity}× ` : ''}${shownName(l.name)} — ${formatCents(l.unitPriceCents * l.quantity)}`, ...(picks ? [`      ${picks}`] : [])];
  });
  const zone = shop.zones.find((z) => z.id === data.zoneId);
  // the area once: not again when the address already says it
  const area = zone && !normalizeAreaText(data.address ?? '').includes(normalizeAreaText(zone.name)) ? ` (${zone.name})` : '';
  return tapView(
    [
      '🧾 *Aapka order*',
      '',
      ...lines,
      ...(q.discountCents > 0 ? [`🔥 Discount — −${formatCents(q.discountCents)}`] : []),
      ...(q.taxCents > 0 ? [`Tax — ${formatCents(q.taxCents)}`] : []),
      '',
      `💰 *Total: ${formatCents(q.totalCents)}* · ${data.fulfilment === 'pickup' ? 'payment shop par' : 'cash on delivery'}`,
      data.fulfilment === 'pickup' ? '🏃 Pick-up: shop se le jayein' : `📍 ${data.address ?? ''}${area}`,
      `👤 ${data.name ?? ''} · ${phone}`,
      ...(data.notes ? [`📝 ${data.notes}`] : []),
    ],
    [
      { id: 'y:confirm', title: '✅ Order kar dein' },
      { id: 'y:edit', title: '✏️ Badlein' },
      { id: 'y:cancel', title: '❌ Cancel' },
    ],
    'Chunein',
  );
}

/** A message the step could not use (said once; after that the chat is staff's), or a tap from no list we know. */
const HELP: WaOut = {
  type: 'text',
  body: '🙏 Samajh nahi aaya.\nUpar wale *button* dabayein, ya *menu* likhein.\n👤 Staff se baat: *staff*',
};

/** "+923001234567" as the order's number. */
function phoneOf(waId: string): string {
  return `+${waId}`;
}

/** "0300 1234567" for the customer to read. */
function localOf(waId: string): string {
  return /^92\d{10}$/.test(waId) ? `0${waId.slice(2, 5)} ${waId.slice(5)}` : `+${waId}`;
}

// ---------------------------------------------------------------------------
// One message in, the next step out

export async function runBot(turn: BotTurn, saved: { state: BotState; data: BotData } | null, shop: BotShop, deps: BotDeps): Promise<BotStep> {
  let state: BotState = saved?.state ?? 'idle';
  let data: BotData = { cart: [], ...(saved?.data ?? {}) };
  const out: WaOut[] = [];
  const say = (m: WaOut) => out.push(m);
  /** A step's numbered messages: a number typed next is one of its options. */
  const offer = (v: View) => {
    out.push(...v.out);
    data.choices = v.choices;
  };
  const go = (s: BotState) => {
    state = s;
    data.nudged = false;
  };
  let id = turn.reply?.id ?? null;
  const text = (turn.text ?? '').trim();
  // A number typed for one of the last message's options is that option, as a tap was ("3", "no 3"). Several numbers
  // ("1 4 6") are read below, at the steps that take several (more than one item, a choice of five toppings).
  const typed = id ? null : numbersTyped(text);
  if (typed?.length === 1 && data.choices && data.choices.length > 0) {
    const pick = data.choices[typed[0]! - 1];
    if (!pick) {
      say({ type: 'text', body: `🙏 Ye number list mein nahi — *1* se *${data.choices.length}* tak bhejein.` });
      return { state, data, out };
    }
    id = pick;
  }

  /** Where an order starts: the deal menu picture (with the day's hello on top when there is one). */
  const showStart = (first?: string) => {
    offer(startView(shop, first));
    go('menu');
  };
  const showMenu = () => showStart();
  const showCart = (note?: string) => {
    if (data.cart.length === 0) return showMenu();
    offer(cartView(shop, data, note));
    go('cart');
  };
  const askZones = (body?: string) => {
    offer(zonesView(shop, body));
    go('zones');
  };
  /** A question answered in words (the address, a name): no numbers stand for options while it waits. */
  const askWords = (m: WaOut, s: BotState) => {
    say(m);
    delete data.choices;
    go(s);
  };
  const askAddress = () => askWords(addressMessage(shop.zones.find((z) => z.id === data.zoneId)), 'address');
  /** A message the step could not use: help, once; after that the chat is staff's. */
  const helpOnce = (show: () => void) => {
    if (data.nudged) return;
    show();
    data.nudged = true;
  };

  /** The rest of the choices the pending item needs; then into the order, and on to the cart's next item or the order. */
  const askNext = () => {
    const p = data.pending;
    const item = p ? itemOf(shop, p.posItemId) : undefined;
    if (!p || !item) return showMenu();
    const groups = askedGroups(item);
    while (p.step < groups.length) {
      const g = groups[p.step]!;
      const inGroup = g.modifiers.filter((m) => p.modifierIds.includes(m.posModifierId)).map((m) => m.posModifierId);
      if (inGroup.length >= Math.max(1, g.minSelect)) {
        p.step += 1;
        continue;
      }
      offer(choiceView(shop, item, g, p.step, groups.length, inGroup));
      return go('choice');
    }
    // The usual drink and dip (an item started before they were the bot's to pick gets them now).
    for (const g of requiredGroups(item).filter((x) => usualGroup(item, x))) {
      if (!g.modifiers.some((m) => p.modifierIds.includes(m.posModifierId))) p.modifierIds.push(...usualIds(g));
    }
    const problem = validateModifierSelection(item, p.modifierIds);
    if (problem) {
      say({ type: 'text', body: `Ye item abhi is tarah nahi ban sakta (${problem}). Menu se dobara chunein.` });
      data.pending = null;
      return showMenu();
    }
    addPending(p.quantity ?? 1);
    // From a catalog cart (or several numbers typed): on to its next item (the order once none are left).
    if (data.queue) return nextFromQueue();
    showCart('✅ *Order mein add ho gaya!*');
  };

  /** The pending item into the order (the same item with the same choices adds up). */
  const addPending = (n: number) => {
    const p = data.pending;
    if (!p) return;
    const ids = [...p.modifierIds].sort();
    const same = data.cart.find((l) => l.posItemId === p.posItemId && [...l.modifierIds].sort().join() === ids.join());
    if (same) same.quantity = Math.min(20, same.quantity + n);
    else data.cart.push({ posItemId: p.posItemId, quantity: n, modifierIds: p.modifierIds });
    data.pending = null;
    delete data.orderId;
  };

  /** An item chosen (typed, picked by number or tapped): its choices, then into the order. */
  const pickItem = (item: PublishedMenuItem, quantity?: number) => {
    data.pending = { posItemId: item.posItemId, modifierIds: startIds(item), step: 0, ...(quantity && quantity > 1 ? { quantity } : {}) };
    askNext();
  };

  /** A choice picked (by number, by name or tapped) for the pending item. */
  const pickChoice = (modifierId: string) => {
    const p = data.pending;
    const item = p ? itemOf(shop, p.posItemId) : undefined;
    const group = item ? requiredGroups(item).find((g) => g.modifiers.some((x) => x.posModifierId === modifierId)) : undefined;
    if (!p || !item || !group) return showMenu();
    const inGroup = new Set(group.modifiers.map((x) => x.posModifierId));
    if (group.selectionType === 'single' || Math.max(1, group.minSelect) === 1) {
      p.modifierIds = p.modifierIds.filter((x) => !inGroup.has(x));
    }
    if (!p.modifierIds.includes(modifierId)) p.modifierIds.push(modifierId);
    askNext();
  };

  /** "7up", "ranch" at the order or its confirm: the usual drink or dip of an item in it changed (the last item first). */
  const swapUsual = (): boolean => {
    for (const line of [...data.cart].reverse()) {
      const item = itemOf(shop, line.posItemId);
      if (!item) continue;
      for (const g of requiredGroups(item).filter((x) => usualGroup(item, x))) {
        const named = choiceNamed(g, [], text);
        if (!named) continue;
        const inGroup = new Set(g.modifiers.map((m) => m.posModifierId));
        const kept = line.modifierIds.filter((x) => inGroup.has(x) && x !== named);
        line.modifierIds = [...line.modifierIds.filter((x) => !inGroup.has(x)), named, ...kept.slice(0, Math.max(1, g.minSelect) - 1)];
        delete data.orderId;
        return true;
      }
    }
    return false;
  };

  /** A family picked ("Fajita Pizza"): its sizes, or the item itself when it comes in one. */
  const pickFamily = (firstItemId: string) => {
    const cat = categoryOfItem(shop, firstItemId);
    const family = cat ? familiesOf(cat).find((f) => f.items[0]?.posItemId === firstItemId) : undefined;
    if (!family) return showMenu();
    if (family.items.length === 1) return pickItem(family.items[0]!);
    offer(sizeView(shop, family.items));
    go('items');
  };

  /** A family's sizes are the items named ("fajita": its Medium and Large): one family, its sizes asked. */
  const oneFamily = (items: readonly PublishedMenuItem[]): boolean =>
    items.length > 1 && items.every((i) => (i.name.split(' — ')[0] ?? '').trim() === (items[0]!.name.split(' — ')[0] ?? '').trim());

  /** A catalog cart's next item: its choices asked (if it has any), then the next; the order when none are left. */
  function nextFromQueue(): void {
    while (data.queue && data.queue.length > 0) {
      const next = data.queue.shift()!;
      const item = itemOf(shop, next.posItemId);
      if (!item) {
        say({ type: 'text', body: 'Cart ka ek item ab menu par nahi, use chhor diya.' });
        continue;
      }
      data.pending = { posItemId: item.posItemId, modifierIds: startIds(item), step: 0, quantity: Math.min(20, next.quantity) };
      return askNext();
    }
    delete data.queue;
    showCart('✅ *Order mein add ho gaya!*');
  }

  const orderBody = (): Record<string, unknown> => {
    const delivery = data.fulfilment !== 'pickup';
    return {
      customerName: data.name ?? '',
      customerPhone: phoneOf(turn.waId),
      fulfilment: delivery ? 'delivery' : 'pickup',
      ...(delivery ? { addressLine: data.address ?? '', zoneId: data.zoneId } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
      ...(data.social ? { social: data.social } : {}),
      items: data.cart.map((l) => ({ posItemId: l.posItemId, quantity: l.quantity, modifierIds: l.modifierIds })),
      ...(data.token ? { waToken: data.token } : {}),
    };
  };

  /** The website could not take it: say why in its words and go back to the step that fixes it. */
  const refused = (a: Extract<OrderAnswer, { ok: false }>) => {
    if (a.error === 'buy1get1_social') {
      return askWords({ type: 'text', body: `${a.message ?? 'Buy 1 Get 1 ke liye apna Instagram ya Facebook naam chahiye.'}\nApna Instagram ya Facebook naam likhein:` }, 'social');
    }
    if (a.error === 'store_closed') {
      say({ type: 'text', body: a.message ?? shop.closedText });
      return go('cart');
    }
    if (a.error === 'outside_zone' || a.error === 'zone_paused') {
      say({ type: 'text', body: a.message ?? 'Is area mein abhi delivery nahi.' });
      delete data.zoneId;
      return askZones();
    }
    say({
      type: 'text',
      body: a.message ?? 'Ye order abhi place nahi ho saka. Order badal kar dobara koshish karein, ya *staff* likhein.',
    });
    showCart();
  };

  const quote = async () => {
    // Nothing to price (Confirm sent again after the order went through): back to the menu.
    if (data.cart.length === 0) return showStart();
    data.token ??= await deps.link();
    const q = await deps.order({ ...orderBody(), dryRun: true });
    if (!q.ok) return refused(q);
    data.orderId ??= deps.newId();
    offer(confirmView(shop, data, q, localOf(turn.waId)));
    go('confirm');
  };

  /** Delivery or pick-up known (and the area): the WhatsApp name as the order's name (asked when it is none), then the price. */
  const finish = async () => {
    data.name ??= orderName(turn.profileName) ?? undefined;
    if (!data.name) return askWords({ type: 'text', body: '👤 Order kis naam par? Apna *naam* bhejein' }, 'name');
    await quote();
  };

  const place = async () => {
    if (state !== 'confirm' || !data.orderId) return quote();
    const placed = await deps.order({ ...orderBody(), clientOrderId: data.orderId });
    if (!placed.ok) return refused(placed);
    const orderId = placed.orderId ?? data.orderId;
    deps.placed?.({ orderId, totalCents: placed.totalCents });
    say({
      type: 'text',
      body: [
        `✅ *Order ho gaya!*${data.name ? ` Shukriya ${firstName(data.name) ?? data.name}` : ' Shukriya'} 🙏`,
        '',
        `💰 ${formatCents(placed.totalCents)} · ${data.fulfilment === 'pickup' ? 'payment shop par' : 'cash on delivery'}`,
        '🍕 Kitchen confirm karte hi yahin batayenge.',
        `📦 Order dekhein: ${deps.trackUrl(orderId, localOf(turn.waId))}`,
      ].join('\n'),
    });
    data = { cart: [], ...(data.token ? { token: data.token } : {}) };
    go('idle');
  };

  const deliver = async () => {
    data.fulfilment = 'delivery';
    if (data.zoneId && data.address) return finish();
    askAddress();
  };
  const pickUp = async () => {
    data.fulfilment = 'pickup';
    delete data.zoneId;
    await finish();
  };

  /** An area named (by number, by name or tapped). */
  const chooseZone = async (zone: FactZone) => {
    data.fulfilment = 'delivery';
    data.zoneId = zone.id;
    if (data.address) return finish();
    askAddress();
  };

  /** "pizza": the regular pizzas, the signature ones one tap away; "sig": the signature ones; "burger": the burgers. */
  const showCategory = (which: 'pizza' | 'sig' | 'burger'): void => {
    const cats = categoriesOf(shop);
    const find = (test: (c: BotCategory) => boolean) => cats.map((c, i) => (test(c) ? i : -1)).filter((i) => i >= 0);
    const regular = find((c) => /^pizzas?$/i.test(c.name.trim()));
    const signature = find((c) => /signature/i.test(c.name) && /pizza/i.test(c.name));
    const at = which === 'pizza' ? (regular.length > 0 ? regular : signature) : which === 'sig' ? signature : find((c) => /burger/i.test(c.name) && !isDealSection(c.name));
    if (at.length === 0) return showMenu();
    const sigNames = signature.flatMap((i) => familiesOf(cats[i]!).map((f) => f.name));
    const more = which === 'pizza' && regular.length > 0 && signature.length > 0 ? [{ id: 'o:sig', title: '⭐ Signature pizza', description: sigNames.slice(0, 3).join(', ') }] : [];
    offer(familyView(shop, at, more));
    go('items');
  };

  /**
   * Words that ask for something: an item by name (one named goes in, unless they only ask its price), Buy 1 Get 1,
   * the deals or the offers, a category or a size, the prices or the menu. False when they ask none of these.
   * `greet`: a hello counts as asking for the menu (not in the middle of an order: there it is more likely "anyone
   * there?", for staff).
   */
  const answerWords = (greet = true): boolean => {
    const said = wordsOf(text);
    if (said.length === 0) return false;
    const priced = asksPrice(said);
    const items = itemsNamed(shop, said);
    if (items.length === 1 && !priced) {
      pickItem(items[0]!, countSaid(said));
      return true;
    }
    if (oneFamily(items)) {
      offer(sizeView(shop, items));
      go('items');
      return true;
    }
    if (items.length > 0) {
      offer(foundView(shop, items));
      go('items');
      return true;
    }
    const cats = categoriesOf(shop);
    const where = (test: (c: BotCategory) => boolean) => cats.map((c, i) => (test(c) ? i : -1)).filter((i) => i >= 0);
    const b1g1 = where((c) => isBuy1Get1Category(c.name));
    if (b1g1.length > 0 && asksBuy1Get1(text, said)) {
      offer(buy1Get1View(shop));
      go('items');
      return true;
    }
    if (said.some((w) => DEAL_WORDS.has(w))) {
      offer(dealsView(shop));
      go('menu');
      return true;
    }
    // "coke", "7up": the drinks; "medium", "large": the pizzas; "pizza": the regular ones, the signature ones a tap away.
    const named = categoriesNamed(shop, said.map((w) => (SAID_AS[w] ? 'drink' : w))).filter((i) => !isDealSection(cats[i]!.name));
    if ((named.length === 0 && said.some((w) => SIZE_WORDS.has(w))) || (named.length > 1 && named.some((i) => /^pizzas?$/i.test(cats[i]!.name.trim())))) {
      showCategory('pizza');
      return true;
    }
    if (named.length > 0) {
      offer(familyView(shop, named));
      go('items');
      return true;
    }
    if (priced || (greet && asksForMenu(said))) {
      showStart(turn.hello ?? undefined);
      return true;
    }
    return false;
  };

  // Whatever the step: start over, stop, or ask for a person.
  if (id === 'o:staff' || (!id && STAFF.test(text))) {
    say({ type: 'text', body: 'Theek hai! Hamara staff jaldi yahin jawab dega 🙏' });
    return { state: 'idle', data: { cart: data.cart }, out };
  }
  if (id === 'o:web' || (!id && WEB.test(text))) {
    data.token ??= await deps.link();
    say({ type: 'text', body: deps.websiteText(data.token) });
    return { state, data, out };
  }
  if (id === 'y:cancel' || (!id && CANCEL.test(text))) {
    say({ type: 'text', body: 'Order cancel kar diya. Jab chahein *menu* likh kar dobara order karein 🧀' });
    return { state: 'idle', data: { cart: [] }, out };
  }
  const starting = id === 'o:start' || (!id && START.test(text));
  const cart = turn.order ?? [];
  if (!shop.open && (starting || id || cart.length > 0)) {
    say({ type: 'text', body: shop.closedText });
    return { state: 'idle', data, out };
  }
  if (starting) {
    // The deal menu (an order already started stays: "cart" shows it).
    showStart(turn.hello ?? undefined);
    return { state, data, out };
  }
  if (!id && CART_WORDS.test(text)) {
    showCart();
    return { state, data, out };
  }
  // A cart from the WhatsApp catalog: each item's choices, one item at a time, then the order as usual.
  if (cart.length > 0) {
    data.pending = null;
    data.queue = [...cart];
    nextFromQueue();
    return { state, data, out };
  }

  if (id) {
    const [kind, a = '', b = ''] = id.split(':');
    switch (kind) {
      case 'o':
        // The start's buttons (the deals, Buy 1 Get 1, the pizzas, the burgers); 'o:menu' (an older list): the start.
        if (a === 'deals') {
          offer(dealsView(shop));
          go('menu');
        } else if (a === 'b1g1') {
          offer(buy1Get1View(shop));
          go('items');
        } else if (a === 'pizza' || a === 'sig' || a === 'burger') showCategory(a);
        else showMenu();
        break;
      case 'c':
      case 'cp':
        // An older list's category (and its pages): the category, all of it.
        if (categoriesOf(shop)[Number(a)]) {
          offer(familyView(shop, [Number(a)]));
          go('items');
        } else showMenu();
        break;
      case 'p':
        pickFamily(a);
        break;
      case 'i': {
        const item = itemOf(shop, a);
        if (!item) {
          say({ type: 'text', body: 'Ye item abhi menu par nahi. Kuch aur chunein 👇' });
          showMenu();
          break;
        }
        pickItem(item);
        break;
      }
      case 'm':
        pickChoice(a);
        break;
      case 'mp':
        // An older list's "more choices": they are all in the message now.
        askNext();
        break;
      case 'q':
        // The old bot's "how many" buttons.
        if (data.pending) addPending(Math.min(9, Math.max(1, Number(a) || 1)));
        showCart('✅ *Order mein add ho gaya!*');
        break;
      case 'k':
        if (a === 'add') showMenu();
        else if (a === 'clear') {
          data = { cart: [], ...(data.token ? { token: data.token } : {}) };
          say({ type: 'text', body: 'Order khali kar diya 🗑️' });
          showStart();
        } else if (a === 'checkout') {
          // The old bot's cart button.
          if (data.cart.length === 0) showStart();
          else if (shop.pickupAvailable) {
            offer(fulfilmentView(shop));
            go('fulfilment');
          } else await deliver();
        } else showCart();
        break;
      case 'f':
        if (data.cart.length === 0) showStart();
        else if (a === 'pickup' && shop.pickupAvailable) await pickUp();
        else await deliver();
        break;
      case 'zg':
      case 'zp':
        // A group of areas (and its next nine).
        if (zoneGroups(shop)[Number(a)]) {
          offer(zonesView(shop, undefined, Number(a), kind === 'zp' ? Number(b) || 0 : 0));
          go('zones');
        } else askZones();
        break;
      case 'z': {
        if (a === 'none') {
          offer(
            tapView(
              ['😔 Hamari delivery abhi in areas tak hai.'],
              [...(shop.pickupAvailable ? [{ id: 'f:pickup', title: '🏃 Pick-up' }] : []), { id: 'o:staff', title: '👤 Staff se baat' }],
              'Chunein',
            ),
          );
          break;
        }
        const zone = shop.zones.find((z) => z.id === a && z.active);
        if (!zone) {
          say({ type: 'text', body: 'Is area mein abhi delivery band hai.' });
          askZones();
          break;
        }
        await chooseZone(zone);
        break;
      }
      case 'n':
        // The old bot's name buttons.
        if (a === 'ok' && orderName(turn.profileName)) {
          data.name = orderName(turn.profileName)!;
          await quote();
        } else askWords({ type: 'text', body: '👤 Apna *naam* bhejein' }, 'name');
        break;
      case 'x':
        // The old bot's "no note" button.
        data.notes = null;
        await quote();
        break;
      case 'y':
        if (a === 'confirm') await place();
        else if (a === 'edit') {
          // Change anything: the order again, then delivery or pick-up and the address afresh.
          delete data.fulfilment;
          delete data.zoneId;
          delete data.address;
          delete data.orderId;
          showCart();
        } else await quote();
        break;
      default:
        say(HELP);
    }
    return { state, data, out };
  }

  // Words, at the steps that ask for them.
  if (state === 'address') {
    if (text.length < 5) say({ type: 'text', body: '📍 Address thora tafseel se bhejein — ghar no., street aur area' });
    else {
      data.address = text.slice(0, 300);
      data.zoneId ??= zoneInText(shop.zones, text)?.id;
      if (data.zoneId) await finish();
      else askZones();
    }
  } else if (state === 'zones') {
    const zone = zoneInText(shop.zones, text);
    if (zone) await chooseZone(zone);
    else if (!answerWords(false)) helpOnce(() => askZones());
  } else if (state === 'name') {
    if (text.length >= 2) {
      data.name = text.slice(0, 80);
      await quote();
    } else say({ type: 'text', body: '👤 Apna *naam* bhejein' });
  } else if (state === 'notes') {
    data.notes = text.slice(0, 300) || null;
    await quote();
  } else if (state === 'social') {
    if (text.length >= 2) {
      data.social = text.slice(0, 80);
      await quote();
    } else say({ type: 'text', body: 'Apna Instagram ya Facebook naam likhein:' });
  } else if (state === 'confirm') {
    if (saysYes(wordsOf(text))) await place();
    else if (swapUsual()) await quote(); // "7up" at the end changes the drink, not a note
    else if (text.length >= 2) {
      // Their words at the end go on the order as its note ("bina pyaz", "ghanti mat bajayein").
      data.notes = [data.notes, text].filter(Boolean).join(' · ').slice(0, 300);
      await quote();
    }
  } else if (state === 'choice') {
    const p = data.pending;
    const item = p ? itemOf(shop, p.posItemId) : undefined;
    const group = item && p ? askedGroups(item)[p.step] : undefined;
    if (typed && typed.length > 1 && p && group) {
      // Several numbers for a choice that takes several ("1 3 4 5 6" of the veggies), up to what it allows.
      const ids = typed.map((n) => data.choices?.[n - 1]).filter((x): x is string => !!x?.startsWith('m:')).map((x) => x.slice(2));
      if (ids.length === 0) helpOnce(() => askNext());
      else if (group.selectionType === 'single' || Math.max(1, group.minSelect) === 1) pickChoice(ids[0]!);
      else {
        const room = Math.max(1, group.maxSelect) - group.modifiers.filter((m) => p.modifierIds.includes(m.posModifierId)).length;
        for (const x of ids.slice(0, room)) if (!p.modifierIds.includes(x)) p.modifierIds.push(x);
        askNext();
      }
    } else {
      const named = group && p ? choiceNamed(group, p.modifierIds, text) : null;
      if (named) pickChoice(named);
      else if (asksPrice(wordsOf(text))) askNext(); // its question again: the item's price is on top of it
      else if (!answerWords(false)) helpOnce(() => askNext());
    }
  } else if (state === 'cart' || state === 'qty' || state === 'fulfilment') {
    const said = wordsOf(text);
    const count = COUNT.exec(said.join(' '));
    const last = data.cart.at(-1);
    if (count && (last || data.pending)) {
      const n = Math.min(20, Math.max(1, Number(count[1])));
      if (data.pending) addPending(n);
      else if (last) last.quantity = n;
      delete data.orderId;
      showCart();
    } else if (swapUsual()) showCart('✅ Badal diya');
    else if (said.some((w) => ['delivery', 'deliver', 'ghar', 'home'].includes(w))) await deliver();
    else if (shop.pickupAvailable && said.some((w) => ['pickup', 'pick', 'khud', 'takeaway'].includes(w))) await pickUp();
    else if (!answerWords(false)) helpOnce(() => say(HELP));
  } else if (state === 'menu' || state === 'items') {
    const picks = typed && typed.length > 1 ? typed.map((n) => data.choices?.[n - 1]).filter((x): x is string => !!x?.startsWith('i:')) : [];
    if (picks.length > 0) {
      // Several items at once ("1 4 6"): each one's choices in turn, as a catalog cart's.
      data.pending = null;
      data.queue = picks.map((x) => ({ posItemId: x.slice(2), quantity: 1 }));
      nextFromQueue();
    } else if (!answerWords()) helpOnce(() => say(HELP));
  } else if (state === 'idle') {
    // A chat the bot is not in hears from it only when it asks for the prices, the deals or the menu (lib/whatsapp-bot-run).
    answerWords();
  }
  return { state, data, out };
}
