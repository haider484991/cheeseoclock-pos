/**
 * Static business facts shown across the site. The published menu's `store`
 * block (pushed from POS branding) overrides these where present — these are
 * the fallbacks so the site renders sensibly before the first publish.
 *
 * IMPORTANT (local SEO): name, address and phone here should read the same
 * as the Google Business Profile listing. This object feeds the footer NAP,
 * the JSON-LD Restaurant graph and the delivery pages — one source of truth,
 * zero drift.
 */
export const BUSINESS = {
  name: "Cheese O'Clock",
  // The printed menu's line (owner, 25 Sep 2026: "Hygienically", not "Cleanly").
  tagline: 'Hygienically Made. Deliciously Unforgettable.',
  // Matches the Google Business Profile listing (verified 27 Jul 2026).
  phoneDisplay: '0300 9367865',
  phoneE164: '+923009367865',

  // Primary WhatsApp ordering line (the call line above). Keep all three in
  // sync: display, E.164, wa.me. Both shop numbers take WhatsApp orders —
  // whatsappLines is what the site lists; this one is the default deep link.
  whatsappDisplay: '0300 9367865',
  whatsappE164: '+923009367865',
  whatsappUrl: 'https://wa.me/923009367865',
  whatsappLines: [
    { display: '0300 9367865', e164: '+923009367865', url: 'https://wa.me/923009367865' },
    { display: '0331 2188295', e164: '+923312188295', url: 'https://wa.me/923312188295' },
  ],
  // Short form for inline "name · address · hours" strips only. The full
  // address lives in streetAddress below and is what the footer <address>
  // block and the JSON-LD PostalAddress render.
  addressLine: 'Rahat Commercial Area, DHA Phase 6, Karachi',
  hours: 'Open daily · 12 noon – 1 am',
  openingDate: '15 June 2026',

  // --- Structured address -------------------------------------------------
  // The owner's corrected address (25 Sep 2026). The Google listing still
  // repeats "Rahat … Phase 6 … Defence Housing Authority"; edit the listing
  // to this same wording so the NAP matches everywhere. `region` is not part
  // of Google's formatted address but is valid for schema.org addressRegion.
  streetAddress:
    'Shop 3, Ground Floor, 41-C, Sehar Lane No. 3, Rahat Commercial Area, DHA Phase 6',
  locality: 'Karachi',
  region: 'Sindh',
  postalCode: '75500',
  country: 'PK',

  // Exact listing pin (from the GBP place URL), not the phase centroid.
  latitude: 24.8082972,
  longitude: 67.0684383,

  /**
   * Google Business Profile links.
   * - mapsUrl: shown to humans (footer / delivery pages).
   * - gbpCid: the strongest machine link between site and GBP — it makes the
   *   JSON-LD `hasMap` point at the exact listing instead of a search URL.
   *   Derived from the place URL's `!1s0x<fid>:0x<cid-hex>` pair: the second
   *   hex value (0x55bcd1598d18e252) in decimal. Verified 27 Jul 2026 —
   *   https://maps.google.com/?cid=... resolves to the Cheese O'Clock listing.
   */
  mapsUrl: 'https://maps.google.com/?cid=6178042971394990674',
  gbpCid: '6178042971394990674' as string | null,

  /**
   * Social / profile URLs for the JSON-LD `sameAs` array. Only real, live
   * profiles — add Instagram/Facebook/foodpanda here as they go live.
   */
  sameAs: [] as string[],

  // Matches GBP "price range" tier; used in JSON-LD.
  priceRange: 'PKR 400–2,500',

  // 12:00 → 01:00 next day (owner, 25 Sep 2026); Google's LocalBusiness
  // format supports past-midnight closes on the same entry.
  openingHours: { opens: '12:00', closes: '01:00' },

  servesCuisine: ['Pizza', 'Burgers', 'Fast Food'],
} as const;

/** wa.me deep link with a pre-filled, URL-encoded message. */
export function waLink(message: string): string {
  return `${BUSINESS.whatsappUrl}?text=${encodeURIComponent(message)}`;
}

/** Default "I want to order" WhatsApp link used by order CTAs. */
export const WA_ORDER_URL = waLink("Hi Cheese O'Clock! I'd like to place an order: ");
