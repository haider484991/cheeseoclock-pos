import { sql } from './db';
import { ensureDashSchema } from './dashboard/schema';
import { GRAPH_VERSION } from './meta-capi';
import { probeThenCreate } from './schema-on-demand';
import { ensureWhatsappSchema } from './whatsapp-store';

/**
 * Orders from Click-to-WhatsApp ads to Meta (28 Oct 2026, the user: "Can you check the conversion so it optimizes
 * around the WhatsApp order confirmed conversion?", then "Yes, build it"). Meta's Conversions API for business
 * messaging: a Purchase carrying the ad click's id (ctwa_clid, kept with every message an ad brought: lib/whatsapp-store)
 * goes to the dataset of the shop's WhatsApp Business account. Ads Manager then counts each ad's orders and their
 * value, and an ad set can later be told to aim for orders rather than chats.
 *
 * An order comes two ways: the bot places it (sendBotOrderToMeta, from lib/whatsapp-bot-run once the customer has
 * its confirmation), or staff take it in the chat or on the phone and the till records it with the customer's number
 * (sendTillOrdersToMeta, after each dashboard push; website orders, the bot's among them, are left to the first way).
 * Either way only a chat an ad brought in the CLICK_WINDOW_DAYS before the order counts, each order is sent once
 * (capi_wa_orders: Meta does not de-duplicate these), and neither the bot nor the till's push ever waits on a failure.
 *
 * Off unless WHATSAPP_DATASET_ID (the account's dataset: GET /{account}/dataset), WHATSAPP_BUSINESS_ACCOUNT_ID and
 * WHATSAPP_ACCESS_TOKEN (with whatsapp_business_manage_events) are set.
 */
export const CLICK_WINDOW_DAYS = 7;
const BATCH = 50;
const SEND_TIMEOUT_MS = 8000;

export interface MessagingCapiConfig {
  datasetId: string;
  wabaId: string;
  token: string;
}

export function messagingCapiConfig(env: Record<string, string | undefined> = process.env): MessagingCapiConfig | null {
  const datasetId = (env['WHATSAPP_DATASET_ID'] ?? '').trim();
  const wabaId = (env['WHATSAPP_BUSINESS_ACCOUNT_ID'] ?? '').trim();
  const token = (env['WHATSAPP_ACCESS_TOKEN'] ?? '').trim();
  return /^\d{5,30}$/.test(datasetId) && /^\d{5,30}$/.test(wabaId) && token ? { datasetId, wabaId, token } : null;
}

