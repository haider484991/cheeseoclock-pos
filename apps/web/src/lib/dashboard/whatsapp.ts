import { sql } from '../db';
import { msOf, addDays } from './period';
import { ensureDashSchema } from './schema';
import { ensureWhatsappSchema } from '../whatsapp-store';

/**
 * The dashboard's WhatsApp page (26 Oct 2026, lib/whatsapp-store): who wrote to the shop on WhatsApp in a period of
 * trading days, which ads brought them, and what they bought.
 *
 * "Ordered" is any till order to the customer's number within ORDER_WINDOW_DAYS after they wrote — the cashier's
 * own orders taken on the phone as well as the website orders placed through the bot's link — so it needs nothing
 * from staff. Numbers are compared by their last ten digits (the till keeps what the cashier typed).
 */
export const ORDER_WINDOW_DAYS = 3;

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** A period's first instant and the instant after its last day (a trading day is the UTC date, 05:00 Karachi). */
function span(from: string, to: string): { start: string; end: string } {
  return { start: new Date(msOf(from)).toISOString(), end: new Date(msOf(addDays(to, 1))).toISOString() };
}

async function ready(): Promise<void> {
  await Promise.all([ensureDashSchema(), ensureWhatsappSchema()]);
}

export interface WaSummary {
  /** Customers who wrote in the period. */
  customers: number;
  /** …of whom wrote for the first time ever. */
  firstTime: number;
  /** …who came from a Click-to-WhatsApp ad (any of their messages in the period carried one). */
  fromAds: number;
  messagesIn: number;
  botReplies: number;
  staffReplies: number;
  /** Customers who wrote and then had a till order within the window, and those orders. */
  buyers: number;
  orders: number;
  salesCents: number;
  /** Website orders placed through the bot's link (not cancelled). */
  linkOrders: number;
  linkSalesCents: number;
}

/** A till order after a chat (ORDERS_AFTER_CHATS). */
interface AfterRow {
  id: string;
  net_cents: unknown;
  wa_id: string;
  ad_id: string | null;
  ad_headline: string | null;
}

/**
 * The till orders after a chat: each counted order (dash_orders) whose number wrote to the shop in the
 * ORDER_WINDOW_DAYS before it, once, with that chat's latest ad.
 */
async function ordersAfterChats(start: string, end: string): Promise<AfterRow[]> {
  return (await sql()`
    SELECT DISTINCT ON (o.id) o.id, o.net_cents, c.wa_id, c.ad_id, c.ad_headline
      FROM dash_orders o
      JOIN wa_chats c ON right(regexp_replace(COALESCE(o.customer_phone, ''), '\\D', '', 'g'), 10) = right(c.wa_id, 10)
      JOIN wa_events e ON e.wa_id = c.wa_id AND e.direction = 'in'
                      AND e.at <= o.created_at AND e.at > o.created_at - make_interval(days => ${ORDER_WINDOW_DAYS})
     WHERE o.created_at >= ${start} AND o.created_at < ${end} AND o.counted
     ORDER BY o.id`) as AfterRow[];
}

export async function getWhatsappSummary(from: string, to: string): Promise<WaSummary> {
  await ready();
  const { start, end } = span(from, to);
  return summaryOf(start, end, await ordersAfterChats(start, end));
}

/** The period's figures in one statement: who wrote, the bot's and staff's messages, the orders through the link. */
async function summaryOf(start: string, end: string, after: readonly AfterRow[]): Promise<WaSummary> {
  const rows = (await sql()`
    SELECT c.customers, c.first_time, c.from_ads, c.messages, s.bot, s.staff, l.orders, l.cents
      FROM (SELECT count(DISTINCT e.wa_id) AS customers,
                   count(DISTINCT e.wa_id) FILTER (WHERE ch.first_at >= ${start}) AS first_time,
                   count(DISTINCT e.wa_id) FILTER (WHERE e.ad_id IS NOT NULL) AS from_ads,
                   count(*) AS messages
              FROM wa_events e JOIN wa_chats ch ON ch.wa_id = e.wa_id
             WHERE e.direction = 'in' AND e.at >= ${start} AND e.at < ${end}) c,
           (SELECT count(*) FILTER (WHERE direction = 'bot') AS bot, count(*) FILTER (WHERE direction = 'staff') AS staff
              FROM wa_events WHERE direction <> 'in' AND at >= ${start} AND at < ${end}) s,
           (SELECT count(*) AS orders, COALESCE(sum(w.total_cents), 0) AS cents
              FROM wa_orders l JOIN web_orders w ON w.id = l.order_id
             WHERE l.at >= ${start} AND l.at < ${end} AND w.status <> 'cancelled') l`) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  return {
    customers: n(r['customers']),
    firstTime: n(r['first_time']),
    fromAds: n(r['from_ads']),
    messagesIn: n(r['messages']),
    botReplies: n(r['bot']),
    staffReplies: n(r['staff']),
    buyers: new Set(after.map((a) => a.wa_id)).size,
    orders: after.length,
    salesCents: after.reduce((sum, a) => sum + n(a.net_cents), 0),
    linkOrders: n(r['orders']),
    linkSalesCents: n(r['cents']),
  };
}

/**
 * Everything the WhatsApp page shows, in five reads (27 Oct 2026: the page made nine, three of them the same orders
 * read again, and each read waits its turn on a Cloudflare request's two connections).
 */
