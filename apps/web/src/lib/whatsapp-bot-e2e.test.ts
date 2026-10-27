/**
 * The WhatsApp ordering bot end to end (26 Oct 2026), on a real Postgres (PGlite with db/schema.sql) and the real
 * routes: Meta's signed webhook calls → the bot → the website's own order route (priced, then placed) → the till's
 * pull and ack → the customer's WhatsApp updates. Only Meta's Cloud API is a fake, recording what the shop sends.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedMenu, PublishedMenuItem } from '@cheeseoclock/shared-types';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SECRET = 'test-app-secret';
const BRIDGE = 'test-bridge-secret-0123456789';
const PHONE_ID = '1356740797521773';
const TESTER = '923088440608';
const TESTER_2 = '923001110000';
const TESTER_3 = '923001110003';
Object.assign(process.env, {
  META_APP_SECRET: SECRET,
  BRIDGE_SECRET: BRIDGE,
  WHATSAPP_ACCESS_TOKEN: 'test-token',
  WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
  WHATSAPP_ORDER_BOT: 'test',
  WHATSAPP_BOT_TESTERS: `+${TESTER},+${TESTER_2},+${TESTER_3}`,
  WHATSAPP_AUTO_REPLY: 'on',
});

const webhook = await import('@/app/api/whatsapp/webhook/route');
const bridgeStatus = await import('@/app/api/bridge/status/route');
const bridgeOrders = await import('@/app/api/bridge/orders/route');
const ack = await import('@/app/api/bridge/orders/[id]/ack/route');
const status = await import('@/app/api/bridge/orders/[id]/status/route');

/** Meta's Cloud API: every message the shop sends, as sent. */
const sent: Array<{ to: string; type: string; text?: { body: string }; interactive?: { type: string; body: { text: string }; action: Record<string, unknown> } }> = [];
vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return Response.json({ messages: [{ id: `wamid.out.${sent.length}` }] });
});

let seq = 0;
/** A customer's message; `ad`: sent from a Click-to-WhatsApp ad (Meta's referral, its pre-filled words). */
async function customer(waId: string, said: { text?: string; tap?: string; ad?: boolean }) {
  const message = {
    from: waId,
    id: `wamid.in.${++seq}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...(said.tap
      ? { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: said.tap, title: 'x' } } }
      : { type: 'text', text: { body: said.text ?? '' } }),
    ...(said.ad
      ? { referral: { source_url: 'https://fb.me/abc', source_type: 'ad', source_id: '120251397240540193', headline: 'WhatsApp par order, seedha kitchen', ctwa_clid: `clid-${seq}` } }
      : {}),
  };
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1881791873188347', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ profile: { name: 'Haider Ali' }, wa_id: waId }], messages: [message] } }] }],
  });
  const from = sent.length;
  const res = await webhook.POST(
    new Request('https://site.test/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` },
      body: raw,
    }),
  );
  expect(res.status).toBe(200);
  return sent.slice(from);
}

/** Staff write to the customer from the WhatsApp Business app on the shop's phone (Meta's echo), at `at`. */
async function staffWrites(waId: string, at: Date) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1881791873188347', changes: [{ field: 'smb_message_echoes', value: { metadata: { phone_number_id: PHONE_ID }, message_echoes: [{ from: '923009367865', to: waId, id: `wamid.staff.${++seq}`, timestamp: String(Math.floor(at.getTime() / 1000)), type: 'text', text: { body: 'Ji?' } }] } }] }],
  });
  const res = await webhook.POST(
    new Request('https://site.test/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` },
      body: raw,
    }),
  );
  expect(res.status).toBe(200);
}
const rowIds = (m: (typeof sent)[number] | undefined): string[] => {
  const a = m?.interactive?.action as { buttons?: Array<{ reply: { id: string } }>; sections?: Array<{ rows: Array<{ id: string }> }> } | undefined;
  return a?.buttons?.map((b) => b.reply.id) ?? a?.sections?.flatMap((s) => s.rows.map((r) => r.id)) ?? [];
};
const words = (m: (typeof sent)[number] | undefined) => m?.text?.body ?? m?.interactive?.body.text ?? '';

