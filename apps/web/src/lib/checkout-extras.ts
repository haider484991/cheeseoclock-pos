import { buy1Get1NoteLine } from '@cheeseoclock/shared-types';

/**
 * The two optional extras the checkout adds to an order (owner, 5 Oct 2026: "add social media and
 * location pin on the checkout address so people pin their location too"):
 *
 *  - a LOCATION PIN a delivery customer takes with one tap (the phone's GPS): lat/lng and how close the phone says
 *    it is. It rides to the till as a Google Maps link in the order's notes, because the notes are what every till
 *    already shows and prints — a new field would mean a new till release;
 *  - the customer's INSTAGRAM / FACEBOOK handle, for the Tag-us offer (they post, tag the shop, show the post):
 *    the same way, as "Social: @handle".
 *
 * Both are optional and never get in the way of an order: whatever does not read as one is dropped (not refused),
 * and the customer's own notes are what gives way when the notes run out of room.
 *
 * Pure and unit-tested (checkout-extras.test.ts); the browser's location call is components/ordering/LocationPinField.
 */

export interface LocationPin {
  lat: number;
  lng: number;
  /** How close the phone says it is, in metres (rounded); null when it did not say. */
  accuracyM: number | null;
}

/** The till caps an order's notes at 500 and prefixes "[web] ": stay under it (api/orders). */
export const ORDER_NOTES_MAX = 490;
/** A handle or a link: "@ahmed_k", "instagram.com/ahmed.k", "Ahmed Khan (facebook)". */
export const SOCIAL_MAX = 80;

const round = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals;

/**
 * A pin as the browser sent it, or null when it is not one: two finite numbers inside the globe, and not
 * 0,0 ("null island", what a broken GPS reports). Six decimals (about 10 cm) and whole metres: nothing more
 * precise than a phone can say.
 */
export function parsePin(raw: unknown): LocationPin | null {
  if (!raw || typeof raw !== 'object') return null;
  const { lat, lng, accuracyM } = raw as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  const accuracy =
    typeof accuracyM === 'number' && Number.isFinite(accuracyM) && accuracyM >= 0 ? Math.min(Math.round(accuracyM), 100_000) : null;
  return { lat: round(lat, 6), lng: round(lng, 6), accuracyM: accuracy };
}

/** The pin on Google Maps: opens the map app on a phone, a page on a desktop. */
export function pinUrl(pin: Pick<LocationPin, 'lat' | 'lng'>): string {
  return `https://maps.google.com/?q=${pin.lat.toFixed(6)},${pin.lng.toFixed(6)}`;
}

/** What the order's notes say of the pin: "Map pin: https://maps.google.com/?q=24.808354,67.068452 (about 25 m)". */
export function pinLine(pin: LocationPin): string {
  return `Map pin: ${pinUrl(pin)}${pin.accuracyM ? ` (about ${pin.accuracyM} m)` : ''}`;
}

/**
 * A social handle or link as typed, made safe to print: control characters and angle brackets become spaces,
 * runs of spaces one, at most SOCIAL_MAX characters. Null when under two characters (a stray "@").
 */
export function cleanSocial(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SOCIAL_MAX).trim();
  return text.length >= 2 ? text : null;
}

/**
 * The order's notes: the map pin, then the social handle, then what the customer (and the checkout's own
 * reminders) wrote — all in one line, under `max`. When it does not fit, the end is cut: the pin and the handle
 * are first, so it is the customer's words that give way. Null when there is nothing to say.
 */
export function composeNotes(
  parts: {
    pin: LocationPin | null;
    social: string | null;
    notes: string | null;
    /**
     * A Buy 1 Get 1 deal is on the order (7 Oct 2026): the handle leads the notes as "Buy 1 Get 1: check the post by
     * @x" (shared-types buy1Get1NoteLine), so the cashier knows whose post to check, before the pin — or, with no
     * name (the owner made it optional), "Buy 1 Get 1: ask to see the post".
     */
    buy1Get1?: boolean;
  },
  max: number = ORDER_NOTES_MAX,
): string | null {
  const deal = parts.buy1Get1 === true;
  const head = [
    deal ? buy1Get1NoteLine(parts.social) : null,
    parts.pin ? pinLine(parts.pin) : null,
    parts.social && !deal ? `Social: ${parts.social}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join('. ');
  const rest = parts.notes?.trim() || '';
  const all = head && rest ? `${head}. ${rest}` : head || rest;
  return all ? all.slice(0, max) : null;
}
