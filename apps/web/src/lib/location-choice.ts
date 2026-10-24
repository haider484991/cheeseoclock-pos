import type { WebFulfilment } from '@cheeseoclock/shared-types';
import { parsePin, type LocationPin } from './checkout-extras';
import { STORAGE_KEYS, readStored, writeStored } from './device-memory';

/**
 * What the landing location popup (components/location/LocationGate) asked a customer, and
 * remembers on this phone (the user, 24 Oct 2026: "location selection when user landed on the
 * website … select location and confirm"): delivery to one of the owner's areas, or pick-up.
 *
 * The menu reads it (OrderingApp: the checkout opens on that choice), the header shows it
 * (LocationChip) and a change made anywhere reaches both at once ('coc:location').
 *
 * A pin from the phone's GPS rides along, but only for PIN_FRESH_MS: the checkout's own pin field
 * never remembers a pin (a pin from last time would send the rider to the wrong place), so an
 * older one is dropped here too.
 */

export const LOCATION_KEY = 'coc.location';
/** This visit's "not now" (sessionStorage): the popup stays shut until the next visit. */
export const LOCATION_DISMISSED_KEY = 'coc.location.dismissed';
/** Fired on window when the choice is saved here; another tab hears it as a 'storage' event. */
export const LOCATION_EVENT = 'coc:location';
/** Fired on window to open the popup (the header chip). */
export const LOCATION_OPEN_EVENT = 'coc:location-open';
/** A pin is offered to the checkout for this long after the phone gave it. */
export const PIN_FRESH_MS = 2 * 60 * 60_000;

export interface LocationChoice {
  fulfilment: WebFulfilment;
  /** A delivery's area (the owner's zone id); null for a pick-up. */
  zoneId: string | null;
  pin: LocationPin | null;
  /** When the phone gave the pin (ms); null without one. */
  pinAt: number | null;
  /** When the customer confirmed (ms). */
  at: number;
}

const ZONE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** A stored choice, or null for anything that is not one. */
export function parseLocationChoice(raw: string | null | undefined): LocationChoice | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o['fulfilment'] !== 'delivery' && o['fulfilment'] !== 'pickup') return null;
  if (!isTime(o['at'])) return null;
  const zoneId = typeof o['zoneId'] === 'string' && o['zoneId'].length <= 40 && ZONE_ID.test(o['zoneId']) ? o['zoneId'] : null;
  // A delivery means nothing without its area.
  if (o['fulfilment'] === 'delivery' && zoneId === null) return null;
  const pin = parsePin(o['pin']);
  return {
    fulfilment: o['fulfilment'],
    zoneId: o['fulfilment'] === 'pickup' ? null : zoneId,
    pin,
    pinAt: pin && isTime(o['pinAt']) ? o['pinAt'] : null,
    at: o['at'],
  };
}

export function serializeLocationChoice(choice: LocationChoice): string {
  return JSON.stringify(choice);
}

/** The pin to offer now: one the phone gave within PIN_FRESH_MS, else null. */
export function freshPin(choice: LocationChoice | null, nowMs: number = Date.now()): LocationPin | null {
  if (!choice?.pin || choice.pinAt === null) return null;
  const age = nowMs - choice.pinAt;
  return age >= 0 && age <= PIN_FRESH_MS ? choice.pin : null;
}

/** This phone's choice (null: none, unreadable, or on the server). */
export function readLocationChoice(): LocationChoice | null {
  return parseLocationChoice(readStored(LOCATION_KEY));
}

/**
 * Saves the choice, and tells the page: a delivery's area also goes where the menu has always
 * remembered it (STORAGE_KEYS.zone), so a menu that predates this still opens on it.
 */
export function saveLocationChoice(choice: LocationChoice): void {
  writeStored(LOCATION_KEY, serializeLocationChoice(choice));
  if (choice.fulfilment === 'delivery' && choice.zoneId) writeStored(STORAGE_KEYS.zone, choice.zoneId);
  try {
    window.dispatchEvent(new CustomEvent<LocationChoice>(LOCATION_EVENT, { detail: choice }));
  } catch {
    // No window (server) or no CustomEvent: nothing listens there.
  }
}

/** Hears every saved choice: this tab's ('coc:location') and another tab's ('storage'). Returns the unsubscribe. */
export function onLocationChoice(listener: (choice: LocationChoice | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const here = (e: Event) => listener(parseLocationChoice(JSON.stringify((e as CustomEvent<unknown>).detail ?? null)));
  const there = (e: StorageEvent) => {
    if (e.key === LOCATION_KEY) listener(parseLocationChoice(e.newValue));
  };
  window.addEventListener(LOCATION_EVENT, here);
  window.addEventListener('storage', there);
  return () => {
    window.removeEventListener(LOCATION_EVENT, here);
    window.removeEventListener('storage', there);
  };
}

/** Asks the popup to open (the header chip). */
export function openLocationPicker(): void {
  try {
    window.dispatchEvent(new Event(LOCATION_OPEN_EVENT));
  } catch {
    // No window: nothing to open.
  }
}

export function wasDismissedThisVisit(): boolean {
  try {
    return window.sessionStorage.getItem(LOCATION_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissForThisVisit(): void {
  try {
    window.sessionStorage.setItem(LOCATION_DISMISSED_KEY, '1');
  } catch {
    // Storage blocked: it may ask again on the next page, which is harmless.
  }
}

/** The pages the popup never opens on by itself: an order's tracking page and the owner's dashboard. */
export function isQuietPath(pathname: string | null | undefined): boolean {
  return typeof pathname === 'string' && /^\/+(track|dashboard)(\/|$)/i.test(pathname);
}

/** Whether to open the popup by itself on this page: no choice yet, not shut this visit, not a quiet page. */
export function shouldAsk(pathname: string | null | undefined, choice: LocationChoice | null, dismissed: boolean): boolean {
  return !isQuietPath(pathname) && choice === null && !dismissed;
}

/** Great-circle distance in km (the pin to the shop). */
export function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