function item(id: string, name: string, rs: number, over: Partial<PublishedMenuItem> = {}): PublishedMenuItem {
  return { posItemId: id, name, description: null, basePriceCents: rs * 100, taxRateBps: 1500, imageUrl: null, sortOrder: 0, modifierGroups: [], ...over };
}
const MENU: PublishedMenu = {
  categories: [
    {
      posCategoryId: 'c-deals',
      name: 'Value Deals',
      displayOrder: 1,
      items: [
        item('lc', 'Large & Chilled', 1800, {
          taxIncluded: true,
          modifierGroups: [
            { posGroupId: 'g-pz', name: 'Deal: Large pizza', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true, sortOrder: 0, modifiers: [{ posModifierId: 'pz-tikka', name: 'Chicken Tikka', priceDeltaCents: 0, isDefault: false, sortOrder: 0 }, { posModifierId: 'pz-fajita', name: 'Fajita', priceDeltaCents: 0, isDefault: false, sortOrder: 1 }] },
            { posGroupId: 'g-dr', name: 'Deal: 1 litre drink', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true, sortOrder: 1, modifiers: [{ posModifierId: 'dr-cola', name: 'Cola', priceDeltaCents: 0, isDefault: false, sortOrder: 0 }] },
            { posGroupId: 'g-fx', name: 'Comes with · fries', selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true, sortOrder: 2, modifiers: [{ posModifierId: 'fx-fries', name: 'Fries', priceDeltaCents: 0, isDefault: true, sortOrder: 0 }] },
          ],
        }),
      ],
    },
    { posCategoryId: 'c-burgers', name: 'Burgers', displayOrder: 2, items: [item('burger', 'Classic Crispy Chicken', 700)] },
    { posCategoryId: 'c-del', name: 'Delivery Charges', displayOrder: 9, items: [item('del-200', 'Delivery Charge (Rs 200)', 200, { taxRateBps: 0 }), item('del-250', 'Delivery Charge (Rs 250)', 250, { taxRateBps: 0 })] },
  ],
  publishedAt: new Date().toISOString(),
  store: { name: "Cheese O'Clock", phone: null, whatsapp: null, addressLine: null, tagline: null },
};

