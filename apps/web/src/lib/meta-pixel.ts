/**
 * The Meta (Facebook) Pixel on cheeseoclock.net: which events it sends, with what, and when it
 * must stay silent. Framework-free on purpose: the browser window (with its `fbq` and its
 * localStorage) is handed to createPixel, so every rule here is tested in plain node.
 *
 * Off unless NEXT_PUBLIC_META_PIXEL_ID is a pixel id. Next inlines that variable when the site
 * is BUILT, so it is set in Vercel (Production) and the site is then redeployed (DEPLOY.md,
 * "Meta Pixel").
 *
 * What goes to Meta, and what never does:
 *  - Only menu item ids, the menu's own item names, quantities, values in PKR and the currency.
 *    The builders below read exactly those fields off what they are given, so a line that also
 *    carries an item note or a choice's name cannot leak it. Never a name, phone, e-mail,
 *    address, delivery area, or the free-text notes (the order's or an item's).
 *  - Nothing at all from a tracking page. Its address right after checkout is
 *    `/track/<order id>?phone=<the customer's phone>`, the pixel sends the page address with
 *    every event, and it sends the referrer too: so no event fires on /track, or on a page that
 *    was opened from it.
 *  - The one thing of the order's own is its id, as the Purchase `eventID` (purchaseEventId).
 *
 * Every call is fire-and-forget: it returns whether an event went out and never throws, so a
 * blocked, slow or broken pixel cannot touch browsing, the cart or placing an order.
 */

// ---------------------------------------------------------------------------
// The switch

/** A pixel id is digits (15–16 today); 8–20 keeps anything else out of the script the page runs. */
const PIXEL_ID = /^\d{8,20}$/;

/** The pixel id from NEXT_PUBLIC_META_PIXEL_ID, or null (unset, empty, not digits) = the pixel is off. */
export function readPixelId(raw: string | null | undefined): string | null {
  const id = (raw ?? '').trim();
  return PIXEL_ID.test(id) ? id : null;
}

/**
 * This build's pixel id. The variable is named in full, `process.env.NEXT_PUBLIC_…`, because
 * that is the only spelling Next replaces with its value at build time.
 */
export const META_PIXEL_ID: string | null = readPixelId(process.env.NEXT_PUBLIC_META_PIXEL_ID);

// ---------------------------------------------------------------------------
// What an event says

export const PIXEL_CURRENCY = 'PKR' as const;

/**
 * Paisa ("cents" everywhere else in this repo) → rupees, a plain number with at most two
 * decimals (359999 → 3599.99; never 3599.9899999…). Anything that is not an amount is 0.
 */
export function pkr(cents: number): number {
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.round(cents) / 100;
}

/** One cart line as the pixel is told of it: an item id, how many, and what one costs. */
export interface PixelLine {
  /** The menu item's id (the till's posItemId). */
  id: string;
  quantity: number;
  /** One of it with its chosen extras, in paisa. */
  unitCents: number;
}

export interface PixelContent {
  id: string;
  quantity: number;
}

interface Basket {
  content_ids: string[];
  contents: PixelContent[];
  num_items: number;
  value: number;
  currency: typeof PIXEL_CURRENCY;
}

/** InitiateCheckout and Purchase: the basket, and what it is worth. */
export type BasketPayload = Basket;

/** AddToCart: what was added. */
export interface AddToCartPayload extends Basket {
  content_type: 'product';
}

/** ViewContent for one item (its sheet opened). */
export interface ViewItemPayload {
  content_type: 'product';
  content_ids: string[];
  content_name: string;
  value: number;
  currency: typeof PIXEL_CURRENCY;
}

/** ViewContent for the /menu page itself. */
export interface ViewMenuPayload {
  content_name: 'Menu';
  content_category: 'Menu';
}

/**
 * The lines as the basket Meta wants: the ids once each (in the order first seen), a
 * quantity per id, the number of items, and what they come to. A line that is not an
 * id and a whole quantity of at least one is left out.
 */
function basketOf(lines: readonly PixelLine[]): {
  ids: string[];
  contents: PixelContent[];
  items: number;
  cents: number;
} {
  const quantities = new Map<string, number>();
  let cents = 0;
  for (const l of lines) {
    const quantity = Math.floor(l.quantity);
    if (typeof l.id !== 'string' || l.id === '' || !Number.isFinite(quantity) || quantity < 1)
      continue;
    quantities.set(l.id, (quantities.get(l.id) ?? 0) + quantity);
    cents += Math.max(0, Math.round(l.unitCents) || 0) * quantity;
  }
  const contents = [...quantities].map(([id, quantity]) => ({ id, quantity }));
  return {
    ids: contents.map((c) => c.id),
    contents,
    items: contents.reduce((n, c) => n + c.quantity, 0),
    cents,
  };
}

function basketPayload(
  lines: readonly PixelLine[],
  valueCents: number | null = null,
): BasketPayload {
  const b = basketOf(lines);
  return {
    content_ids: b.ids,
    contents: b.contents,
    num_items: b.items,
    value: pkr(valueCents ?? b.cents),
    currency: PIXEL_CURRENCY,
  };
}

