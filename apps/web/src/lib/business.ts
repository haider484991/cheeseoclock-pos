/**
 * Static business facts shown across the site. The published menu's `store`
 * block (pushed from POS branding) overrides these where present — these are
 * the fallbacks so the site renders sensibly before the first publish.
 */
export const BUSINESS = {
  name: "Cheese O'Clock",
  tagline: 'Gourmet pizza & fast food — it’s always Cheese O’Clock.',
  phoneDisplay: '0333 2191726',
  phoneE164: '+923332191726',
  whatsappUrl: 'https://wa.me/923332191726',
  addressLine: 'Phase 6, DHA, Karachi',
  hours: 'Open daily · 12pm – 2am',
  openingDate: '15 June 2026',
} as const;
