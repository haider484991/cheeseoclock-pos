import type { PublishedMenu, PublishedMenuItem, WebFulfilment } from '@cheeseoclock/shared-types';
import { isLeaveOutChoice } from '@cheeseoclock/shared-types';
import { isDeliveryChargeItem } from './delivery-zones';
import { formatCents } from './format';
import { optionLabel, sizeLabel, splitSizedName } from './menu-view';
import { validateModifierSelection } from './order-validation';

/**
 * The website cart, as pure functions so the ordering page, the saved cart
 * and "order again" all agree on what a line is.
 *
 * A line is one till item + its chosen modifier ids + its kitchen note. Two
 * adds of the same thing merge into one line; a different note or choice is a
 * different line (the kitchen ticket has to tell them apart).
 */

/** The server's per-line cap (api/orders OrderItemSchema). */
export const MAX_LINE_QTY = 50;
/** The server's line-count cap. */
export const MAX_LINES = 50;
/** The server's per-item note cap. */
export const MAX_NOTE_LENGTH = 300;

export interface CartLine {
  /** posItemId + sorted modifier ids + note — merges identical lines. */
  key: string;
  item: PublishedMenuItem;
  /** Card name + size, e.g. "Fajita Pizza · Large 12"". */
  label: string;
  quantity: number;
  modifierIds: string[];
  /** The item's allergy / special request; prints on the kitchen ticket. */
  notes: string | null;
}

/** A cart line as it is kept on the device: ids only, re-read against the live menu. */
export interface SavedLine {
  posItemId: string;
  quantity: number;
  modifierIds: string[];
  notes: string | null;
}

export function cartLineKey(posItemId: string, modifierIds: readonly string[], notes: string | null): string {
  return `${posItemId}|${[...modifierIds].sort().join(',')}|${notes ?? ''}`;
}

/** "Fajita Pizza — Large" → "Fajita Pizza · Large 12"" (what the cart and the ticket show). */
export function itemLabel(item: Pick<PublishedMenuItem, 'name'>): string {
  const { base, size } = splitSizedName(item.name);
  return size ? `${base} · ${sizeLabel(size)}` : base;
}

function clampQty(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAX_LINE_QTY, Math.floor(n)));
}

function cleanNote(notes: string | null | undefined): string | null {
  const t = (notes ?? '').trim().slice(0, MAX_NOTE_LENGTH);
  return t.length > 0 ? t : null;
}

/**
 * Add a line, merging with an identical one. The merged quantity stops at the
 * server's cap — past it the whole order would be refused at checkout.
 */
export function addLine(cart: readonly CartLine[], line: Omit<CartLine, 'key'>): CartLine[] {
  const notes = cleanNote(line.notes);
  const key = cartLineKey(line.item.posItemId, line.modifierIds, notes);
  const existing = cart.find((l) => l.key === key);
  if (existing) {
    return cart.map((l) => (l.key === key ? { ...l, quantity: clampQty(l.quantity + line.quantity) } : l));
  }
  if (cart.length >= MAX_LINES) return [...cart];
  return [...cart, { ...line, key, notes, quantity: clampQty(line.quantity) }];
}

/** Set a line's quantity; zero or less removes it. */
export function setLineQty(cart: readonly CartLine[], key: string, qty: number): CartLine[] {
  if (qty <= 0) return cart.filter((l) => l.key !== key);
  return cart.map((l) => (l.key === key ? { ...l, quantity: clampQty(qty) } : l));
}

const modifierIndexCache = new WeakMap<PublishedMenuItem, Map<string, { name: string; priceDeltaCents: number }>>();

/** posModifierId → modifier, cached per menu item (the menu object never changes under us). */
export function modifierIndex(item: PublishedMenuItem): Map<string, { name: string; priceDeltaCents: number }> {
  let idx = modifierIndexCache.get(item);
  if (!idx) {
    idx = new Map(item.modifierGroups.flatMap((g) => g.modifiers.map((m) => [m.posModifierId, m] as const)));
    modifierIndexCache.set(item, idx);
  }
  return idx;
}

/** One of the line's items with its chosen modifiers (the server re-prices the same way). */
export function lineUnitPriceCents(line: Pick<CartLine, 'item' | 'modifierIds'>): number {
  const mods = modifierIndex(line.item);
  return line.item.basePriceCents + line.modifierIds.reduce((s, id) => s + (mods.get(id)?.priceDeltaCents ?? 0), 0);
}

export function cartCount(cart: readonly CartLine[]): number {
  return cart.reduce((s, l) => s + l.quantity, 0);
}

export function cartSubtotalCents(cart: readonly CartLine[]): number {
  return cart.reduce((s, l) => s + lineUnitPriceCents(l) * l.quantity, 0);
}

/**
 * A line's choices as the customer reads them, leave-outs apart (they are the
 * allergy-relevant ones and print as "NO ONION" on the ticket).
 */