/** An item's sheet opened: the item, at its own price. */
export function viewItemPayload(item: {
  id: string;
  name: string;
  unitCents: number;
}): ViewItemPayload {
  return {
    content_type: 'product',
    content_ids: [item.id],
    content_name: item.name,
    value: pkr(item.unitCents),
    currency: PIXEL_CURRENCY,
  };
}

/** The /menu page was opened. */
export function viewMenuPayload(): ViewMenuPayload {
  return { content_name: 'Menu', content_category: 'Menu' };
}

/** Lines went into the cart: value = what was added (each with its extras, times its quantity). */
export function addToCartPayload(lines: readonly PixelLine[]): AddToCartPayload {
  return { content_type: 'product', ...basketPayload(lines) };
}

/** The checkout opened: value = the cart's items, before tax, delivery and any discount. */
export function initiateCheckoutPayload(lines: readonly PixelLine[]): BasketPayload {
  return basketPayload(lines);
}

/**
 * The order was placed: value = what the customer pays, as the SERVER priced it (api/orders:
 * totalCents, with the tax, the delivery charge and the pick-up discount in it) — never the
 * cart's sum. null when the server's total is not an amount: no number is made up for it.
 */
export function purchasePayload(
  totalCents: number | null | undefined,
  lines: readonly PixelLine[],
): BasketPayload | null {
  if (typeof totalCents !== 'number' || !Number.isFinite(totalCents) || totalCents < 0) return null;
  return basketPayload(lines, totalCents);
}

// ---------------------------------------------------------------------------
// Where it stays silent

/**
 * True for /track and everything under it, whether given a path or a whole address (a referrer
 * is one). The match is on the path as the router reads it: percent-escapes undone
 * (/%74rack/…), dot segments resolved, any case.
 */
export function isTrackingPath(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value === '') return false;
  let path: string;
  try {
    // A path is read as a path (never as "//host"): the base only gives it an address to be part of.
    path = new URL(value.startsWith('/') ? `https://pixel.invalid${value}` : value).pathname;
  } catch {
    return false;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape: the path as it is.
  }
  return /^\/+track(\/|$)/i.test(path);
}

/** A page view is sent for a known page that is not a tracking page. */
export function shouldTrackPageView(pathname: string | null | undefined): boolean {
  return typeof pathname === 'string' && pathname !== '' && !isTrackingPath(pathname);
}

// ---------------------------------------------------------------------------
// The base snippet

/** The Meta base code, as it ships. */
const FBEVENTS_URL = 'https://connect.facebook.net/en_US/fbevents.js';

/**
 * Meta's standard base snippet, with three differences, each for a reason, and no PageView:
 *  - `fbq.disablePushState`: the pixel would otherwise count a page on every history.pushState.
 *    The site pushes a history entry for every sheet it opens (ordering/Sheet.tsx), and can for
 *    the move to the tracking page after checkout, whose address carries the customer's phone.
 *    Page views are sent by MetaPixel.tsx on the route change instead, and never for /track.
 *  - `fbq.allowDuplicatePageViews`: so each of those is sent, not dropped as a repeat.
 *  - autoConfig off: no automatic event capture (button clicks and the form fields' names, the
 *    page's microdata) and no automatic advanced matching, which would hash what the customer
 *    types in the checkout. Every event is the explicit one in this file.
 * Empty for anything but a pixel id, so nothing else can reach the script's text.
 */
export function metaPixelSnippet(pixelId: string): string {
  const id = readPixelId(pixelId);
  if (id === null) return '';
  return `!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'${FBEVENTS_URL}');
fbq.disablePushState = true;
fbq.allowDuplicatePageViews = true;
fbq('set', 'autoConfig', false, '${id}');
fbq('init', '${id}');`;
}

// ---------------------------------------------------------------------------
// Sending

/**
 * The Purchase's `eventID`, which lets Meta count one order once if the same sale ever reaches
 * it twice (a replayed page, or a server-side event later). It is the order's own id. That id
 * alone opens nothing (the tracking page and /api/orders/<id> also ask for the phone the order
 * was placed with), but it is the order's identity: if it should not leave the site, change
 * this one line (a hash of the id does the same job) and nothing else.
 */
export const purchaseEventId = (orderId: string): string => orderId;

/** The key that remembers, on this phone, that an order's Purchase has been sent. */
export const PURCHASE_KEY_PREFIX = 'coc.pixel.purchase.';

/** What an order id may look like to be remembered under a key and sent as an event id. */
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PixelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of the browser window the pixel reads. Every access is guarded: any of it can throw or be missing. */
export interface PixelWindow {
  /** Defined by the base snippet; anything else (or nothing) = no pixel here. */
  fbq?: unknown;
  location?: { pathname?: string };
  document?: { referrer?: string };
  localStorage?: PixelStorage;
}

export interface PixelDeps {
  /** From readPixelId: null = off. */
  pixelId: string | null;
  /** The browser window, read at each call (undefined on the server). */
  getWindow: () => PixelWindow | undefined;
}

