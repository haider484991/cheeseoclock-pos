import {
  groupDisplayName,
  isFixedChoiceGroup,
  type PublishedMenu,
  type PublishedMenuItem,
  type PublishedModifierGroup,
} from '@cheeseoclock/shared-types';
import { zoneNameWithLocalNames, type FactZone } from './delivery-facts';
import { formatCents } from './format';
import { isPickupOnly } from './menu-view';
import { validateModifierSelection } from './order-validation';
import type { WaOut } from './whatsapp-send';

/**
 * The WhatsApp ordering bot (26 Oct 2026, the user: "customers chat with bot and select menu and confirm order there").
 * A customer orders inside the chat with WhatsApp's tap-to-pick lists and buttons: a category, an item, each choice the
 * item needs (a deal's pizzas, drink, dip — its fixed parts come with it, as on the website), how many, then delivery
 * or pick-up, the area, the address, the name and a note. Before they confirm, the website's own order route prices it
 * (api/orders dryRun), so the total they see is the till's; confirming places it there like a website order (the
 * personal link token marks it as WhatsApp's), and the till pulls it as any other.
 *
 * Pure apart from what `deps` does: one customer message in, the next step and the messages to send out. The route
 * keeps the step (lib/whatsapp-store wa_sessions) and sends the messages (lib/whatsapp-send).
 */

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
   * The item being put together: its choices so far and which of its required choices is being asked; `quantity` when
   * it came in a catalog cart (how many is already known).
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
  /** Re-asked once after a message the step could not use; after that the bot keeps quiet for staff. */
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
  /** The day's link message (the "Website" button). */
  websiteText(token: string): string;
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

/** A word that starts, stops or hands over an order whatever the step ("menu", "cancel", "staff"). */
export function isBotCommand(text: string): boolean {
  const t = text.trim();
  return START.test(t) || CANCEL.test(t) || STAFF.test(t);
}