export async function getWhatsappPage(
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<{ summary: WaSummary; byAd: WaAdRow[]; chats: WaChatRow[]; botThisMonth: number }> {
  await ready();
  const { start, end } = span(from, to);
  const [after, botThisMonth] = await Promise.all([ordersAfterChats(start, end), botMessagesSince(monthStart(now))]);
  const [summary, byAd, chats] = await Promise.all([summaryOf(start, end, after), byAdOf(start, end, after), chatsOf(start, end, after, 30)]);
  return { summary, byAd, chats, botThisMonth };
}

/**
 * Meta's free tier (from 1 Oct 2026): 1,000 service messages a month per number; after that each is charged, and with
 * no payment method on the account Meta stops delivering them — the bot would go quiet until the 1st. Staff's own
 * messages from the phone app are not part of it.
 */
export const FREE_SERVICE_MESSAGES = 1000;

/** The bot's messages (and order updates) sent since the 1st of this month (UTC, as Meta counts). */
export async function getBotMessagesThisMonth(now: Date = new Date()): Promise<number> {
  await ready();
  return botMessagesSince(monthStart(now));
}

/** The 1st of `now`'s month, UTC (as Meta counts). */
function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function botMessagesSince(start: string): Promise<number> {
  const rows = (await sql()`
    SELECT count(*) AS n FROM wa_events WHERE direction = 'bot' AND at >= ${start}
  `) as Array<{ n: unknown }>;
  return n(rows[0]?.n);
}

export interface WaAdRow {
  /** Null: customers who wrote without an ad. */
  adId: string | null;
  headline: string | null;
  customers: number;
  orders: number;
  salesCents: number;
}

/** The period's customers and their orders by the ad that brought them (their chat's latest ad). */
export async function getWhatsappByAd(from: string, to: string): Promise<WaAdRow[]> {
  await ready();
  const { start, end } = span(from, to);
  return byAdOf(start, end, await ordersAfterChats(start, end));
}

async function byAdOf(start: string, end: string, after: readonly AfterRow[]): Promise<WaAdRow[]> {
  const chats = await sql()`
    SELECT c.ad_id, max(c.ad_headline) AS headline, count(DISTINCT c.wa_id) AS customers
      FROM wa_chats c
     WHERE EXISTS (SELECT 1 FROM wa_events e WHERE e.wa_id = c.wa_id AND e.direction = 'in' AND e.at >= ${start} AND e.at < ${end})
     GROUP BY c.ad_id`;
  const rows = new Map<string, WaAdRow>();
  for (const r of chats as Array<{ ad_id: string | null; headline: string | null; customers: unknown }>) {
    rows.set(r.ad_id ?? '', { adId: r.ad_id, headline: r.headline, customers: n(r.customers), orders: 0, salesCents: 0 });
  }
  for (const r of after) {
    const row = rows.get(r.ad_id ?? '') ?? { adId: r.ad_id, headline: r.ad_headline, customers: 0, orders: 0, salesCents: 0 };
    row.orders += 1;
    row.salesCents += n(r.net_cents);
    rows.set(r.ad_id ?? '', row);
  }
  return [...rows.values()].sort((x, y) => y.salesCents - x.salesCents || y.customers - x.customers);
}

export interface WaChatRow {
  waId: string;
  name: string | null;
  phone: string;
  /** Their first message in the period, and their latest. */
  firstAt: string;
  lastAt: string;
  messages: number;
  adHeadline: string | null;
  botReplied: boolean;
  staffReplied: boolean;
  orders: number;
}

/** The period's customers, latest first (at most `limit`). */
export async function getWhatsappChats(from: string, to: string, limit = 30): Promise<WaChatRow[]> {
  await ready();
  const { start, end } = span(from, to);
  return chatsOf(start, end, await ordersAfterChats(start, end), limit);
}

async function chatsOf(start: string, end: string, after: readonly AfterRow[], limit: number): Promise<WaChatRow[]> {
  const chats = await sql()`
    SELECT c.wa_id, c.profile_name, c.phone, c.ad_headline,
           min(e.at) FILTER (WHERE e.direction = 'in') AS first_at,
           max(e.at) FILTER (WHERE e.direction = 'in') AS last_at,
           count(*) FILTER (WHERE e.direction = 'in') AS messages,
           bool_or(e.direction = 'bot') AS bot, bool_or(e.direction = 'staff') AS staff
      FROM wa_chats c JOIN wa_events e ON e.wa_id = c.wa_id
     WHERE e.at >= ${start} AND e.at < ${end}
     GROUP BY c.wa_id, c.profile_name, c.phone, c.ad_headline
    HAVING count(*) FILTER (WHERE e.direction = 'in') > 0
     ORDER BY max(e.at) FILTER (WHERE e.direction = 'in') DESC
     LIMIT ${limit}`;
  const orders = new Map<string, number>();
  for (const r of after) orders.set(r.wa_id, (orders.get(r.wa_id) ?? 0) + 1);
  return (chats as Array<Record<string, unknown>>).map((r) => ({
    waId: String(r['wa_id']),
    name: (r['profile_name'] as string | null) ?? null,
    phone: String(r['phone']),
    firstAt: new Date(r['first_at'] as string).toISOString(),
    lastAt: new Date(r['last_at'] as string).toISOString(),
    messages: n(r['messages']),
    adHeadline: (r['ad_headline'] as string | null) ?? null,
    botReplied: r['bot'] === true,
    staffReplied: r['staff'] === true,
    orders: orders.get(String(r['wa_id'])) ?? 0,
  }));
}
