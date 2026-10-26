/**
 * The dashboard's WhatsApp page (lib/dashboard/whatsapp, 26 Oct 2026): a till order counts for a chat when it went to
 * the customer's number — as the cashier typed it — within three days after they wrote, once, with the chat's ad.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const store = await import('@/lib/whatsapp-store');
const wa = await import('./whatsapp');

const AD = '120251373303340193';
let seq = 0;
async function wrote(waId: string, at: string, ad?: string) {
  await store.recordInbound({
    messageId: `wamid.${++seq}`,
    waId,
    profileName: `Customer ${waId.slice(-2)}`,
    kind: 'text',
    at: new Date(at),
    ad: ad ? { id: ad, headline: 'Mega Cheese Box Rs 4,800', sourceUrl: null, ctwaClid: null } : null,
  });
}
async function tillOrder(phone: string, at: string, netRs: number, counted = true) {
  const id = `o-${++seq}`;
  await db.pg.query(
    `INSERT INTO dash_orders (id, device_id, number, status, mode, source, channel, created_at, trading_day, hour, counted,
                              subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, net_cents, customer_phone,
                              item_count, doc, doc_updated_at)
     VALUES ($1, 'till-1', $1, 'paid', 'delivery', 'pos', 'delivery', $2, ($2::timestamptz)::date, 0, $3,
             $4, 0, 0, $4, 0, $4, $5, 1, '{}', $2)`,
    [id, at, counted, netRs * 100, phone],
  );
}

beforeAll(async () => {
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8'));
  // Oct 26: A from the ad, then the cashier types her order (local format) an hour later and a second one two days on.
  await wrote('923001110001', '2026-10-26T09:00:00Z', AD);
  await tillOrder('0300 1110001', '2026-10-26T10:00:00Z', 4800);
  await tillOrder('03001110001', '2026-10-28T08:00:00Z', 1300);
  // B wrote by herself; her order comes four days later: too late to count.
  await wrote('923001110002', '2026-10-26T11:00:00Z');
  await tillOrder('+923001110002', '2026-10-30T12:00:00Z', 2000);
  // C from the ad, two messages; a cancelled order (not counted) and an order before she ever wrote.
  await tillOrder('0300 1110003', '2026-10-25T12:00:00Z', 900);
  await wrote('923001110003', '2026-10-26T12:00:00Z', AD);
  await wrote('923001110003', '2026-10-26T12:05:00Z');
  await tillOrder('0300 1110003', '2026-10-26T13:00:00Z', 3400, false);
  // A walk-in with no WhatsApp at all.
  await tillOrder('0321 9999999', '2026-10-26T13:00:00Z', 650);
});

describe('dashboard WhatsApp', () => {
  it('the period’s customers, from ads, and the orders after their chats', async () => {
    expect(await wa.getWhatsappSummary('2026-10-26', '2026-10-28')).toMatchObject({
      customers: 3,
      firstTime: 3,
      fromAds: 2,
      messagesIn: 4,
      buyers: 1,
      orders: 2,
      salesCents: 610_000,
    });
  });

  it('by ad: the ad’s customers and their sales; customers without an ad on their own row', async () => {
    const rows = await wa.getWhatsappByAd('2026-10-26', '2026-10-28');
    expect(rows).toEqual([
      { adId: AD, headline: 'Mega Cheese Box Rs 4,800', customers: 2, orders: 2, salesCents: 610_000 },
      { adId: null, headline: null, customers: 1, orders: 0, salesCents: 0 },
    ]);
  });

  it('latest chats first, with their orders', async () => {
    const chats = await wa.getWhatsappChats('2026-10-26', '2026-10-28');
    expect(chats.map((c) => [c.waId, c.messages, c.orders, c.adHeadline])).toEqual([
      ['923001110003', 2, 0, 'Mega Cheese Box Rs 4,800'],
      ['923001110002', 1, 0, null],
      ['923001110001', 1, 2, 'Mega Cheese Box Rs 4,800'],
    ]);
    expect(chats[2]).toMatchObject({ name: 'Customer 01', phone: '+923001110001', botReplied: false, staffReplied: false });
  });

  it('counts the bot’s messages since the 1st of the month, not last month’s or staff’s', async () => {
    for (const [id, dir, at] of [
      ['b1', 'bot', '2026-10-26T09:00:00Z'],
      ['b2', 'bot', '2026-10-01T00:00:01Z'],
      ['b3', 'bot', '2026-09-30T23:59:59Z'],
      ['s1', 'staff', '2026-10-26T09:00:00Z'],
    ] as const) {
      await db.pg.query(`INSERT INTO wa_events (id, wa_id, direction, kind, at) VALUES ($1, '923001110001', $2, 'text', $3)`, [id, dir, at]);
    }
    expect(await wa.getBotMessagesThisMonth(new Date('2026-10-26T12:00:00Z'))).toBe(2);
    expect(await wa.getBotMessagesThisMonth(new Date('2026-11-01T00:00:00Z'))).toBe(0);
  });

  it('a period with nobody writing is empty', async () => {
    expect(await wa.getWhatsappSummary('2026-10-20', '2026-10-21')).toMatchObject({ customers: 0, orders: 0, salesCents: 0 });
    expect(await wa.getWhatsappChats('2026-10-20', '2026-10-21')).toEqual([]);
  });
});