/** The bot's first message of the day to a customer while the shop is open (the route sends it). */
export function welcomeMessage(o: { shopName: string; profileName: string | null }): WaOut {
  const name = firstName(o.profileName);
  return {
    type: 'buttons',
    body: [
      `Assalam o Alaikum${name ? ` ${name}` : ''}! ${o.shopName} mein khush aamdeed 🧀`,
      'Yahin WhatsApp par order karein: menu se chunein, hum seedha kitchen bhej denge.',
    ].join('\n'),
    buttons: [
      { id: 'o:start', title: '🍕 Order karein' },
      { id: 'o:web', title: '🌐 Website' },
      { id: 'o:staff', title: '👤 Staff se baat' },
    ],
  };
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

/** A line's price before tax and charges: the item and its choices, times how many. */
function lineCents(item: PublishedMenuItem, line: CartLine): number {
  const deltas = item.modifierGroups
    .flatMap((g) => g.modifiers)
    .filter((m) => line.modifierIds.includes(m.posModifierId))
    .reduce((sum, m) => sum + m.priceDeltaCents, 0);
  return (item.basePriceCents + deltas) * line.quantity;
}

/** The choices the customer made on a line, in words ("Large pizza: Fajita · Drink: Cola"). */
function choiceWords(item: PublishedMenuItem, ids: readonly string[]): string {
  return requiredGroups(item)
    .map((g) => {
      const picked = g.modifiers.filter((m) => ids.includes(m.posModifierId)).map((m) => m.name);
      return picked.length ? `${groupDisplayName(g.name).replace(/^Deal:\s*/i, '')}: ${picked.join(', ')}` : null;
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
// The steps' messages

function menuMessage(shop: BotShop, data: BotData): WaOut {
  const cats = categoriesOf(shop);
  const withCart = data.cart.length > 0;
  const rows = cats.slice(0, withCart ? 9 : 10).map((c, i) => ({
    id: `c:${i}`,
    title: c.name,
    description: `${c.items.length} items · ${formatCents(Math.min(...c.items.map((x) => x.basePriceCents)))} se`,
  }));
  if (withCart) rows.push({ id: 'k:cart', title: `🛒 Mera order (${countOf(data)})`, description: 'Order dekhein aur checkout karein' });
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
        rows: [
          ...rows.map((i) => ({
            id: `i:${i.posItemId}`,
            title: i.name,
            description: `${i.name.length > 24 ? `${i.name} · ` : ''}${priceWords(i)}${isPickupOnly(i) ? ' · sirf pick-up' : ''}`,
          })),
          ...(more ? [{ id: `cp:${cat}:${page + 1}`, title: 'Aur dekhein ➡️', description: 'Is category ke baaqi items' }] : []),
        ],
      },
    ],
  };
}

function choiceMessage(item: PublishedMenuItem, group: PublishedModifierGroup, step: number, of: number, picked: readonly string[], page: number): WaOut {
  const left = group.modifiers.filter((m) => !picked.includes(m.posModifierId));
  const { rows, more } = paged(left, page);
  const need = Math.max(1, group.minSelect);
  const label = groupDisplayName(group.name).replace(/^Deal:\s*/i, '');
  return {
    type: 'list',
    body: `*${item.name}*\n${label} chunein${need > 1 ? ` (${need} chahiye)` : ''} — ${step + 1}/${of}`,
    button: 'Chunein',
    sections: [
      {
        title: label,
        rows: [
          ...rows.map((m) => ({
            id: `m:${m.posModifierId}`,
            title: m.name,
            ...(m.priceDeltaCents > 0 ? { description: `+${formatCents(m.priceDeltaCents)}` } : {}),
          })),
          ...(more ? [{ id: `mp:${page + 1}`, title: 'Aur dekhein ➡️' }] : []),
        ],
      },
    ],
  };
}

function qtyMessage(item: PublishedMenuItem): WaOut {
  return {
    type: 'buttons',
    body: `*${item.name}* — kitne chahiye?`,
    buttons: [
      { id: 'q:1', title: '1' },
      { id: 'q:2', title: '2' },
      { id: 'q:3', title: '3' },
    ],
  };
}

function countOf(data: BotData): number {
  return data.cart.reduce((n, l) => n + l.quantity, 0);
}

function cartMessage(shop: BotShop, data: BotData): WaOut {
  let total = 0;
  const lines = data.cart.flatMap((l) => {
    const item = itemOf(shop, l.posItemId);
    if (!item) return [];
    const cents = lineCents(item, l);
    total += cents;
    const choices = choiceWords(item, l.modifierIds);
    return [`${l.quantity}× ${item.name} — ${formatCents(cents)}`, ...(choices ? [`   ↳ ${choices}`] : [])];
  });
  return {
    type: 'buttons',
    body: ['🛒 *Aapka order*', ...lines, '', `Items: ${formatCents(total)}`, 'Tax aur delivery agle step mein.'].join('\n'),
    buttons: [
      { id: 'k:add', title: '➕ Aur add karein' },
      { id: 'k:checkout', title: '✅ Checkout' },
      { id: 'k:clear', title: '🗑️ Clear' },
    ],
  };
}

function fulfilmentMessage(shop: BotShop): WaOut {
  return {
    type: 'buttons',
    body: 'Delivery ya pick-up?',
    buttons: [
      { id: 'f:delivery', title: '🛵 Delivery' },
      { id: 'f:pickup', title: `🏃 Pick-up ${shop.pickupPercent > 0 ? `${shop.pickupPercent}% off` : ''}`.trim() },
    ],
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

function zonesMessage(shop: BotShop): WaOut {
  const groups = zoneGroups(shop);
  const all = groups.flatMap((g) => g.zones);
  if (all.length <= 9) {
    return { type: 'list', body: '🛵 Delivery kahan karni hai? Area chunein:', button: 'Area chunein', sections: [{ title: 'Areas', rows: [...all.map(zoneRow), NOT_LISTED_ROW] }] };
  }
  return {
    type: 'list',
    body: '🛵 Delivery kahan karni hai? Pehle area chunein:',
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

function nameMessage(profileName: string | null): WaOut {
  const n = orderName(profileName);
  if (!n) return { type: 'text', body: '👤 Order kis naam par? Apna naam likhein:' };
  return {
    type: 'buttons',
    body: '👤 Order kis naam par?',
    buttons: [
      { id: 'n:ok', title: `✅ ${n}` },
      { id: 'n:edit', title: '✏️ Naya naam' },
    ],
  };
}

const NOTES_MESSAGE: WaOut = {
  type: 'buttons',
  body: '📝 Koi khaas hidayat? Jaise extra ketchup, bina pyaz, ya ghar ki nishani. Likh dein, ya neeche dabayein:',
  buttons: [{ id: 'x:none', title: 'Koi note nahi' }],
};

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
  body: 'Upar di gayi list ya buttons se chunein 👆 Shuru se karna ho to *menu* likhein; hamare staff se baat ke liye *staff* likhein.',
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

  const showMenu = () => {
    say(menuMessage(shop, data));
    go('menu');
  };
  const showCart = () => {
    if (data.cart.length === 0) return showMenu();
    say(cartMessage(shop, data));
    go('cart');
  };
  const askZones = () => {
    say(zonesMessage(shop));
    go('zones');
  };
  const askName = () => {
    say(nameMessage(turn.profileName));
    go('name');
  };
  const askNotes = () => {
    say(NOTES_MESSAGE);
    go('notes');
  };

  /** The rest of the choices the pending item needs, then how many. */
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
    // From a catalog cart: how many is known — into the order, and on to the cart's next item.
    if (p.quantity) {
      addPending(p.quantity);
      return nextFromQueue();
    }
    say(qtyMessage(item));
    go('qty');
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
      return askZones();
    }
    say({
      type: 'text',
      body: a.message ?? 'Ye order abhi place nahi ho saka. Order badal kar dobara koshish karein, ya *staff* likhein.',
    });
    showCart();
  };

  const quote = async () => {
    data.token ??= await deps.link();
    const q = await deps.order({ ...orderBody(), dryRun: true });
    if (!q.ok) return refused(q);
    data.orderId ??= deps.newId();
    say(confirmMessage(shop, data, q, localOf(turn.waId)));
    go('confirm');
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
    showMenu();
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
        data.pending = { posItemId: item.posItemId, modifierIds: startIds(item), step: 0 };
        askNext();
        break;
      }
      case 'm': {
        const p = data.pending;
        const item = p ? itemOf(shop, p.posItemId) : undefined;
        const group = item ? requiredGroups(item).find((g) => g.modifiers.some((x) => x.posModifierId === a)) : undefined;
        if (!p || !item || !group) {
          showMenu();
          break;
        }
        const inGroup = new Set(group.modifiers.map((x) => x.posModifierId));
        if (group.selectionType === 'single' || Math.max(1, group.minSelect) === 1) {
          p.modifierIds = p.modifierIds.filter((x) => !inGroup.has(x));
        }
        if (!p.modifierIds.includes(a)) p.modifierIds.push(a);
        askNext();
        break;
      }
      case 'mp':
        askNext(Number(a));
        break;
      case 'q':
        if (data.pending) addPending(Math.min(9, Math.max(1, Number(a) || 1)));
        showCart();
        break;
      case 'k':
        if (a === 'add') showMenu();
        else if (a === 'clear') {
          data = { cart: [], ...(data.token ? { token: data.token } : {}) };
          say({ type: 'text', body: 'Order khali kar diya 🗑️' });
          showMenu();
        } else if (a === 'checkout') {
          if (data.cart.length === 0) showMenu();
          else if (shop.pickupAvailable) {
            say(fulfilmentMessage(shop));
            go('fulfilment');
          } else {
            data.fulfilment = 'delivery';
            askZones();
          }
        } else showCart();
        break;
      case 'f':
        if (a === 'pickup' && shop.pickupAvailable) {
          data.fulfilment = 'pickup';
          delete data.zoneId;
          askName();
        } else {
          data.fulfilment = 'delivery';
          askZones();
        }
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
        data.fulfilment = 'delivery';
        data.zoneId = zone.id;
        say({ type: 'text', body: `📍 ${zone.name} — apna poora address likhein (house no., street, koi nishani):` });
        go('address');
        break;
      }
      case 'n':
        if (a === 'ok' && orderName(turn.profileName)) {
          data.name = orderName(turn.profileName)!;
          askNotes();
        } else {
          say({ type: 'text', body: '👤 Apna naam likhein:' });
          go('name');
        }
        break;
      case 'x':
        data.notes = null;
        await quote();
        break;
      case 'y':
        if (a === 'confirm' && state === 'confirm' && data.orderId) {
          const placed = await deps.order({ ...orderBody(), clientOrderId: data.orderId });
          if (!placed.ok) {
            refused(placed);
            break;
          }
          const orderId = placed.orderId ?? data.orderId;
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
        } else if (a === 'edit') showCart();
        else await quote();
        break;
      default:
        say(NUDGE);
    }
    return { state, data, out };
  }

  // Words, at the steps that ask for them.
  if (state === 'address') {
    if (text.length >= 5) {
      data.address = text.slice(0, 300);
      askName();
    } else say({ type: 'text', body: 'Address thora tafseel se likhein — house no. aur street:' });
  } else if (state === 'name') {
    if (text.length >= 2) {
      data.name = text.slice(0, 80);
      askNotes();
    } else say({ type: 'text', body: '👤 Apna naam likhein:' });
  } else if (state === 'notes') {
    data.notes = text.slice(0, 300) || null;
    await quote();
  } else if (state === 'social') {
    if (text.length >= 2) {
      data.social = text.slice(0, 80);
      await quote();
    } else say({ type: 'text', body: 'Apna Instagram ya Facebook naam likhein:' });
  } else if (state !== 'idle' && !data.nudged) {
    // A question in the middle of an order: point at the buttons once, then leave the chat to staff.
    say(NUDGE);
    data.nudged = true;
  }
  return { state, data, out };
}
