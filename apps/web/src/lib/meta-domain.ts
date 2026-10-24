/**
 * Meta domain verification for cheeseoclock.net (user, 25 Oct 2026): Business settings → Brand safety → Domains,
 * portfolio "Cheese O'clock", domain id 1587436372686762, the meta-tag method. The root layout (app/layout.tsx) puts
 * it in every page's <head>, server-rendered, the home page included, as Meta requires; Meta reads it off the page,
 * so it is public by design. A new code from Meta replaces this one.
 */
export const META_DOMAIN_VERIFICATION = 'vwvdj8won0g14eyynv4kp81gcn05oe';

/** The root layout's `verification` metadata: Next renders it as <meta name="facebook-domain-verification" …>. */
export const META_DOMAIN_VERIFICATION_METADATA = {
  other: { 'facebook-domain-verification': META_DOMAIN_VERIFICATION },
};
