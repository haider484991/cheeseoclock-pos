/**
 * Orders from WhatsApp ads to Meta (lib/whatsapp-conversions, 28 Oct 2026): a Purchase with the ad click's id, to the
 * WhatsApp account's dataset, for a bot order or a till order whose number wrote from an ad in the week before — each
 * once; chats no ad brought, website and foodpanda orders, unpaid ones and old clicks never; a refused send is freed.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { messagingCapiConfig, messagingPurchase, sendBotOrderToMeta, sendTillOrdersToMeta } = await import('./whatsapp-conversions');

const ENV = { WHATSAPP_DATASET_ID: '2142301696356802', WHATSAPP_BUSINESS_ACCOUNT_ID: '1881791873188347', WHATSAPP_ACCESS_TOKEN: 'test-wa-token' };
const AD_CHAT = '923001112233';
const PLAIN_CHAT = '923004445566';
const CLICK_AT = '2026-10-28T09:00:00Z';

const calls: Array<{ url: string; auth: string | null; body: { data: Array<Record<string, unknown>> } }> = [];
let answer: () => Response = () => Response.json({ events_received: 1 });
const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
  return answer();
}) as unknown as typeof fetch;

async function chat(waId: string, o: { clid?: string; at?: string } = {}) {
  const at = o.at ?? CLICK_AT;
  await db.pg.query(
    `INSERT INTO wa_chats (wa_id, phone, profile_name, first_at, last_in_at, inbound_count, ad_id) VALUES ($1, $2, 'Ali', $3, $3, 1, $4)
     ON CONFLICT (wa_id) DO NOTHING`,
    [waId, `+${waId}`, at, o.clid ? '120251397240540193' : null],
  );
  await db.pg.query(
    `INSERT INTO wa_events (id, wa_id, direction, kind, at, ad_id, ctwa_clid) VALUES ($1, $2, 'in', 'text', $3, $4, $5)`,
    [`wamid.${waId}.${at}`, waId, at, o.clid ? '120251397240540193' : null, o.clid ?? null],
  );
}

async function tillOrder(id: string, o: { phone?: string; source?: string; mode?: string; paid?: string | null; net?: number; counted?: boolean }) {
  const paid = o.paid === undefined ? '2026-10-28T11:00:00Z' : o.paid;
  await db.pg.query(
    `INSERT INTO dash_orders (id, device_id, number, status, mode, source, channel, created_at, paid_at, trading_day, hour, counted,
                              subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, net_cents, customer_name, customer_phone,
                              item_count, doc, doc_updated_at)
     VALUES ($1, 'till-1', $1, 'paid', $2, $3, $2, COALESCE($4::timestamptz, now()), $4, '2026-10-28', 11, $5,
             $6, 0, 0, $6, 0, $6, 'Ali', $7, 1, '{}', now())`,
    [id, o.mode ?? 'takeaway', o.source ?? 'pos', paid, o.counted ?? true, o.net ?? 182_480, o.phone ?? '0300 1112233'],
  );
}

beforeAll(async () => {
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  Object.assign(process.env, ENV);
  calls.length = 0;
  answer = () => Response.json({ events_received: 1 });
  for (const t of ['capi_wa_orders', 'dash_orders', 'wa_events', 'wa_chats']) await db.pg.query(`DELETE FROM ${t}`, []);
  await chat(AD_CHAT, { clid: 'clid-from-the-ad' });
  await chat(PLAIN_CHAT);
});

afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
});

describe('orders from WhatsApp ads to Meta', () => {
  it('is Meta’s business-messaging Purchase: the click id, the WhatsApp account, the value in rupees', () => {
    expect(messagingPurchase({ at: new Date('2026-10-28T11:00:00Z'), ctwaClid: 'clid-x', valueCents: 182_480 }, '1881791873188347')).toEqual({
      event_name: 'Purchase',
      event_time: Math.floor(Date.parse('2026-10-28T11:00:00Z') / 1000),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: '1881791873188347', ctwa_clid: 'clid-x' },
      custom_data: { currency: 'PKR', value: 1824.8 },
    });
    expect(messagingCapiConfig({})).toBeNull();
    expect(messagingCapiConfig({ ...ENV, WHATSAPP_DATASET_ID: 'not-a-number' })).toBeNull();
  });

  it('a bot order from an ad’s chat goes once, to the account’s dataset with its token; a chat no ad brought, or an old click, never', async () => {
    const at = new Date('2026-10-28T10:00:00Z');
    expect(await sendBotOrderToMeta({ waId: AD_CHAT, orderId: 'order-1', totalCents: 218_150, at }, fakeFetch)).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v26.0/2142301696356802/events');
    expect(calls[0]!.auth).toBe('Bearer test-wa-token');
    expect(calls[0]!.body.data).toEqual([messagingPurchase({ at, ctwaClid: 'clid-from-the-ad', valueCents: 218_150 }, '1881791873188347')]);

    expect(await sendBotOrderToMeta({ waId: AD_CHAT, orderId: 'order-1', totalCents: 218_150, at }, fakeFetch)).toEqual({ sent: false });
    expect(await sendBotOrderToMeta({ waId: PLAIN_CHAT, orderId: 'order-2', totalCents: 90_000, at }, fakeFetch)).toEqual({ sent: false });
    const weekLater = new Date('2026-11-05T10:00:00Z');
    expect(await sendBotOrderToMeta({ waId: AD_CHAT, orderId: 'order-3', totalCents: 90_000, at: weekLater }, fakeFetch)).toEqual({ sent: false });
    expect(calls).toHaveLength(1);
  });

  it('switched off without the dataset, the account or the token: nothing goes', async () => {
    delete process.env['WHATSAPP_DATASET_ID'];
    expect(await sendBotOrderToMeta({ waId: AD_CHAT, orderId: 'order-1', totalCents: 218_150, at: new Date('2026-10-28T10:00:00Z') }, fakeFetch)).toEqual({ sent: false });
    await tillOrder('t-1', {});
    expect(await sendTillOrdersToMeta(new Date('2026-10-28T12:00:00Z'), fakeFetch)).toEqual({ sent: 0 });
    expect(calls).toEqual([]);
  });

  it('a refused send is freed and goes next time', async () => {
    const at = new Date('2026-10-28T10:00:00Z');
    answer = () => Response.json({ error: { code: 100, message: 'Invalid parameter' } }, { status: 400 });
    expect(await sendBotOrderToMeta({ waId: AD_CHAT, orderId: 'order-1', totalCents: 218_150, at }, fakeFetch)).toMatchObject({ sent: false, error: '100: Invalid parameter' });
    answer = () => Response.json({ events_received: 1 });
    expect(await sendBotOrderToMeta({ waId: AD_CHAT, orderId: 'order-1', totalCents: 218_150, at }, fakeFetch)).toEqual({ sent: true });
  });

  it('till orders: a paid one from the ad chat’s number after the click goes once; website, foodpanda, unpaid, uncounted, before the click and other numbers never', async () => {
    await tillOrder('t-paid', {});
    await tillOrder('t-web', { source: 'web' });
    await tillOrder('t-panda', { mode: 'foodpanda' });
    await tillOrder('t-unpaid', { paid: null });
    await tillOrder('t-void', { counted: false });
    await tillOrder('t-before', { paid: '2026-10-28T08:00:00Z' });
    await tillOrder('t-other', { phone: '0300 9998877' });
    await tillOrder('t-plain', { phone: '0300 4445566' });
    const now = new Date('2026-10-28T12:00:00Z');
    expect(await sendTillOrdersToMeta(now, fakeFetch)).toEqual({ sent: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.data).toEqual([messagingPurchase({ at: new Date('2026-10-28T11:00:00Z'), ctwaClid: 'clid-from-the-ad', valueCents: 182_480 }, '1881791873188347')]);
    expect(await sendTillOrdersToMeta(now, fakeFetch)).toEqual({ sent: 0 });
    expect(calls).toHaveLength(1);
  });

  it('a refused till send frees its orders for the next push', async () => {
    await tillOrder('t-paid', {});
    const now = new Date('2026-10-28T12:00:00Z');
    answer = () => new Response('nope', { status: 500 });
    expect(await sendTillOrdersToMeta(now, fakeFetch)).toMatchObject({ sent: 0 });
    answer = () => Response.json({ events_received: 1 });
    expect(await sendTillOrdersToMeta(now, fakeFetch)).toEqual({ sent: 1 });
  });
});
