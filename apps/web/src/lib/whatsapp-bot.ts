import {
  groupDisplayName,
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
}

/** What the bot knows of the shop for this message (the route reads it). */
export interface BotShop {
  /** What customers can order: no drink brand, Buy 1 Get 1 only while for sale. */
  menu: PublishedMenu;
  zones: readonly FactZone[];
  open: boolean;
  pickupAvailable: boolean;
  pickupPercent: number;
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
/** "2", "2x", "2 deals": a count on its own. */
const COUNT = /^(\d{1,2})x?( (deals?|pizzas?|burgers?|plates?|drinks?|dips?|pcs|pieces?))?$/;
/**
 * A hello, or an ask for the menu, the prices or "more info" — Meta's own words when an ad is tapped ("Hello! Can I get
 * more info on this?"): the menu, never "not understood".
 */
const MENU_ASK = new Set(['hello', 'helo', 'hey', 'salam', 'slam', 'aoa', 'menu', 'info', 'information', 'details', 'detail', 'price', 'prices', 'rate', 'rates', 'list', 'deal', 'deals']);
function asksForMenu(said: readonly string[]): boolean {
  return said.length > 0 && said.length <= 12 && said.some((w) => MENU_ASK.has(w) || /^hi+$/.test(w) || /^as+a?lam/.test(w));
}

/** A word that starts, stops or hands over an order whatever the step ("menu", "cancel", "staff"). */
export function isBotCommand(text: string): boolean {
  const t = text.trim();
  return START.test(t) || CANCEL.test(t) || STAFF.test(t);
}

/**
 * The bot's first message of the day to a customer while the shop is open (the route sends it): the menu itself,
 * with a hello.
 */
export function welcomeMessage(o: { shopName: string; profileName: string | null; shop: BotShop }): WaOut {
  const name = firstName(o.profileName);
  return startMessage(o.shop, `Assalam o Alaikum${name ? ` ${name}` : ''}! ${o.shopName} mein khush aamdeed 🧀`);
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

/** The categories a customer can order from, with their items (no delivery charges). */
function categoriesOf(shop: BotShop): Array<{ name: string; items: PublishedMenuItem[] }> {
  const fees = feeIds(shop);
  return shop.menu.categories
    .filter((c) => !/delivery charge/i.test(c.name))
    .map((c) => ({ name: c.name, items: c.items.filter((i) => !fees.has(i.posItemId)) }))
    .filter((c) => c.items.length > 0);
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

/** What an item starts with, as the website's sheet does: its fixed parts, and the till's defaults where nothing is asked. */
function startIds(item: PublishedMenuItem): string[] {
  const asked = new Set(requiredGroups(item).map((g) => g.posGroupId));
  return item.modifierGroups.flatMap((g) =>
    isFixedChoiceGroup(g)
      ? g.modifiers.map((m) => m.posModifierId)
      : asked.has(g.posGroupId)
        ? []
        : g.modifiers.filter((m) => m.isDefault).map((m) => m.posModifierId),
  );
}

function priceWords(item: PublishedMenuItem): string {
  return `${formatCents(item.basePriceCents)}${item.taxIncluded ? ' · tax shamil' : ' + tax'}`;
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

/** The choices the customer made on a line, in words ("Large pizza: Fajita · Drink: Pepsi"). */
function choiceWords(item: PublishedMenuItem, ids: readonly string[]): string {
  return requiredGroups(item)
    .map((g) => {
      const picked = g.modifiers.filter((m) => ids.includes(m.posModifierId)).map((m) => choiceName(m.name));
      return picked.length ? `${groupLabelOf(g)}: ${picked.join(', ')}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}

const PAGE = 9;

/** Rows for one list page: nine and a "More" row when there are more than ten. */
function paged<T>(all: readonly T[], page: number): { rows: T[]; more: boolean } {
  if (all.length <= 10) return { rows: [...all], more: false };
  const rows = all.slice(page * PAGE, page * PAGE + PAGE);
  return { rows, more: (page + 1) * PAGE < all.length };
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
// The steps' messages

function itemRow(i: PublishedMenuItem) {
  return {
    id: `i:${i.posItemId}`,
    title: i.name,
    description: [i.name.length > 24 ? i.name : null, priceWords(i), isPickupOnly(i) ? 'sirf pick-up' : null, i.description].filter(Boolean).join(' · '),
  };
}

/**
 * Where an order starts (the day's welcome, "menu", the "Order karein" button of the old welcome): the deals
 * themselves, one pick away, then the full menu, the website and staff — at most ten rows, as WhatsApp allows.
 */
function startMessage(shop: BotShop, first?: string): WaOut {
  const cats = categoriesOf(shop);
  const at = cats.findIndex((c) => isDealSection(c.name));
  const deals = at >= 0 ? cats[at]!.items : [];
  const shown = deals.length <= 7 ? deals : deals.slice(0, 6);
  const example = deals[0]?.name;
  const others = cats.filter((_, i) => i !== at).map((c) => c.name);
  return {
    type: 'list',
    body: [
      ...(first ? [first] : []),
      `👇 *Menu* dabayein aur deal chunein${example ? ` — ya jo chahiye likh dein, jaise _${example}_` : ''}.`,
    ].join('\n'),
    button: '📋 Menu',
    sections: [
      ...(shown.length > 0
        ? [
            {
              title: cats[at]!.name,
              rows: [
                ...shown.map(itemRow),
                ...(shown.length < deals.length ? [{ id: `c:${at}`, title: 'Aur deals ➡️', description: `Saari ${deals.length} deals` }] : []),
              ],
            },
          ]
        : []),
      {
        title: 'Aur',
        rows: [
          { id: 'o:menu', title: '📋 Poora menu', description: others.join(', ') || 'Saare items' },
          { id: 'o:web', title: '🌐 Website se order', description: 'Photos ke saath menu, aapka naam aur number pehle se bhara' },
          { id: 'o:staff', title: '👤 Staff se baat', description: 'Koi sawal ho to hamara staff jawab dega' },
        ],
      },
    ],
  };
}

function countOf(data: BotData): number {
  return data.cart.reduce((n, l) => n + l.quantity, 0);
}

function menuMessage(shop: BotShop, data: BotData): WaOut {
  const cats = categoriesOf(shop);
  const withCart = data.cart.length > 0;
  const rows = cats.slice(0, withCart ? 9 : 10).map((c, i) => ({
    id: `c:${i}`,
    title: c.name,
    description: `${c.items.length} items · ${formatCents(Math.min(...c.items.map((x) => x.basePriceCents)))} se`,
  }));
  if (withCart) rows.push({ id: 'k:cart', title: `🛒 Mera order (${countOf(data)})`, description: 'Order dekhein, phir delivery ya pick-up' });
  return { type: 'list', body: 'Kya khayenge? Category chunein 👇', button: 'Menu dekhein', sections: [{ title: 'Menu', rows }] };
}

function itemsMessage(shop: BotShop, cat: number, page: number): WaOut | null {
  const c = categoriesOf(shop)[cat];
  if (!c) return null;
  const { rows, more } = paged(c.items, page);
  return {
    type: 'list',
    body: `*${c.name}* — kya lenge?`,
    button: 'Items dekhein',
    sections: [
      {
        title: c.name,
        rows: [...rows.map(itemRow), ...(more ? [{ id: `cp:${cat}:${page + 1}`, title: 'Aur dekhein ➡️', description: 'Is category ke baaqi items' }] : [])],
      },
    ],
  };
}

/** The items a typed message named, to pick one: buttons when their names fit on them, else a list. */
function foundMessage(items: readonly PublishedMenuItem[]): WaOut {
  if (items.length <= 3 && items.every((i) => i.name.length <= 20)) {
    return {
      type: 'buttons',
      body: ['Inmein se kaunsa? 👇', ...items.map((i) => `• ${i.name} — ${priceWords(i)}`)].join('\n'),
      buttons: items.map((i) => ({ id: `i:${i.posItemId}`, title: i.name })),
    };
  }
  return { type: 'list', body: 'Ye mile — kaunsa chahiye? 👇', button: 'Chunein', sections: [{ title: 'Mile', rows: items.slice(0, 10).map(itemRow) }] };
}

/** One choice an item needs: buttons when there are three or fewer and their names fit, else a list. */
function choiceMessage(item: PublishedMenuItem, group: PublishedModifierGroup, step: number, of: number, picked: readonly string[], page: number): WaOut {
  const left = group.modifiers.filter((m) => !picked.includes(m.posModifierId));
  const need = Math.max(1, group.minSelect);
  const label = groupLabelOf(group);
  const body = `*${item.name}*\n${label} chunein${need > 1 ? ` (${need} chahiye)` : ''}${of > 1 ? ` — ${step + 1}/${of}` : ''}`;
  const title = (m: PublishedModifierGroup['modifiers'][number]) => `${choiceName(m.name)}${m.priceDeltaCents > 0 ? ` +${formatCents(m.priceDeltaCents)}` : ''}`;
  if (left.length <= 3 && need - (group.modifiers.length - left.length) <= 1 && left.every((m) => title(m).length <= 20)) {
    return { type: 'buttons', body, buttons: left.map((m) => ({ id: `m:${m.posModifierId}`, title: title(m) })) };
  }
  const { rows, more } = paged(left, page);
  return {
    type: 'list',
    body,
    button: 'Chunein',
    sections: [
      {
        title: label,
        rows: [
          ...rows.map((m) => ({
            id: `m:${m.posModifierId}`,
            title: choiceName(m.name),
            ...(m.priceDeltaCents > 0 ? { description: `+${formatCents(m.priceDeltaCents)}` } : {}),
          })),
          ...(more ? [{ id: `mp:${page + 1}`, title: 'Aur dekhein ➡️' }] : []),
        ],
      },
    ],
  };
}

/**
 * The order so far, and the next step on its buttons: Delivery or Pick-up (or more items). `added` when an item has
 * just gone in. The last line's count changes by typing a number.
 */
function cartMessage(shop: BotShop, data: BotData, added: boolean): WaOut {
  let total = 0;
  const lines = data.cart.flatMap((l) => {
    const item = itemOf(shop, l.posItemId);
    if (!item) return [];
    const cents = lineCents(item, l);
    total += cents;
    const choices = choiceWords(item, l.modifierIds);
    return [`${l.quantity}× ${item.name} — ${formatCents(cents)}`, ...(choices ? [`   ↳ ${choices}`] : [])];
  });
  const last = data.cart.at(-1);
  const lastName = last ? itemOf(shop, last.posItemId)?.name : undefined;
  return {
    type: 'buttons',
    body: [
      ...(added ? ['✅ Order mein add ho gaya!'] : []),
      '🛒 *Aapka order*',
      ...lines,
      `Items: ${formatCents(total)} (delivery aur tax agle step mein)`,
      ...(lastName ? ['', `_${lastName} ek se zyada chahiye? Number likh dein, jaise 2._`] : []),
      '',
      shop.pickupAvailable ? '*Delivery ya pick-up?* 👇' : 'Order ke liye *🛵 Delivery* dabayein 👇',
    ].join('\n'),
    buttons: shop.pickupAvailable
      ? [
          { id: 'f:delivery', title: '🛵 Delivery' },
          { id: 'f:pickup', title: pickupTitle(shop) },
          { id: 'k:add', title: '➕ Aur add karein' },
        ]
      : [
          { id: 'f:delivery', title: '🛵 Delivery' },
          { id: 'k:add', title: '➕ Aur add karein' },
          { id: 'k:clear', title: '🗑️ Clear' },
        ],
  };
}

function pickupTitle(shop: BotShop): string {
  return `🏃 Pick-up ${shop.pickupPercent > 0 ? `${shop.pickupPercent}% off` : ''}`.trim();
}

/** The old bot's question after Checkout (a session saved before 27 Oct 2026 may still tap Checkout). */
function fulfilmentMessage(shop: BotShop): WaOut {
  return {
    type: 'buttons',
    body: 'Delivery ya pick-up?',
    buttons: [
      { id: 'f:delivery', title: '🛵 Delivery' },
      { id: 'f:pickup', title: pickupTitle(shop) },
    ],
  };
}

function addressMessage(zone: FactZone | undefined): WaOut {
  return {
    type: 'text',
    body: zone
      ? `📍 ${zone.name} — ghar no. aur street likh dein:`
      : '📍 Delivery address likh dein — ghar no., street aur area\n(jaise: House 12, Street 4, DHA Phase 6)',
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

const NOT_LISTED_ROW = { id: 'z:none', title: 'Mera area nahi hai', description: 'Pick-up karein ya staff se baat karein' };

function zoneRow(z: FactZone) {
  const name = zoneNameWithLocalNames(z.name);
  return {
    id: `z:${z.id}`,
    title: z.name,
    description: `${name.length > z.name.length ? `${name.slice(z.name.length).trim()} · ` : ''}${z.feeCents === 0 ? 'Free delivery' : `Delivery ${formatCents(z.feeCents)}`}`,
  };
}

function zonesMessage(shop: BotShop, body = '🛵 Delivery kahan karni hai? Area chunein:'): WaOut {
  const groups = zoneGroups(shop);
  const all = groups.flatMap((g) => g.zones);
  if (all.length <= 9) {
    return { type: 'list', body, button: 'Area chunein', sections: [{ title: 'Areas', rows: [...all.map(zoneRow), NOT_LISTED_ROW] }] };
  }
  return {
    type: 'list',
    body,
    button: 'Area chunein',
    sections: [
      {
        title: 'Areas',
        rows: [...groups.slice(0, 9).map((g, i) => ({ id: `zg:${i}`, title: g.group, description: `${g.zones.length} areas` })), NOT_LISTED_ROW],
      },
    ],
  };
}

function zonesInGroupMessage(shop: BotShop, gi: number, page: number): WaOut | null {
  const g = zoneGroups(shop)[gi];
  if (!g) return null;
  const { rows, more } = paged(g.zones, page);
  return {
    type: 'list',
    body: `🛵 ${g.group} mein kahan?`,
    button: 'Area chunein',
    sections: [{ title: g.group, rows: [...rows.map(zoneRow), ...(more ? [{ id: `zp:${gi}:${page + 1}`, title: 'Aur dekhein ➡️' }] : [])] }],
  };
}

function confirmMessage(shop: BotShop, data: BotData, q: Extract<OrderAnswer, { ok: true }>, phone: string): WaOut {
  const lines = (q.lines ?? []).flatMap((l) => {
    const item = itemOf(shop, l.posItemId);
    const choices = item ? choiceWords(item, l.modifiers.map((m) => m.posModifierId)) : '';
    return [`${l.quantity}× ${l.name} — ${formatCents(l.unitPriceCents * l.quantity)}`, ...(choices ? [`   ↳ ${choices}`] : [])];
  });
  const zone = shop.zones.find((z) => z.id === data.zoneId);
  const where = data.fulfilment === 'pickup' ? '🏃 Pick-up: shop se le jayein' : `🛵 ${zone?.name ?? ''} · ${data.address ?? ''}`;
  return {
    type: 'buttons',
    body: [
      '🧾 *Aapka order*',
      ...lines,
      '',
      `Subtotal ${formatCents(q.subtotalCents)}`,
      ...(q.discountCents > 0 ? [`Discount −${formatCents(q.discountCents)}`] : []),
      ...(q.taxCents > 0 ? [`Tax ${formatCents(q.taxCents)}`] : []),
      `*Total ${formatCents(q.totalCents)}* · ${data.fulfilment === 'pickup' ? 'payment shop par' : 'cash on delivery'}`,
      '',
      where,
      `👤 ${data.name ?? ''} · ${phone}`,
      ...(data.notes ? [`📝 ${data.notes}`] : []),
      '',
      '_Kuch kehna ho (jaise bina pyaz)? Yahin likh dein._',
    ].join('\n'),
    buttons: [
      { id: 'y:confirm', title: '✅ Confirm order' },
      { id: 'y:edit', title: '✏️ Badlein' },
      { id: 'y:cancel', title: '❌ Cancel' },
    ],
  };
}

const NUDGE: WaOut = {
  type: 'text',
  body: 'Neeche di gayi list ya buttons se chunein 👇 Shuru se karna ho to *menu* likhein; hamare staff se baat ke liye *staff* likhein.',
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
  const go = (s: BotState) => {
    state = s;
    data.nudged = false;
  };
  const id = turn.reply?.id ?? null;
  const text = (turn.text ?? '').trim();

  const showStart = (first?: string) => {
    say(startMessage(shop, first));
    go('menu');
  };
  const showMenu = () => {
    say(menuMessage(shop, data));
    go('menu');
  };
  const showCart = (added = false) => {
    if (data.cart.length === 0) return showMenu();
    say(cartMessage(shop, data, added));
    go('cart');
  };
  const askZones = (body?: string) => {
    say(zonesMessage(shop, body));
    go('zones');
  };
  const askAddress = () => {
    say(addressMessage(shop.zones.find((z) => z.id === data.zoneId)));
    go('address');
  };
  /** A message the step could not use: its own question again, once; after that the chat is staff's. */
  const helpOnce = (show: () => void) => {
    if (data.nudged) return;
    show();
    data.nudged = true;
  };

  /** The rest of the choices the pending item needs; then into the order, and on to the cart's next item or the order. */
  const askNext = (page = 0) => {
    const p = data.pending;
    const item = p ? itemOf(shop, p.posItemId) : undefined;
    if (!p || !item) return showMenu();
    const groups = requiredGroups(item);
    while (p.step < groups.length) {
      const g = groups[p.step]!;
      const inGroup = g.modifiers.filter((m) => p.modifierIds.includes(m.posModifierId)).map((m) => m.posModifierId);
      if (inGroup.length >= Math.max(1, g.minSelect)) {
        p.step += 1;
        continue;
      }
      say(choiceMessage(item, g, p.step, groups.length, inGroup, page));
      return go('choice');
    }
    const problem = validateModifierSelection(item, p.modifierIds);
    if (problem) {
      say({ type: 'text', body: `Ye item abhi is tarah nahi ban sakta (${problem}). Menu se dobara chunein.` });
      data.pending = null;
      return showMenu();
    }
    addPending(p.quantity ?? 1);
    // From a catalog cart: on to its next item (the order once none are left).
    if (data.queue) return nextFromQueue();
    showCart(true);
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

  /** An item chosen (tapped or named): its choices, then into the order. */
  const pickItem = (item: PublishedMenuItem, quantity?: number) => {
    data.pending = { posItemId: item.posItemId, modifierIds: startIds(item), step: 0, ...(quantity && quantity > 1 ? { quantity } : {}) };
    askNext();
  };

  /** A choice picked (tapped or named) for the pending item. */
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
    showCart();
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
      say({ type: 'text', body: `${a.message ?? 'Buy 1 Get 1 ke liye apna Instagram ya Facebook naam chahiye.'}\nApna Instagram ya Facebook naam likhein:` });
      return go('social');
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
    // Nothing to price (Confirm tapped again after the order went through): back to the menu.
    if (data.cart.length === 0) return showStart();
    data.token ??= await deps.link();
    const q = await deps.order({ ...orderBody(), dryRun: true });
    if (!q.ok) return refused(q);
    data.orderId ??= deps.newId();
    say(confirmMessage(shop, data, q, localOf(turn.waId)));
    go('confirm');
  };

  /** Delivery or pick-up known (and the area): the WhatsApp name as the order's name (asked when it is none), then the price. */
  const finish = async () => {
    data.name ??= orderName(turn.profileName) ?? undefined;
    if (!data.name) {
      say({ type: 'text', body: '👤 Order kis naam par? Apna naam likhein:' });
      return go('name');
    }
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
        `✅ Shukriya${data.name ? ` ${firstName(data.name) ?? data.name}` : ''}! Aapka order place ho gaya.`,
        `Total ${formatCents(placed.totalCents)} · ${data.fulfilment === 'pickup' ? 'payment shop par' : 'cash on delivery'}`,
        'Kitchen confirm karte hi hum yahin bata denge.',
        `Order dekhein: ${deps.trackUrl(orderId, localOf(turn.waId))}`,
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

  /** An area named (tapped, or read from what they typed). */
  const chooseZone = async (zone: FactZone) => {
    data.fulfilment = 'delivery';
    data.zoneId = zone.id;
    if (data.address) return finish();
    askAddress();
  };

  /** Words where an item is chosen: an item's name, a category's, a hello; else help once. */
  const findFromWords = () => {
    const said = wordsOf(text);
    const items = itemsNamed(shop, said);
    if (items.length === 1) return pickItem(items[0]!, countSaid(said));
    if (items.length > 1) {
      say(foundMessage(items));
      return go('items');
    }
    if (asksForMenu(said)) return showStart();
    // "coke", "7up": the drinks.
    const cats = categoriesNamed(shop, said.map((w) => (SAID_AS[w] ? 'drink' : w)));
    if (cats.length === 1) {
      const m = itemsMessage(shop, cats[0]!, 0);
      if (m) {
        say(m);
        return go('items');
      }
    }
    if (cats.length > 1) return showMenu();
    helpOnce(() => showStart('🙏 Ye samajh nahi aaya. Neeche menu se chunein — koi sawal ho to likh dein, staff jawab dega.'));
  };

  // Whatever the step: start over, stop, or ask for a person.
  if (id === 'o:staff' || (!id && STAFF.test(text))) {
    say({ type: 'text', body: 'Theek hai! Hamara staff jaldi yahin jawab dega 🙏' });
    return { state: 'idle', data: { cart: data.cart }, out };
  }
  if (id === 'o:web') {
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
    if (data.cart.length > 0) showMenu();
    else showStart();
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
        // 'o:menu': the full menu.
        showMenu();
        break;
      case 'c': {
        const m = itemsMessage(shop, Number(a), 0);
        if (m) {
          say(m);
          go('items');
        } else showMenu();
        break;
      }
      case 'cp': {
        const m = itemsMessage(shop, Number(a), Number(b));
        if (m) say(m);
        else showMenu();
        break;
      }
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
        askNext(Number(a));
        break;
      case 'q':
        // The old bot's "how many" buttons.
        if (data.pending) addPending(Math.min(9, Math.max(1, Number(a) || 1)));
        showCart(true);
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
            say(fulfilmentMessage(shop));
            go('fulfilment');
          } else await deliver();
        } else showCart();
        break;
      case 'f':
        if (data.cart.length === 0) showStart();
        else if (a === 'pickup' && shop.pickupAvailable) await pickUp();
        else await deliver();
        break;
      case 'zg': {
        const m = zonesInGroupMessage(shop, Number(a), 0);
        if (m) say(m);
        else askZones();
        break;
      }
      case 'zp': {
        const m = zonesInGroupMessage(shop, Number(a), Number(b));
        if (m) say(m);
        else askZones();
        break;
      }
      case 'z': {
        if (a === 'none') {
          say({
            type: 'buttons',
            body: 'Hamari delivery abhi upar wale areas tak hai. Pick-up kar sakte hain, ya hamare staff se baat karein.',
            buttons: [
              ...(shop.pickupAvailable ? [{ id: 'f:pickup', title: '🏃 Pick-up' }] : []),
              { id: 'o:staff', title: '👤 Staff se baat' },
            ],
          });
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
        } else {
          say({ type: 'text', body: '👤 Apna naam likhein:' });
          go('name');
        }
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
        say(NUDGE);
    }
    return { state, data, out };
  }

  // Words, at the steps that ask for them.
  if (state === 'address') {
    if (text.length < 5) say({ type: 'text', body: 'Address thora tafseel se likhein — ghar no., street aur area:' });
    else {
      data.address = text.slice(0, 300);
      data.zoneId ??= zoneInText(shop.zones, text)?.id;
      if (data.zoneId) await finish();
      else askZones('📍 Aapka area kaunsa hai? List se chunein:');
    }
  } else if (state === 'zones') {
    const zone = zoneInText(shop.zones, text);
    if (zone) await chooseZone(zone);
    else helpOnce(() => askZones('📍 Neeche list se apna area chunein:'));
  } else if (state === 'name') {
    if (text.length >= 2) {
      data.name = text.slice(0, 80);
      await quote();
    } else say({ type: 'text', body: '👤 Apna naam likhein:' });
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
    else if (text.length >= 2) {
      // Their words at the end go on the order as its note ("bina pyaz", "ghanti mat bajayein").
      data.notes = [data.notes, text].filter(Boolean).join(' · ').slice(0, 300);
      await quote();
    }
  } else if (state === 'choice') {
    const p = data.pending;
    const item = p ? itemOf(shop, p.posItemId) : undefined;
    const group = item && p ? requiredGroups(item)[p.step] : undefined;
    const named = group && p ? choiceNamed(group, p.modifierIds, text) : null;
    if (named) pickChoice(named);
    else helpOnce(() => askNext());
  } else if (state === 'cart' || state === 'qty' || state === 'fulfilment') {
    const said = wordsOf(text);
    const count = COUNT.exec(said.join(' '));
    const last = data.cart.at(-1);
    if (count && (last || data.pending)) {
      const n = Math.min(20, Math.max(1, Number(count[1])));
      if (data.pending) addPending(n);
      else if (last) last.quantity = n;
      delete data.orderId;
      showCart(false);
    } else if (said.some((w) => ['delivery', 'deliver', 'ghar', 'home'].includes(w))) await deliver();
    else if (shop.pickupAvailable && said.some((w) => ['pickup', 'pick', 'khud', 'takeaway'].includes(w))) await pickUp();
    else findFromWords();
  } else if (state === 'menu' || state === 'items') {
    findFromWords();
  }
  return { state, data, out };
}