export interface PixelOptions {
  eventID?: string;
}

export interface Pixel {
  /** False = no pixel id: every call below does nothing and returns false. */
  readonly enabled: boolean;
  /** `fbq('track', event, payload, options)`; true if it went out. */
  track(event: string, payload?: object, options?: PixelOptions): boolean;
  /** A Purchase, once per order id, however many times it is asked: see createPixel. */
  trackPurchaseOnce(orderId: string, payload: object): boolean;
  pageView(pathname: string | null | undefined): boolean;
  viewMenu(): boolean;
  viewItem(item: { id: string; name: string; unitCents: number }): boolean;
  addToCart(lines: readonly PixelLine[]): boolean;
  initiateCheckout(lines: readonly PixelLine[]): boolean;
  /** The server's total (paisa) and the cart's lines; no total = no event. */
  purchase(
    orderId: string,
    totalCents: number | null | undefined,
    lines: readonly PixelLine[],
  ): boolean;
}

/**
 * A pixel client over an injected browser. Each method is safe to call from anywhere: off
 * (no id), on the server, without `fbq` (blocked, or not loaded), or from a tracking page, it
 * does nothing; if anything throws, it is swallowed.
 *
 * A Purchase is claimed BEFORE it is sent: the order id is written to localStorage (and to a
 * set in memory, for when storage throws, as in a private tab) and only then handed to the
 * pixel. A refresh, a second tab, or the same order coming back from the server for a resend
 * therefore finds it taken. The claim is made only when the event can actually go out, so a
 * pixel that has not loaded yet does not use it up.
 */
export function createPixel(deps: PixelDeps): Pixel {
  const enabled = readPixelId(deps.pixelId) !== null;
  const claimedHere = new Set<string>();

  /** The window to send from, or undefined if an event must not go out now. */
  function ready(): PixelWindow | undefined {
    if (!enabled) return undefined;
    const win = deps.getWindow();
    if (!win || typeof win.fbq !== 'function') return undefined;
    // The page itself, and the page it was opened from: the pixel sends both addresses.
    if (isTrackingPath(win.location?.pathname) || isTrackingPath(win.document?.referrer))
      return undefined;
    return win;
  }

  function send(
    win: PixelWindow,
    event: string,
    payload?: object,
    options?: PixelOptions,
  ): boolean {
    try {
      const args: unknown[] = ['track', event];
      // The pixel's argument order is (event, parameters, options): options need parameters in front of them.
      if (payload !== undefined || options !== undefined) args.push(payload ?? {});
      if (options !== undefined) args.push(options);
      (win.fbq as (...a: unknown[]) => unknown).apply(win, args);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs one pixel call so that nothing it does, builders included, can reach the page. */
  function safely(run: () => boolean): boolean {
    if (!enabled) return false;
    try {
      return run();
    } catch {
      return false;
    }
  }

  function isStored(win: PixelWindow, key: string): boolean {
    try {
      return win.localStorage?.getItem(key) != null;
    } catch {
      return false;
    }
  }

  function store(win: PixelWindow, key: string): void {
    try {
      win.localStorage?.setItem(key, '1');
    } catch {
      // Storage is blocked or full: the set in memory carries the claim for this page.
    }
  }

  function track(event: string, payload?: object, options?: PixelOptions): boolean {
    return safely(() => {
      const win = ready();
      return win ? send(win, event, payload, options) : false;
    });
  }

  function trackPurchaseOnce(orderId: string, payload: object): boolean {
    return safely(() => {
      if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return false;
      const win = ready();
      if (!win) return false;
      const key = `${PURCHASE_KEY_PREFIX}${orderId}`;
      if (claimedHere.has(orderId) || isStored(win, key)) return false;
      claimedHere.add(orderId);
      store(win, key);
      return send(win, 'Purchase', payload, { eventID: purchaseEventId(orderId) });
    });
  }

  return {
    enabled,
    track,
    trackPurchaseOnce,
    pageView: (pathname) => safely(() => shouldTrackPageView(pathname) && track('PageView')),
    viewMenu: () => safely(() => track('ViewContent', viewMenuPayload())),
    viewItem: (item) => safely(() => track('ViewContent', viewItemPayload(item))),
    addToCart: (lines) =>
      safely(() => {
        const payload = addToCartPayload(lines);
        return payload.num_items > 0 && track('AddToCart', payload);
      }),
    initiateCheckout: (lines) =>
      safely(() => {
        const payload = initiateCheckoutPayload(lines);
        return payload.num_items > 0 && track('InitiateCheckout', payload);
      }),
    purchase: (orderId, totalCents, lines) =>
      safely(() => {
        const payload = purchasePayload(totalCents, lines);
        return payload !== null && trackPurchaseOnce(orderId, payload);
      }),
  };
}

/** The site's pixel: this build's id, the real window. */
export const pixel: Pixel = createPixel({
  pixelId: META_PIXEL_ID,
  getWindow: () => (typeof window === 'undefined' ? undefined : window),
});