let ready: Promise<void> | null = null;
function ensureSentTable(): Promise<void> {
  if (!ready) {
    ready = probeThenCreate(() => sql()`SELECT order_key FROM capi_wa_orders LIMIT 0`, async () => {
      await sql()`
        CREATE TABLE IF NOT EXISTS capi_wa_orders (
          order_key TEXT PRIMARY KEY,
          wa_id     TEXT NOT NULL,
          sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    }).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/** One order as Meta's business-messaging Purchase (its documented shape: action_source, channel, the click id). */
export function messagingPurchase(o: { at: Date; ctwaClid: string; valueCents: number }, wabaId: string): Record<string, unknown> {
  return {
    event_name: 'Purchase',
    event_time: Math.floor(o.at.getTime() / 1000),
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: { whatsapp_business_account_id: wabaId, ctwa_clid: o.ctwaClid },
    custom_data: { currency: 'PKR', value: o.valueCents / 100 },
  };
}

/** Sends the events; throws with Meta's words when they are refused. */
async function post(events: Array<Record<string, unknown>>, config: MessagingCapiConfig, fetchImpl: typeof fetch): Promise<number> {
  const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${config.datasetId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ data: events }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as { events_received?: number; error?: { message?: string; code?: number } } | null;
  if (!res.ok) throw new Error(`${body?.error?.code ?? res.status}: ${String(body?.error?.message ?? 'no message').slice(0, 300)}`);
  return typeof body?.events_received === 'number' ? body.events_received : events.length;
}

/**
 * A bot order: its Purchase, when an ad brought the chat in the week before. Sent once (a second call for the same
 * order sends nothing). Never throws; `sent` says whether Meta took it.
 */
export async function sendBotOrderToMeta(
  o: { waId: string; orderId: string; totalCents: number; at: Date },
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean; error?: string }> {
  const config = messagingCapiConfig();
  if (!config || !(o.totalCents > 0)) return { sent: false };
  const key = `web-${o.orderId}`;
  let claimed = false;
  try {
    await Promise.all([ensureWhatsappSchema(), ensureSentTable()]);
    const since = new Date(o.at.getTime() - CLICK_WINDOW_DAYS * 86_400_000).toISOString();
    const clicks = (await sql()`
      SELECT ctwa_clid FROM wa_events
       WHERE wa_id = ${o.waId} AND direction = 'in' AND ctwa_clid IS NOT NULL AND at <= ${o.at.toISOString()} AND at > ${since}
       ORDER BY at DESC LIMIT 1
    `) as Array<{ ctwa_clid: string }>;
    const clid = clicks[0]?.ctwa_clid;
    if (!clid) return { sent: false };
    claimed = ((await sql()`
      INSERT INTO capi_wa_orders (order_key, wa_id) VALUES (${key}, ${o.waId}) ON CONFLICT (order_key) DO NOTHING RETURNING order_key
    `) as unknown[]).length > 0;
    if (!claimed) return { sent: false };
    await post([messagingPurchase({ at: o.at, ctwaClid: clid, valueCents: o.totalCents }, config.wabaId)], config, fetchImpl);
    return { sent: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('whatsapp order to Meta failed', error);
    // Not sent: free it, so it can go another time.
    if (claimed) await sql()`DELETE FROM capi_wa_orders WHERE order_key = ${key}`.catch(() => undefined);
    return { sent: false, error };
  }
}

/**
 * The till's paid orders of the last CLICK_WINDOW_DAYS whose number wrote to the shop from an ad in the week before
 * them — orders staff took in the chat or on the phone (the bot's and the website's come as website orders and are
 * left out; so are foodpanda's) — each sent once, at most BATCH a time. Never throws; resolves to how many Meta took.
 */
export async function sendTillOrdersToMeta(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<{ sent: number; error?: string }> {
  const config = messagingCapiConfig();
  if (!config) return { sent: 0 };
  let claimed: string[] = [];
  try {
    await Promise.all([ensureDashSchema(), ensureWhatsappSchema(), ensureSentTable()]);
    const since = new Date(now.getTime() - CLICK_WINDOW_DAYS * 86_400_000).toISOString();
    // Claimed in the statement that picks them, so two pushes at once never send an order twice.
    const rows = (await sql()`
      WITH pick AS (
        SELECT DISTINCT ON (o.id) o.id, o.paid_at, o.net_cents, c.wa_id, e.ctwa_clid
          FROM dash_orders o
          JOIN wa_chats c ON right(regexp_replace(COALESCE(o.customer_phone, ''), '\\D', '', 'g'), 10) = right(c.wa_id, 10)
          JOIN wa_events e ON e.wa_id = c.wa_id AND e.direction = 'in' AND e.ctwa_clid IS NOT NULL
                          AND e.at <= o.paid_at AND e.at > o.paid_at - make_interval(days => ${CLICK_WINDOW_DAYS})
         WHERE o.counted AND o.paid_at IS NOT NULL AND o.deleted IS NULL
           AND o.source <> 'web' AND o.mode <> 'foodpanda' AND o.net_cents > 0
           AND o.paid_at > ${since} AND o.paid_at <= ${now.toISOString()}
           AND NOT EXISTS (SELECT 1 FROM capi_wa_orders s WHERE s.order_key = 'till-' || o.id)
         ORDER BY o.id, e.at DESC
         LIMIT ${BATCH}
      ), claimed AS (
        INSERT INTO capi_wa_orders (order_key, wa_id) SELECT 'till-' || id, wa_id FROM pick ON CONFLICT (order_key) DO NOTHING RETURNING order_key
      )
      SELECT p.id, p.paid_at, p.net_cents, p.ctwa_clid
        FROM pick p JOIN claimed c ON c.order_key = 'till-' || p.id
    `) as Array<{ id: string; paid_at: string | Date; net_cents: unknown; ctwa_clid: string }>;
    if (rows.length === 0) return { sent: 0 };
    claimed = rows.map((r) => `till-${r.id}`);
    const events = rows.map((r) => messagingPurchase({ at: new Date(r.paid_at), ctwaClid: r.ctwa_clid, valueCents: Number(r.net_cents) }, config.wabaId));
    return { sent: await post(events, config, fetchImpl) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('till orders from WhatsApp ads to Meta failed', error);
    // Not sent: free them for the next push.
    if (claimed.length > 0) await sql()`DELETE FROM capi_wa_orders WHERE order_key = ANY(${claimed})`.catch(() => undefined);
    return { sent: 0, error };
  }
}
