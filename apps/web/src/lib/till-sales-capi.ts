import { sql } from './db';
import { ensureDashSchema } from './dashboard/schema';
import { GRAPH_VERSION, readCapiConfig, type CapiConfig } from './meta-capi';
import { metaUserData } from './meta-user-data';
import { probeThenCreate } from './schema-on-demand';

/**
 * Till sales to Meta (26 Oct 2026, the user picked "Send till sales to Meta"): every paid till order with a
 * Pakistani mobile number — walk-in, phone, WhatsApp — goes to the shop's Meta dataset as a shop Purchase
 * (action_source physical_store), the number and name hashed exactly as the website's Purchase hashes them
 * (lib/meta-user-data). Meta then sees the shop's real sales, not the few website ones, and learns who buys.
 *
 * Run after each dashboard push from a till (api/bridge/dashboard/push), which is where the till's orders arrive:
 * the paid orders of the last TILL_SALES_WINDOW_DAYS not sent yet, at most BATCH a time, each once
 * (capi_till_sales). Website orders are left out (the website sent their Purchase when they were placed) and so are
 * foodpanda's (not the shop's customers to measure). Off unless TILL_SALES_TO_META is "on" and the Conversions API
 * is set up (META_CAPI_ACCESS_TOKEN, NEXT_PUBLIC_META_PIXEL_ID). It never fails or holds up the till's push.
 */
export const TILL_SALES_WINDOW_DAYS = 7;
const BATCH = 50;
const SEND_TIMEOUT_MS = 8000;

let ready: Promise<void> | null = null;
function ensureSentTable(): Promise<void> {
  if (!ready) {
    ready = probeThenCreate(() => sql()`SELECT order_id FROM capi_till_sales LIMIT 0`, async () => {
      await sql()`
        CREATE TABLE IF NOT EXISTS capi_till_sales (
          order_id TEXT PRIMARY KEY,
          sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    }).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export function tillSalesConfig(env: Record<string, string | undefined> = process.env): CapiConfig | null {
  return env['TILL_SALES_TO_META'] === 'on' ? readCapiConfig(env) : null;
}

export interface TillSale {
  id: string;
  paidAt: Date;
  netCents: number;
  phone: string | null;
  name: string | null;
}

/** The shop Purchase for one till sale, or null when its number is not a Pakistani mobile (nothing to match). */
export function tillSaleEvent(s: TillSale): Record<string, unknown> | null {
  const hashed = metaUserData({ phone: s.phone, name: s.name });
  if (!hashed || !(s.netCents > 0)) return null;
  const userData: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(hashed)) userData[key] = [value];
  return {
    event_name: 'Purchase',
    event_time: Math.floor(s.paidAt.getTime() / 1000),
    event_id: `till-${s.id}`,
    action_source: 'physical_store',
    user_data: userData,
    custom_data: { currency: 'PKR', value: s.netCents / 100, order_id: s.id },
  };
}

/** Sends the till's unsent sales of the last week. Never throws; resolves to how many Meta took. */
export async function sendTillSales(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<{ sent: number; error?: string }> {
  const config = tillSalesConfig();
  if (!config) return { sent: 0 };
  let claimed: string[] = [];
  try {
    await Promise.all([ensureDashSchema(), ensureSentTable()]);
    const since = new Date(now.getTime() - TILL_SALES_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
    // Claimed in the same statement that picks them, so two pushes at once never send a sale twice.
    const rows = (await sql()`
      WITH pick AS (
        SELECT o.id, o.paid_at, o.net_cents, o.customer_phone, o.customer_name
          FROM dash_orders o
         WHERE o.counted AND o.paid_at IS NOT NULL AND o.deleted IS NULL
           AND o.source <> 'web' AND o.mode <> 'foodpanda'
           AND o.customer_phone IS NOT NULL AND o.net_cents > 0
           AND o.paid_at > ${since} AND o.paid_at <= ${now.toISOString()}
           AND NOT EXISTS (SELECT 1 FROM capi_till_sales s WHERE s.order_id = o.id)
         ORDER BY o.paid_at
         LIMIT ${BATCH}
      ), claimed AS (
        INSERT INTO capi_till_sales (order_id) SELECT id FROM pick ON CONFLICT (order_id) DO NOTHING RETURNING order_id
      )
      SELECT p.id, p.paid_at, p.net_cents, p.customer_phone, p.customer_name
        FROM pick p JOIN claimed c ON c.order_id = p.id
    `) as Array<{ id: string; paid_at: string | Date; net_cents: unknown; customer_phone: string | null; customer_name: string | null }>;
    const events: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      const e = tillSaleEvent({ id: r.id, paidAt: new Date(r.paid_at), netCents: Number(r.net_cents), phone: r.customer_phone, name: r.customer_name });
      // A number Meta cannot match stays claimed: it never will be.
      if (e) {
        events.push(e);
        claimed.push(r.id);
      }
    }
    if (events.length === 0) return { sent: 0 };
    const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${config.pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: events, access_token: config.accessToken }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as { events_received?: number; error?: { message?: string; code?: number } } | null;
    if (!res.ok) throw new Error(`${body?.error?.code ?? res.status}: ${String(body?.error?.message ?? 'no message').slice(0, 300)}`);
    return { sent: typeof body?.events_received === 'number' ? body.events_received : events.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('till sales to Meta failed', error);
    // Not sent: free them for the next push.
    if (claimed.length > 0) await sql()`DELETE FROM capi_till_sales WHERE order_id = ANY(${claimed})`.catch(() => undefined);
    claimed = [];
    return { sent: 0, error };
  }
}