function bridge(path: string, body?: unknown, method = 'POST') {
  return new Request(`https://site.test${path}`, {
    method,
    headers: { authorization: `Bearer ${BRIDGE}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  await db.pg.query(`INSERT INTO site_menu (id, menu_json, published_at) VALUES (1, $1, now())`, [JSON.stringify(MENU)]);
});

beforeEach(async () => {
  // The till is on and listening.
  expect((await bridgeStatus.PUT(bridge('/api/bridge/status', { acceptingOrders: true, deviceId: 'till-1', features: ['pickup'] }, 'PUT'))).status).toBe(200);
});

describe('WhatsApp ordering bot, end to end', () => {
  it('a tester orders in the chat; the order reaches the till as a WhatsApp order; the customer hears each step', async () => {
    // The welcome is the menu: the deal is one pick away.
    const hello = await customer(TESTER, { text: 'Salam' });
    expect(rowIds(hello[0])).toEqual(['i:lc', 'o:menu', 'o:web', 'o:staff']);
    expect(words(hello[0])).toContain('Assalam o Alaikum Haider!');

    expect(rowIds((await customer(TESTER, { tap: 'i:lc' }))[0])).toEqual(['m:pz-tikka', 'm:pz-fajita']);
    await customer(TESTER, { tap: 'm:pz-tikka' });
    expect(rowIds((await customer(TESTER, { tap: 'm:dr-cola' }))[0])).toEqual(['f:delivery', 'f:pickup', 'k:add']);
    expect(words((await customer(TESTER, { tap: 'f:delivery' }))[0])).toContain('Delivery address likh dein');

    // The area is read from the address; the website's own route prices it: the deal (tax included) and the area's Rs 200 charge.
    const confirm = await customer(TESTER, { text: 'House 12, Street 4, Rahat Lane, DHA Phase 6' });
    expect(words(confirm[0])).toContain('1× Large & Chilled — Rs 1,800');
    expect(words(confirm[0])).toContain('1× Delivery Charge (Rs 200) — Rs 200');
    expect(words(confirm[0])).toContain('*Total Rs 2,000* · cash on delivery');
    expect(await db.pg.query(`SELECT 1 FROM web_orders`, []).then((r) => r.rows)).toHaveLength(0);

    const placed = await customer(TESTER, { tap: 'y:confirm' });
    expect(words(placed[0])).toContain('Aapka order place ho gaya.');
    await customer(TESTER, { tap: 'y:confirm' }); // a second tap places nothing more
    const rows = (await db.pg.query(`SELECT id, customer_name, customer_phone, area, address_line, notes, total_cents FROM web_orders`, [])).rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_name: 'Haider Ali', customer_phone: '+923088440608', area: 'DHA Phase 6', address_line: 'House 12, Street 4, Rahat Lane, DHA Phase 6', notes: 'WhatsApp order', total_cents: 200_000 });
    const orderId = String(rows[0]!['id']);
    expect((await db.pg.query(`SELECT wa_id FROM wa_orders WHERE order_id = $1`, [orderId])).rows).toEqual([{ wa_id: TESTER }]);

    // The till pulls it like any website order, with its lines and choices.
    const pulled = (await (await bridgeOrders.GET(bridge('/api/bridge/orders?device=till-1', undefined, 'GET'))).json()) as {
      data: Array<{ id: string; items: Array<{ posItemId: string; modifiers: Array<{ posModifierId: string }> }> }>;
    };
    const o = pulled.data.find((x) => x.id === orderId)!;
    expect(o.items.map((l) => [l.posItemId, l.modifiers.map((m) => m.posModifierId)])).toEqual([
      ['lc', ['fx-fries', 'pz-tikka', 'dr-cola']],
      ['del-200', []],
    ]);

    // The till acks it, then sends it out: the customer hears both, once each.
    const before = sent.length;
    await ack.POST(bridge(`/api/bridge/orders/${orderId}/ack`, { posOrderId: 'pos-1', posOrderNumber: '42' }), { params: { id: orderId } });
    await status.POST(bridge(`/api/bridge/orders/${orderId}/status`, { status: 'accepted' }), { params: { id: orderId } });
    await status.POST(bridge(`/api/bridge/orders/${orderId}/status`, { status: 'out_for_delivery' }), { params: { id: orderId } });
    await status.POST(bridge(`/api/bridge/orders/${orderId}/status`, { status: 'out_for_delivery' }), { params: { id: orderId } });
    expect(sent.slice(before).map((m) => [m.to, words(m)])).toEqual([
      [TESTER, '✅ Aapka order #42 kitchen ko mil gaya — tayyar ho raha hai 🍕'],
      [TESTER, '🛵 Aapka order rider ke saath nikal gaya — thodi der mein pohanch jayega.'],
    ]);
  });

  it('what they type after the welcome is the bot’s; it takes the address it asked for even if staff wrote from the phone before; once staff write after it, the bot keeps out', async () => {
    await customer(TESTER_2, { text: 'Salam' });
    // Typed, not tapped: the item's name finds it.
    expect(rowIds((await customer(TESTER_2, { text: 'Large and chilled chahiye' }))[0])).toEqual(['m:pz-tikka', 'm:pz-fajita']);
    for (const tap of ['m:pz-tikka', 'm:dr-cola']) await customer(TESTER_2, { tap });
    expect(words((await customer(TESTER_2, { tap: 'f:delivery' }))[0])).toContain('address');
    // Something went out from the shop's phone (a reply, the app's greeting) before the bot asked for the address.
    await staffWrites(TESTER_2, new Date(Date.now() - 30_000));
    const areas = await customer(TESTER_2, { text: 'Flat B102, Gardens 1, near the park' });
    expect(areas).toHaveLength(1);
    expect(rowIds(areas[0])).toContain('z:none');

    // Now staff write after the bot's question: the chat is theirs, and the customer's words go to them only.
    await staffWrites(TESTER_2, new Date(Date.now() + 2_000));
    expect(await customer(TESTER_2, { text: 'Bhai jaldi bhej dena' })).toEqual([]);
  });

  it('an ad tapped again the same day gets the menu again, unless staff are in the chat', async () => {
    // TESTER ordered above: the day's welcome is used and the order is done. Meta's ad words get the menu all the same.
    const again = await customer(TESTER, { text: 'Hello! Can I get more info on this?', ad: true });
    expect(again).toHaveLength(1);
    expect(rowIds(again[0])).toContain('o:menu');
    expect(rowIds(again[0])).toContain('i:lc');
    // The same words typed without an ad, once the day's welcome is used and no order is open: left to staff.
    await customer(TESTER, { tap: 'o:staff' });
    expect(await customer(TESTER, { text: 'Kitni der lagegi?' })).toEqual([]);

    // Staff wrote to TESTER_3 in the last hour: their ad tap is staff's to answer.
    await customer(TESTER_3, { text: 'Salam' });
    await customer(TESTER_3, { tap: 'o:staff' });
    await staffWrites(TESTER_3, new Date(Date.now() - 60_000));
    expect(await customer(TESTER_3, { text: 'Hello! Can I get more info on this?', ad: true })).toEqual([]);
  });

  it('a customer who is not a tester still gets the day’s order link, not the bot', async () => {
    const r = await customer('923001234599', { text: 'Menu?' });
    expect(r).toHaveLength(1);
    expect(r[0]!.type).toBe('text');
    expect(words(r[0])).toMatch(/menu\?wa=[A-Za-z0-9]{12}/);
  });

  it('a website order that did not come from WhatsApp sends nothing when the till acks it', async () => {
    await db.pg.query(
      `INSERT INTO web_orders (id, status, customer_name, customer_phone, address_line, items_json, subtotal_cents, tax_cents, total_cents)
       VALUES ('0199bbbb-0000-7000-8000-000000000001', 'new', 'Web', '+923001112223', 'House 1', '[]', 0, 0, 0)`,
      [],
    );
    const before = sent.length;
    await ack.POST(bridge('/api/bridge/orders/0199bbbb-0000-7000-8000-000000000001/ack', { posOrderId: 'p', posOrderNumber: '7' }), { params: { id: '0199bbbb-0000-7000-8000-000000000001' } });
    expect(sent.length).toBe(before);
  });
});
