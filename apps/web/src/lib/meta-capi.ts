import { metaUserData, type MetaUserData } from './meta-user-data';
import {
  isTrackingPath,
  purchaseEventId,
  purchasePayload,
  readPixelId,
  readTestCode,
  type BasketPayload,
  type PixelLine,
} from './meta-pixel';

/**
 * Meta's Conversions API: the website's own server tells Meta of each order placed, beside the
 * browser's Pixel (lib/meta-pixel). The browser's event can be lost — an ad blocker, a closed tab,
 * a phone that drops off the network as the order goes through — and the server's cannot, and it
 * carries what the browser does not have: the customer's IP address and the hashed details Meta
 * matches an ad click with.
 *
 * One order is still one sale to Meta: both events are a "Purchase" with the order's id as the
 * event id (purchaseEventId), so whichever arrives second is dropped as a duplicate.
 *
 * Off unless the server has both the pixel id (NEXT_PUBLIC_META_PIXEL_ID) and an access token
 * from Events Manager (META_CAPI_ACCESS_TOKEN, a Sensitive variable in Vercel Production; DEPLOY.md,
 * "Meta Conversions API"). It never stands in an order's way: it runs after the order is saved,
 * gives up after a short wait, and never throws.
 *
 * What goes to Meta: the order's id, value (PKR), item ids and quantities; the hashed phone and
 * name, with Karachi / Sindh / Pakistan (lib/meta-user-data); the request's IP address and browser
 * (user agent); the Pixel's own cookies (_fbp, _fbc) and the page's address without its query.
 * Never the address, the area, the notes or anything in clear.
 */

/** The Graph API version the events are sent to (v26.0: July 2026). */
export const GRAPH_VERSION = 'v26.0';

/** How long an order waits for Meta's answer, at most. */
export const CAPI_TIMEOUT_MS = 2500;

export interface CapiConfig {
  pixelId: string;
  accessToken: string;
}

/** An access token is a long run of letters and digits; anything else is no token. */
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{20,1024}$/;

/** The server's set-up, or null = the Conversions API is off. */
export function readCapiConfig(env: Record<string, string | undefined> = process.env): CapiConfig | null {
  const pixelId = readPixelId(env['NEXT_PUBLIC_META_PIXEL_ID']);
  const accessToken = (env['META_CAPI_ACCESS_TOKEN'] ?? '').trim();
  if (pixelId === null || !ACCESS_TOKEN.test(accessToken)) return null;
  return { pixelId, accessToken };
}

// ---------------------------------------------------------------------------
// What the request tells

/** What the order's request says about the browser it came from. */
export interface RequestFacts {
  ip: string | null;
  userAgent: string | null;
  /** The Pixel's browser id cookie (_fbp). */
  fbp: string | null;
  /** The Pixel's ad-click cookie (_fbc), or one made from the page's fbclid. */
  fbc: string | null;
  /** The page the order was placed from: origin and path only. */
  sourceUrl: string;
}

/** A Pixel cookie's shape: fb.<subdomain index>.<time>.<value>. */
const PIXEL_COOKIE = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_.-]{1,400}$/;
/** An fbclid from an ad click. */
const FBCLID = /^[A-Za-z0-9_-]{10,400}$/;

function cookieOf(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not escaped: as it is.
    }
    return value;
  }
  return null;
}

function pageOf(referer: string | null): URL | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** The page the site's own menu lives on, for an order whose page is not known. */
const MENU_URL = 'https://www.cheeseoclock.net/menu';

export function requestFacts(req: Request, nowMs: number = Date.now()): RequestFacts {
  const h = req.headers;
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || null;
  const userAgent = h.get('user-agent')?.trim().slice(0, 512) || null;
  const cookies = h.get('cookie');
  const fbpCookie = cookieOf(cookies, '_fbp');
  const fbcCookie = cookieOf(cookies, '_fbc');
  const page = pageOf(h.get('referer'));
  const fbclid = page?.searchParams.get('fbclid') ?? null;
  const fbc =
    fbcCookie !== null && PIXEL_COOKIE.test(fbcCookie)
      ? fbcCookie
      : fbclid !== null && FBCLID.test(fbclid)
        ? `fb.1.${nowMs}.${fbclid}`
        : null;
  return {
    ip,
    userAgent,
    fbp: fbpCookie !== null && PIXEL_COOKIE.test(fbpCookie) ? fbpCookie : null,
    fbc,
    sourceUrl: page && !isTrackingPath(page.pathname) ? `${page.origin}${page.pathname}` : MENU_URL,
  };
}

