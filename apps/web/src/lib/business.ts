/**
 * The shop's PLACE, as code: where the kitchen is on the map and in which
 * city — what belongs to the Google Business Profile listing, not to the
 * shop's words.
 *
 * The shop's words are the owner's (sweep B2 + B4: Settings → Shop & logo →
 * "Website: shop details (both tills)"), read through lib/shop-facts.ts: the
 * name, tagline, phone and WhatsApp lines, the street address and postal
 * code, the opening hours, the social links, the price range, the WhatsApp
 * greeting and what the rider takes. With nothing saved they are today's —
 * the frozen DEFAULT_SHOP_* of shared-types website-shop.ts, the ONE place
 * they are written (so the website and both tills agree, and nothing drifts).
 *
 * IMPORTANT (local SEO): name, address, phone and hours must read the same as
 * the Google Business Profile listing (the till's cards say so).
 */
export const BUSINESS = {
  locality: 'Karachi',
  region: 'Sindh',
  country: 'PK',
  openingDate: '15 June 2026',

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
   *   https://maps.google.com/?cid=... resolves to the shop's listing.
   */
  mapsUrl: 'https://maps.google.com/?cid=6178042971394990674',
  gbpCid: '6178042971394990674' as string | null,

  servesCuisine: ['Pizza', 'Burgers', 'Fast Food'],
} as const;
