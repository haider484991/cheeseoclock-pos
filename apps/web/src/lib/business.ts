/**
 * Static business facts shown across the site. The published menu's `store`
 * block (pushed from POS branding) overrides these where present — these are
 * the fallbacks so the site renders sensibly before the first publish.
 *
 * IMPORTANT (local SEO): name, address and phone here must stay
 * character-identical to the Google Business Profile listing. This object
 * feeds the footer NAP, the JSON-LD Restaurant graph and the delivery pages —
 * one source of truth, zero drift.
 */
export const BUSINESS = {
  name: "Cheese O'Clock",
  tagline: 'Gourmet pizza & fast food — it’s always Cheese O’Clock.',
  // Matches the Google Business Profile listing (verified 27 Jul 2026).
  phoneDisplay: '0300 9367865',
  phoneE164: '+923009367865',

  // WhatsApp ordering line. Currently the same number as the call line above,
  // but kept as its own field so a dedicated WhatsApp line can be split off
  // without touching the NAP. Keep all three in sync: display, E.164, wa.me.
  whatsappDisplay: '0300 9367865',
  whatsappE164: '+923009367865',
  whatsappUrl: 'https://wa.me/923009367865',
  addressLine: 'Phase 6, DHA, Karachi',
  hours: 'Open daily · 12pm – 2am',
  openingDate: '15 June 2026',

  // --- Structured address (keep in sync with GBP, char-for-char) ---------
  // TODO: set streetAddress to the exact GBP string once the listing is live
  // (e.g. "Shop 4, Bukhari Commercial Lane 2, Phase 6 DHA").
  streetAddress: 'Phase 6, DHA',
  locality: 'Karachi',
  region: 'Sindh',
  postalCode: '75500',
  country: 'PK',

  // TODO: replace with the exact kitchen pin from Google Maps (right-click
  // your marker → copy coordinates). Approximate DHA Phase 6 centre for now.
  latitude: 24.795,
  longitude: 67.057,

  /**
   * Google Business Profile links.
   * - mapsUrl: shown to humans (footer / delivery pages).
   * - gbpCid: the strongest machine link between site and GBP. Find it via
   *   https://lookup.fa.gd or GBP dashboard share link → set it and hasMap
   *   in the JSON-LD upgrades from a search URL to your exact listing.
   */
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=Cheese+O'Clock+Phase+6+DHA+Karachi",
  gbpCid: null as string | null, // e.g. '1234567890123456789'

  /**
   * Social / profile URLs for the JSON-LD `sameAs` array. Only real, live
   * profiles — add Instagram/Facebook/foodpanda here as they go live.
   */
  sameAs: [] as string[],

  // Matches GBP "price range" tier; used in JSON-LD.
  priceRange: 'PKR 400–2,500',

  // 12:00 → 02:00 next day; Google's LocalBusiness format supports
  // past-midnight closes on the same entry.
  openingHours: { opens: '12:00', closes: '02:00' },

  servesCuisine: ['Pizza', 'Burgers', 'Fast Food', 'Wings'],
} as const;

/** wa.me deep link with a pre-filled, URL-encoded message. */
export function waLink(message: string): string {
  return `${BUSINESS.whatsappUrl}?text=${encodeURIComponent(message)}`;
}

/** Default "I want to order" WhatsApp link used by order CTAs. */
export const WA_ORDER_URL = waLink("Hi Cheese O'Clock! I'd like to place an order: ");
