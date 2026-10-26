import { randomBytes } from 'node:crypto';
import { sql } from './db';
import { normalizePhone } from './format';
import { probeThenCreate } from './schema-on-demand';

/**
 * The shop's WhatsApp chats (26 Oct 2026, the user: "build it and fix everything needed to control whatsapp and pick
 * order directly from whatsapp to till"). The shop's number is on Meta's Cloud API beside the WhatsApp Business app
 * on the phone (coexistence): staff keep chatting on the phone; Meta's webhook tells the website of every message
 * (api/whatsapp/webhook), and the website keeps:
 *
 *   wa_chats   one row per customer: their number, WhatsApp name, when they wrote, the last ad that brought them
 *              (a Click-to-WhatsApp ad's referral), when staff last wrote to them, when the bot last replied.
 *   wa_events  one row per message, in and out: who, when, what kind (text, image…) and the ad — never the words.
 *   wa_links   the personal order links the bot sends (/menu?wa=TOKEN): the checkout fills in the customer's name
 *              and number, and an order placed with one is a WhatsApp order (wa_orders), to the till as any other.
 *   wa_orders  the website orders placed through a link, with the ad that brought the chat.
 *
 * Made on demand (the menu-deploy pattern) as well as in db/schema.sql, so the live database needs no hand migration.
 */
let ready: Promise<void> | null = null;

