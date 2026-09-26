import type { WebFulfilment } from '@cheeseoclock/shared-types';
import { parseSavedLines, type SavedLine } from './cart';

/**
 * What the ordering page remembers on the customer's own phone, and nowhere
 * else: their details (only when they ticked "remember"), the cart they were
 * building, and their last order (to track it again or order it again).
 *
 * localStorage can be missing, full, or throw on every call (private mode,
 * blocked site data, an in-app browser), so every access is wrapped and the
 * page works the same with nothing stored. The parse functions are pure and
 * treat stored values as untrusted: a malformed or out-of-date value reads as
 * nothing.
 */

export const STORAGE_KEYS = {
  /** Pre-dates the rest: the delivery area alone. Still read as a fallback. */
  zone: 'coc.zone',
  details: 'coc.details',
  cart: 'coc.cart',
  lastOrder: 'coc.lastOrder',
  /** Lines the tracking page asked the menu to put back in the cart. */
  reorder: 'coc.reorder',
} as const;

/** A half-built cart survives a closed tab for this long, then starts fresh. */
export const CART_TTL_MS = 12 * 60 * 60_000;
/** The last order is offered to "order again" for this long. */
export const LAST_ORDER_TTL_MS = 30 * 24 * 60 * 60_000;
/** …and offered to "track" while it can still be on its way. */
export const TRACKABLE_MS = 6 * 60 * 60_000;
/** A tracking page's "order again" hand-off is picked up within this window. */
export const REORDER_TTL_MS = 10 * 60_000;

export function readStored(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or storage full — the page just won't remember this.
  }
}

export function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// ---------------------------------------------------------------------------

export interface SavedDetails {
  name: string;
  phone: string;
  address: string;
  zoneId: string;
}

export function parseDetails(raw: string | null): SavedDetails | null {
  const o = parseJson(raw);
  if (!o) return null;
  const d: SavedDetails = {
    name: str(o['name'], 80),
    phone: str(o['phone'], 20),
    address: str(o['address'], 300),
    zoneId: str(o['zoneId'], 40),
  };
  return d.name || d.phone || d.address || d.zoneId ? d : null;
}

export function serializeDetails(d: SavedDetails): string {
  return JSON.stringify({ v: 1, name: d.name, phone: d.phone, address: d.address, zoneId: d.zoneId });
}

// ---------------------------------------------------------------------------

/** The cart as saved: lines plus when, so an old one is not revived days later. */
export function parseCartSnapshot(raw: string | null, now: number = Date.now()): SavedLine[] {
  const o = parseJson(raw);
  if (!o) return [];
  const savedAt = typeof o['savedAt'] === 'number' ? o['savedAt'] : NaN;
  if (!Number.isFinite(savedAt) || now - savedAt > CART_TTL_MS || savedAt - now > 60_000) return [];
  return parseSavedLines(o['lines']);
}

export function serializeCartSnapshot(lines: readonly SavedLine[], now: number = Date.now()): string {
  return JSON.stringify({ v: 1, savedAt: now, lines });
}

// ---------------------------------------------------------------------------

export interface LastOrder {
  orderId: string;
  /** The number the order was placed with — the tracking page needs it. */
  phone: string;
  placedAt: number;
  fulfilment: WebFulfilment;
  lines: SavedLine[];
}

const ORDER_ID = /^[0-9a-f-]{36}$/i;

export function parseLastOrder(raw: string | null, now: number = Date.now()): LastOrder | null {
  const o = parseJson(raw);
  if (!o) return null;
  const orderId = str(o['orderId'], 36);
  const phone = str(o['phone'], 20);
  const placedAt = typeof o['placedAt'] === 'number' ? o['placedAt'] : NaN;
  if (!ORDER_ID.test(orderId) || !phone || !Number.isFinite(placedAt)) return null;
  if (now - placedAt > LAST_ORDER_TTL_MS) return null;
  return {
    orderId,
    phone,
    placedAt,
    fulfilment: o['fulfilment'] === 'pickup' ? 'pickup' : 'delivery',
    lines: parseSavedLines(o['lines']),
  };
}

export function serializeLastOrder(o: LastOrder): string {
  return JSON.stringify({ v: 1, ...o });
}

/** Recent enough that it may still be cooking or on the way. */
export function isTrackable(o: LastOrder, now: number = Date.now()): boolean {
  return now - o.placedAt >= -60_000 && now - o.placedAt < TRACKABLE_MS;
}

// ---------------------------------------------------------------------------

export function parseReorder(raw: string | null, now: number = Date.now()): SavedLine[] {
  const o = parseJson(raw);
  if (!o) return [];
  const at = typeof o['at'] === 'number' ? o['at'] : NaN;
  if (!Number.isFinite(at) || Math.abs(now - at) > REORDER_TTL_MS) return [];
  return parseSavedLines(o['lines']);
}

export function serializeReorder(lines: readonly SavedLine[], now: number = Date.now()): string {
  return JSON.stringify({ v: 1, at: now, lines });
}