export function lineChoices(line: Pick<CartLine, 'item' | 'modifierIds'>): { leaveOuts: string[]; others: string[] } {
  const mods = modifierIndex(line.item);
  const names = line.modifierIds
    .map((id) => mods.get(id)?.name)
    .filter((n): n is string => Boolean(n))
    .map(optionLabel);
  return {
    leaveOuts: names.filter(isLeaveOutChoice),
    others: names.filter((n) => !isLeaveOutChoice(n)),
  };
}

export function toSavedLines(cart: readonly CartLine[]): SavedLine[] {
  return cart.map((l) => ({
    posItemId: l.item.posItemId,
    quantity: l.quantity,
    modifierIds: [...l.modifierIds],
    notes: l.notes,
  }));
}

/**
 * Untrusted JSON (localStorage, another tab, an old version of this page) →
 * well-formed saved lines. Anything malformed is skipped, never thrown.
 */
export function parseSavedLines(value: unknown): SavedLine[] {
  if (!Array.isArray(value)) return [];
  const out: SavedLine[] = [];
  for (const v of value.slice(0, MAX_LINES)) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r['posItemId'] !== 'string' || r['posItemId'].length === 0) continue;
    const qty = typeof r['quantity'] === 'number' ? r['quantity'] : NaN;
    if (!Number.isFinite(qty) || qty < 1) continue;
    const ids = Array.isArray(r['modifierIds']) ? r['modifierIds'] : [];
    if (!ids.every((id): id is string => typeof id === 'string')) continue;
    out.push({
      posItemId: r['posItemId'],
      quantity: clampQty(qty),
      modifierIds: ids.slice(0, 30),
      notes: typeof r['notes'] === 'string' ? cleanNote(r['notes']) : null,
    });
  }
  return out;
}

/**
 * Saved lines → cart lines against today's menu. A line whose item left the
 * menu, whose choices no longer exist on it, or whose choices no longer meet
 * its rules (a new required dip, say) is dropped rather than half-restored —
 * the customer re-adds it through the item sheet. Delivery-charge items are
 * never restored: the server adds the fee from the area.
 */
export function restoreLines(
  menu: PublishedMenu,
  saved: readonly SavedLine[],
): { lines: CartLine[]; dropped: number } {
  const items = new Map<string, PublishedMenuItem>();
  for (const c of menu.categories) {
    for (const i of c.items) if (!isDeliveryChargeItem(i)) items.set(i.posItemId, i);
  }
  let lines: CartLine[] = [];
  let dropped = 0;
  for (const s of saved) {
    const item = items.get(s.posItemId);
    if (!item) {
      dropped++;
      continue;
    }
    const known = modifierIndex(item);
    if (!s.modifierIds.every((id) => known.has(id)) || validateModifierSelection(item, s.modifierIds) !== null) {
      dropped++;
      continue;
    }
    lines = addLine(lines, {
      item,
      label: itemLabel(item),
      quantity: s.quantity,
      modifierIds: [...s.modifierIds],
      notes: s.notes,
    });
  }
  return { lines, dropped };
}

/** A short "2 × Big Two, Fajita Pizza · Large 12" +1 more" for a saved order. */
export function linesSummary(menu: PublishedMenu, saved: readonly SavedLine[], max = 2): string {
  const { lines } = restoreLines(menu, saved);
  const parts = lines.slice(0, max).map((l) => (l.quantity > 1 ? `${l.quantity} × ${l.label}` : l.label));
  const more = lines.length - max;
  return more > 0 ? `${parts.join(', ')} +${more} more` : parts.join(', ');
}

/**
 * The cart as a WhatsApp message, for when the till is not taking website
 * orders: the customer can still send exactly what they picked. Names come
 * from the (brand-free) published menu; the shop confirms the total.
 */
export function whatsappOrderText(
  cart: readonly CartLine[],
  opts: {
    fulfilment: WebFulfilment;
    areaName?: string | null;
    name?: string | null;
    address?: string | null;
  },
): string {
  const rows = cart.map((l) => {
    const { leaveOuts, others } = lineChoices(l);
    const choices = [...others, ...leaveOuts];
    const extra = choices.length > 0 ? ` (${choices.join(', ')})` : '';
    const note = l.notes ? ` — note: ${l.notes}` : '';
    return `• ${l.quantity} × ${l.label}${extra}${note}`;
  });
  const out = ["Hi Cheese O'Clock! I'd like to order:", ...rows];
  out.push(`Items: ${formatCents(cartSubtotalCents(cart))} (before tax${opts.fulfilment === 'delivery' ? ' and delivery' : ''})`);
  if (opts.fulfilment === 'pickup') {
    out.push('I will pick it up from the shop.');
  } else if (opts.areaName) {
    out.push(`Delivery to: ${opts.areaName}`);
  }
  const name = opts.name?.trim();
  const address = opts.address?.trim();
  if (name) out.push(`Name: ${name}`);
  if (opts.fulfilment === 'delivery' && address) out.push(`Address: ${address}`);
  return out.join('\n');
}