export function ensureWhatsappSchema(): Promise<void> {
  if (!ready) {
    // The newest table answers for the lot (schema-on-demand): one read per instance, the DDL only when it is missing.
    ready = probeThenCreate(() => sql()`SELECT order_id FROM wa_orders LIMIT 0`, async () => {
      await sql()`
        CREATE TABLE IF NOT EXISTS wa_chats (
          wa_id         TEXT PRIMARY KEY,
          phone         TEXT NOT NULL,
          profile_name  TEXT,
          first_at      TIMESTAMPTZ NOT NULL,
          last_in_at    TIMESTAMPTZ NOT NULL,
          inbound_count INT NOT NULL DEFAULT 0,
          last_staff_at TIMESTAMPTZ,
          last_auto_at  TIMESTAMPTZ,
          ad_id         TEXT,
          ad_headline   TEXT,
          ad_at         TIMESTAMPTZ
        )
      `;
      await sql()`CREATE INDEX IF NOT EXISTS idx_wa_chats_phone ON wa_chats(phone)`;
      await sql()`
        CREATE TABLE IF NOT EXISTS wa_events (
          id            TEXT PRIMARY KEY,
          wa_id         TEXT NOT NULL,
          direction     TEXT NOT NULL CHECK (direction IN ('in', 'staff', 'bot')),
          kind          TEXT NOT NULL,
          at            TIMESTAMPTZ NOT NULL,
          ad_id         TEXT,
          ad_headline   TEXT,
          ad_source_url TEXT,
          ctwa_clid     TEXT
        )
      `;
      await sql()`CREATE INDEX IF NOT EXISTS idx_wa_events_at ON wa_events(at)`;
      await sql()`CREATE INDEX IF NOT EXISTS idx_wa_events_chat ON wa_events(wa_id, at)`;
      await sql()`
        CREATE TABLE IF NOT EXISTS wa_links (
          token      TEXT PRIMARY KEY,
          wa_id      TEXT NOT NULL,
          ad_id      TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql()`CREATE INDEX IF NOT EXISTS idx_wa_links_chat ON wa_links(wa_id, created_at)`;
      await sql()`
        CREATE TABLE IF NOT EXISTS wa_orders (
          order_id UUID PRIMARY KEY,
          token    TEXT NOT NULL,
          wa_id    TEXT NOT NULL,
          ad_id    TEXT,
          at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql()`CREATE INDEX IF NOT EXISTS idx_wa_orders_at ON wa_orders(at)`;
    }).catch((e) => {
      // Let the next call retry rather than caching the failure forever.
      ready = null;
      throw e;
    });
  }
  return ready;
}

/** The ad a Click-to-WhatsApp chat came from (the message's `referral`), as kept. */
export interface WaAd {
  id: string | null;
  headline: string | null;
  sourceUrl: string | null;
  ctwaClid: string | null;
}

/** A customer's message, as the webhook read it. */
export interface WaInbound {
  messageId: string;
  waId: string;
  profileName: string | null;
  kind: string;
  at: Date;
  ad: WaAd | null;
}

/**
 * Keeps one customer message. False when Meta sent it before (it retries a webhook it thinks failed): nothing is
 * counted twice and the bot never answers it twice.
 */
export async function recordInbound(m: WaInbound): Promise<boolean> {
  await ensureWhatsappSchema();
  const fresh = (await sql()`
    INSERT INTO wa_events (id, wa_id, direction, kind, at, ad_id, ad_headline, ad_source_url, ctwa_clid)
    VALUES (${m.messageId}, ${m.waId}, 'in', ${m.kind}, ${m.at.toISOString()},
            ${m.ad?.id ?? null}, ${m.ad?.headline ?? null}, ${m.ad?.sourceUrl ?? null}, ${m.ad?.ctwaClid ?? null})
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `) as unknown[];
  if (fresh.length === 0) return false;
  const phone = normalizePhone(m.waId) ?? `+${m.waId}`;
  const at = m.at.toISOString();
  await sql()`
    INSERT INTO wa_chats (wa_id, phone, profile_name, first_at, last_in_at, inbound_count, ad_id, ad_headline, ad_at)
    VALUES (${m.waId}, ${phone}, ${m.profileName}, ${at}, ${at}, 1,
            ${m.ad?.id ?? null}, ${m.ad?.headline ?? null}, ${m.ad ? at : null})
    ON CONFLICT (wa_id) DO UPDATE SET
      profile_name  = COALESCE(EXCLUDED.profile_name, wa_chats.profile_name),
      last_in_at    = GREATEST(wa_chats.last_in_at, EXCLUDED.last_in_at),
      inbound_count = wa_chats.inbound_count + 1,
      ad_id         = COALESCE(EXCLUDED.ad_id, wa_chats.ad_id),
      ad_headline   = CASE WHEN EXCLUDED.ad_id IS NULL THEN wa_chats.ad_headline ELSE EXCLUDED.ad_headline END,
      ad_at         = COALESCE(EXCLUDED.ad_at, wa_chats.ad_at)
  `;
  return true;
}

/** A message staff sent from the WhatsApp Business app on the phone (Meta's "echo" of it). */
export async function recordStaffMessage(e: { messageId: string; waId: string; kind: string; at: Date }): Promise<void> {
  await ensureWhatsappSchema();
  const fresh = (await sql()`
    INSERT INTO wa_events (id, wa_id, direction, kind, at)
    VALUES (${e.messageId}, ${e.waId}, 'staff', ${e.kind}, ${e.at.toISOString()})
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `) as unknown[];
  if (fresh.length === 0) return;
  // A chat staff start themselves has no row yet: it gets one, so their reply still holds the bot back.
  await sql()`
    INSERT INTO wa_chats (wa_id, phone, first_at, last_in_at, inbound_count, last_staff_at)
    VALUES (${e.waId}, ${normalizePhone(e.waId) ?? `+${e.waId}`}, ${e.at.toISOString()}, ${e.at.toISOString()}, 0,
            ${e.at.toISOString()})
    ON CONFLICT (wa_id) DO UPDATE SET
      last_staff_at = GREATEST(COALESCE(wa_chats.last_staff_at, EXCLUDED.last_staff_at), EXCLUDED.last_staff_at)
  `;
}

/** The bot's own message, once Meta took it. */
export async function recordBotMessage(e: { messageId: string; waId: string; at: Date }): Promise<void> {
  await sql()`
    INSERT INTO wa_events (id, wa_id, direction, kind, at)
    VALUES (${e.messageId}, ${e.waId}, 'bot', 'text', ${e.at.toISOString()})
    ON CONFLICT (id) DO NOTHING
  `;
}

/** The shop's day starts at 5 AM Karachi (it closes at 1 AM): a message at 12:30 AM belongs to the evening before. */
const DAY_STARTS_AT_HOUR = 5;
const KARACHI_OFFSET_MS = 5 * 60 * 60_000;

/** When the shop's current day began (5 AM Karachi), as an instant. */
export function shopDayStart(now: Date): Date {
  const local = new Date(now.getTime() + KARACHI_OFFSET_MS - DAY_STARTS_AT_HOUR * 60 * 60_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnight - KARACHI_OFFSET_MS + DAY_STARTS_AT_HOUR * 60 * 60_000);
}

/** Staff wrote to the customer this recently: they are mid-conversation, so the bot keeps out of it. */
export const STAFF_QUIET_MS = 60 * 60_000;

/**
 * Takes the day's one automatic reply for this customer, if it is still free (the user, 26 Oct 2026: "Bot, first
 * message a day"): none sent since the shop's day began, and staff have not written to them in the last hour. One
 * statement (the row's lock), so three messages sent at once get one reply between them.
 */
export async function claimAutoReply(waId: string, now: Date): Promise<boolean> {
  const rows = (await sql()`
    UPDATE wa_chats SET last_auto_at = ${now.toISOString()}
     WHERE wa_id = ${waId}
       AND (last_auto_at IS NULL OR last_auto_at < ${shopDayStart(now).toISOString()})
       AND (last_staff_at IS NULL OR last_staff_at < ${new Date(now.getTime() - STAFF_QUIET_MS).toISOString()})
    RETURNING wa_id
  `) as unknown[];
  return rows.length > 0;
}

/** Sending failed: the day's reply is free again, so the customer's next message tries once more. */
export async function releaseAutoReply(waId: string, claimedAt: Date): Promise<void> {
  await sql()`UPDATE wa_chats SET last_auto_at = NULL WHERE wa_id = ${waId} AND last_auto_at = ${claimedAt.toISOString()}`;
}

/** A link stays good this long: an order a few days later from the same chat still counts as WhatsApp's. */
export const LINK_TTL_MS = 3 * 24 * 60 * 60_000;

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TOKEN_LENGTH = 12;
/** What a link's token looks like (wa-link.ts checks the same before it keeps one). */
export const WA_TOKEN = /^[A-Za-z0-9]{10,16}$/;

function newToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let out = '';
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

/** A new personal order link for this customer, carrying the ad their chat came from. */
export async function createLink(waId: string): Promise<string> {
  await ensureWhatsappSchema();
  const token = newToken();
  await sql()`
    INSERT INTO wa_links (token, wa_id, ad_id)
    SELECT ${token}, ${waId}, (SELECT ad_id FROM wa_chats WHERE wa_id = ${waId})
  `;
  return token;
}

/** Whose link this is: their WhatsApp name and number, and the ad. Null for an unknown or expired link. */
export interface WaLinkOwner {
  token: string;
  waId: string;
  name: string | null;
  /** As the checkout stores numbers (+923001234567). */
  phone: string;
  adId: string | null;
}

export async function resolveLink(token: string, now: Date = new Date()): Promise<WaLinkOwner | null> {
  if (!WA_TOKEN.test(token)) return null;
  await ensureWhatsappSchema();
  const rows = (await sql()`
    SELECT l.token, l.wa_id, l.ad_id, c.profile_name, c.phone
      FROM wa_links l JOIN wa_chats c ON c.wa_id = l.wa_id
     WHERE l.token = ${token} AND l.created_at > ${new Date(now.getTime() - LINK_TTL_MS).toISOString()}
  `) as Array<{ token: string; wa_id: string; ad_id: string | null; profile_name: string | null; phone: string }>;
  const r = rows[0];
  return r ? { token: r.token, waId: r.wa_id, name: r.profile_name, phone: r.phone, adId: r.ad_id } : null;
}

/** "+923001234567" as the checkout's phone box shows a number: "0300 1234567". */
export function localPhone(e164: string): string {
  return /^\+92\d{10}$/.test(e164) ? `0${e164.slice(3, 6)} ${e164.slice(6)}` : e164;
}

/** A website order placed through a link: it is the chat's, and the ad's. */
export async function recordLinkOrder(orderId: string, link: WaLinkOwner): Promise<void> {
  await sql()`
    INSERT INTO wa_orders (order_id, token, wa_id, ad_id)
    VALUES (${orderId}, ${link.token}, ${link.waId}, ${link.adId})
    ON CONFLICT (order_id) DO NOTHING
  `;
}
