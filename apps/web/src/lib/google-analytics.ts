/**
 * Google Analytics 4: the property "Cheese O'Clock", stream www.cheeseoclock.net (27 Oct 2026). Page views and the
 * ordering funnel (lib/funnel) go here since the site left Vercel: Vercel Web Analytics needs Vercel, and on the free
 * plan it records no custom events at all, so the funnel stopped counting when the team went to Hobby.
 *
 * Like the Meta Pixel (lib/meta-pixel), nothing here can get in the way of an order (every call swallows its own
 * failure), and nothing about a customer reaches Google:
 *  - Google's tag never loads on the owner's dashboard or on a tracking page (SiteAnalytics.tsx), and no page view or
 *    event is sent while one is open (`shouldTrackPageView`).
 *  - Every hit carries a cleaned address (`cleanPageLocation`): the path, and of the query only the ad-campaign tags.
 *    A tracking page's address, /track/<order id>?phone=<the customer's phone>, never leaves as it is; the tracking
 *    page goes as /track.
 *  - The referrer is cleaned the same way when it is this site (a full load from a tracking page sends that page's
 *    address as the referrer).
 *  - The stream's enhanced measurement is off and the tag sends no page view of its own (`send_page_view: false`):
 *    every hit is an explicit one from this file. The stream also redacts a `phone` query parameter.
 */
import { isPrivatePath, isTrackingPath, shouldTrackPageView } from '@/lib/meta-pixel';

export const GA_MEASUREMENT_ID = 'G-X9KQXXJ115';

/** The query parameters a hit may keep: how the visitor came from an ad or a campaign. */
const CAMPAIGN_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
];

/**
 * An address as it may go to Google: this site's path with only the campaign tags kept, the tracking page as /track
 * and the dashboard as /dashboard. Anything that is not an address of this origin comes back as just its origin.
 */
export function cleanPageLocation(href: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return origin;
  }
  if (url.origin !== origin) return url.origin;
  if (isTrackingPath(url.pathname)) return `${origin}/track`;
  if (isPrivatePath(url.pathname)) return `${origin}/dashboard`;
  const kept = new URLSearchParams();
  for (const key of CAMPAIGN_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null) kept.set(key, value);
  }
  const query = kept.toString();
  return `${origin}${url.pathname}${query ? `?${query}` : ''}`;
}

/** The referrer as it may go to Google: this site's own addresses cleaned, another site's as the browser gave it. */
export function cleanReferrer(referrer: string, origin: string): string {
  if (referrer === '') return '';
  try {
    return new URL(referrer).origin === origin ? cleanPageLocation(referrer, origin) : referrer;
  } catch {
    return '';
  }
}

type Gtag = (...args: unknown[]) => void;

function gtagOf(): Gtag | undefined {
  if (typeof window === 'undefined') return undefined;
  const gtag = (window as unknown as { gtag?: unknown }).gtag;
  return typeof gtag === 'function' ? (gtag as Gtag) : undefined;
}

/** Google's tag queue, as its standard snippet sets it up. Empty for anything but a measurement id. */
export function gaSnippet(id: string): string {
  if (!/^G-[A-Z0-9]+$/.test(id)) return '';
  return "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());";
}

let configured = false;

/** The tag's config, once per page load, with the cleaned address and referrer and no page view of its own. */
export function gaConfigure(): void {
  try {
    const gtag = gtagOf();
    if (!gtag || configured) return;
    configured = true;
    const origin = window.location.origin;
    gtag('config', GA_MEASUREMENT_ID, {
      send_page_view: false,
      page_location: cleanPageLocation(window.location.href, origin),
      page_referrer: cleanReferrer(document.referrer, origin),
    });
  } catch {
    // Analytics never blocks the order.
  }
}

/**
 * A page view for the page now open, unless it is a tracking or dashboard page. The cleaned address is also `set`, so
 * the engagement hits the tag sends by itself carry it rather than the address bar's.
 */
export function gaPageView(): void {
  try {
    const gtag = gtagOf();
    if (!gtag) return;
    const origin = window.location.origin;
    const pageLocation = cleanPageLocation(window.location.href, origin);
    gtag('set', { page_location: pageLocation });
    if (!shouldTrackPageView(window.location.pathname)) return;
    gtag('event', 'page_view', { page_location: pageLocation, page_title: document.title });
  } catch {
    // Analytics never blocks the order.
  }
}

/** One event with its properties, from a page that may send one. */
export function gaEvent(name: string, params: Record<string, string>): void {
  try {
    const gtag = gtagOf();
    if (!gtag || !shouldTrackPageView(window.location.pathname)) return;
    gtag('event', name, { ...params, page_location: cleanPageLocation(window.location.href, window.location.origin) });
  } catch {
    // Analytics never blocks the order.
  }
}
