/**
 * The seven delivery-area pages' slugs, for the middleware (src/middleware.ts)
 * that sends any other /delivery/<slug> to the site's 404 page. A list of its
 * own so the middleware stays a few bytes: lib/areas.ts carries all the page
 * copy. It must equal DELIVERY_AREAS' slugs, in order (isr-routes.test.ts).
 * Slugs never change — they are the pages' addresses.
 */
export const AREA_SLUGS = [
  'dha-phase-6',
  'dha-phase-7',
  'dha-phase-8',
  'dha-phase-5',
  'dha-phase-4',
  'dha-phase-1-2',
  'clifton',
] as const;