// ---------------------------------------------------------------------------
// The event

/** Meta's user_data: every hashed detail as a one-item list, then the request's own. */
export type CapiUserData = { [K in keyof MetaUserData]?: string[] } & {
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
};

export interface CapiEvent {
  event_name: 'Purchase';
  event_time: number;
  event_id: string;
  action_source: 'website';
  event_source_url: string;
  user_data: CapiUserData;
  custom_data: BasketPayload & { content_type: 'product'; order_id: string };
}

export interface ServerPurchase {
  orderId: string;
  /** What the customer pays, as the server priced it (paisa). */
  totalCents: number;
  /** The food lines (no delivery charge), as the browser's Purchase has them. */
  lines: readonly PixelLine[];
  customer: { phone: string; name: string };
}

/** The Purchase for one order, or null when its total is not an amount. */
export function purchaseEvent(order: ServerPurchase, facts: RequestFacts, nowMs: number = Date.now()): CapiEvent | null {
  const basket = purchasePayload(order.totalCents, order.lines);
  if (basket === null) return null;
  const hashed = metaUserData(order.customer);
  const userData: CapiUserData = {};
  if (hashed) for (const [key, value] of Object.entries(hashed)) userData[key as keyof MetaUserData] = [value];
  if (facts.ip) userData.client_ip_address = facts.ip;
  if (facts.userAgent) userData.client_user_agent = facts.userAgent;
  if (facts.fbp) userData.fbp = facts.fbp;
  if (facts.fbc) userData.fbc = facts.fbc;
  return {
    event_name: 'Purchase',
    event_time: Math.floor(nowMs / 1000),
    event_id: purchaseEventId(order.orderId),
    action_source: 'website',
    event_source_url: facts.sourceUrl,
    user_data: userData,
    custom_data: { ...basket, content_type: 'product', order_id: order.orderId },
  };
}

// ---------------------------------------------------------------------------
// Sending

export interface SendResult {
  ok: boolean;
  /** Meta's HTTP status, when it answered. */
  status?: number;
  /** How many events Meta took (its events_received). */
  received?: number;
  error?: string;
}

export async function sendCapiEvents(
  config: CapiConfig,
  events: readonly CapiEvent[],
  options: { testCode?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SendResult> {
  const testCode = readTestCode(options.testCode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CAPI_TIMEOUT_MS);
  try {
    const res = await (options.fetchImpl ?? fetch)(
      `https://graph.facebook.com/${GRAPH_VERSION}/${config.pixelId}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: events,
          access_token: config.accessToken,
          ...(testCode ? { test_event_code: testCode } : {}),
        }),
        signal: controller.signal,
        cache: 'no-store',
      },
    );
    type Answer = { events_received?: unknown; error?: { message?: unknown; code?: unknown } };
    let body: Answer | null = null;
    try {
      body = (await res.json()) as Answer | null;
    } catch {
      // Not JSON: the status says enough.
    }
    if (!res.ok) {
      const message = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 300) : 'no message';
      return { ok: false, status: res.status, error: `${String(body?.error?.code ?? res.status)}: ${message}` };
    }
    const received = typeof body?.events_received === 'number' ? body.events_received : undefined;
    return { ok: true, status: res.status, ...(received !== undefined ? { received } : {}) };
  } catch (e) {
    return { ok: false, error: controller.signal.aborted ? 'timed out' : e instanceof Error ? e.message : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The order route's one call: the order's Purchase, sent and waited for (at most CAPI_TIMEOUT_MS).
 * Resolves whatever happens — off, refused, timed out — and only logs a failure, without the token.
 */
export async function sendServerPurchase(
  req: Request,
  order: ServerPurchase,
  options: { testCode?: string | null; config?: CapiConfig | null; fetchImpl?: typeof fetch } = {},
): Promise<SendResult> {
  try {
    const config = options.config === undefined ? readCapiConfig() : options.config;
    if (config === null) return { ok: false, error: 'off' };
    const event = purchaseEvent(order, requestFacts(req));
    if (event === null) return { ok: false, error: 'no total' };
    const result = await sendCapiEvents(config, [event], {
      testCode: options.testCode ?? null,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!result.ok) console.warn('Meta Conversions API: Purchase not sent', result.status ?? '', result.error ?? '');
    return result;
  } catch (e) {
    console.warn('Meta Conversions API: Purchase not sent', e instanceof Error ? e.message : e);
    return { ok: false, error: 'failed' };
  }
}
