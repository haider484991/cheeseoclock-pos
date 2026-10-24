/**
 * POST /api/orders on a real Postgres (PGlite, in memory, with db/schema.sql):
 * delivery zones are enforced, the zone's fee reaches the till as its
 * "Delivery Charge (Rs N)" item, pick-up-only food is refused for delivery,
 * pickup (10% off) is offered only while the till announced it, and a value
 * deal the published menu marks takes no share of it (v0.7.34).
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BUY_1_GET_1_RULES,
  DEFAULT_DELIVERY_ZONES,
  webOrderDeliveryPercent,
  webOrderPickupPercent,
  type Buy1Get1Rules,
  type PublishedMenu,
  type PublishedMenuItem,
  type PublishedSettings,
  type WebOrderItem,
} from '@cheeseoclock/shared-types';
import { buildSettingsBlock } from '../../../../packages/pos-domain/src/delivery-charge';
import { normalizePhone } from './format';
import type { CapiEvent } from './meta-capi';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  /** The values of the last INSERT INTO web_orders, as the route sent them (items_json as its JSON text). */
  orderInsert: [] as unknown[],
}));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, '');
    if (text.includes('INSERT INTO web_orders')) db.orderInsert = values;
    return db.pg.query(text, values).then((r) => r.rows);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const orders = await import('@/app/api/orders/route');
const bridgeStatus = await import('@/app/api/bridge/status/route');
const bridgeOrders = await import('@/app/api/bridge/orders/route');
const bridgeOrderStatus = await import('@/app/api/bridge/orders/[id]/status/route');
const storeStatus = await import('@/app/api/store-status/route');
const bridgeMenu = await import('@/app/api/bridge/menu/route');
const bridgeSettings = await import('@/app/api/bridge/settings/route');
const apiMenu = await import('@/app/api/menu/route');

const SECRET = 'test-bridge-secret-0123456789';
function bridge(path: string, init?: { method?: string; body?: unknown }) {
  return new Request(`https://site.test${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
/** The till's heartbeat, with or without the pickup capability. */
async function heartbeat(features?: string[], pickupDiscountPercent?: number) {
  const res = await bridgeStatus.PUT(
    bridge('/api/bridge/status', {
      method: 'PUT',
      body: { acceptingOrders: true, deviceId: 'till-1', features, pickupDiscountPercent },
    }),
  );
  expect(res.status).toBe(200);
}

function item(id: string, name: string, priceRs: number, over: Partial<PublishedMenuItem> = {}): PublishedMenuItem {
  return {
    posItemId: id,
    name,
    description: null,
    basePriceCents: priceRs * 100,
    taxRateBps: 1500,
    imageUrl: null,
    sortOrder: 0,
    modifierGroups: [],
    ...over,
  };
}

function menu(withCharges: boolean): PublishedMenu {
  return {
    categories: [
      {
        posCategoryId: 'c-pizza',
        name: 'Pizza',
        displayOrder: 1,
        items: [item('fajita-l', 'Fajita Pizza — Large', 2000)],
      },
      {
        posCategoryId: 'c-sides',
        name: 'Fries & Sides',
        displayOrder: 3,
        items: [item('loaded', 'Signature Loaded Fries', 700, { description: 'Pick up only.' })],
      },
      ...(withCharges
        ? [
            {
              posCategoryId: 'c-del',
              name: 'Delivery Charges',
              displayOrder: 6,
              items: [
                item('del-200', 'Delivery Charge (Rs 200)', 200),
                item('del-250', 'Delivery Charge (Rs 250)', 250),
              ],
            },
          ]
        : []),
    ],
    publishedAt: new Date().toISOString(),
    store: { name: "Cheese O'Clock", phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}

async function publish(m: PublishedMenu) {
  await db.pg.query(
    `INSERT INTO site_menu (id, menu_json, published_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET menu_json = EXCLUDED.menu_json`,
    [JSON.stringify(m)],
  );
}

/**
 * A website order delivered to this number two days ago: the shop knows it (lib/call-first), so its next order carries
 * no "CALL TO CONFIRM BEFORE COOKING" warning. Outside the flood limiter's 15 minutes, and never pulled by a till.
 */
async function trustNumber(typed: string) {
  await db.pg.query(
    `INSERT INTO web_orders (id, status, customer_name, customer_phone, address_line, items_json,
                             subtotal_cents, tax_cents, total_cents, created_at)
     VALUES ($1, 'delivered', 'Regular', $2, 'House 1, Street 1', '[]', 0, 0, 0, now() - interval '2 days')`,
    [crypto.randomUUID(), normalizePhone(typed)],
  );
}

let ip = 0;
/** Places an order from a fresh number, one the shop has delivered to before unless `newCustomer`. */
async function place(body: Record<string, unknown>, opts: { newCustomer?: boolean } = {}) {
  ++ip;
  const phone = typeof body['customerPhone'] === 'string' ? body['customerPhone'] : `0300 12345${String(ip).padStart(2, '0')}`;
  if (!opts.newCustomer) await trustNumber(phone);
  const req = new Request('https://site.test/api/orders', {
    method: 'POST',
    // A fresh phone and client address per call keep the flood limiter out of the way.
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${ip}` },
    body: JSON.stringify({
      customerName: 'Test Customer',
      customerPhone: phone,
      addressLine: 'House 12, Street 4',
      items: [{ posItemId: 'fajita-l', quantity: 1, modifierIds: [] }],
      ...body,
    }),
  });
  const res = await orders.POST(req);
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; message?: string; data?: { orderId: string; fulfilment: string; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number } } };
}

async function stored(id: string) {
  const rows = (await db.pg.query(`SELECT area, address_line, notes, fulfilment, items_json, subtotal_cents, discount_cents, tax_cents, total_cents FROM web_orders WHERE id = $1`, [id])).rows as Array<{
    area: string;
    address_line: string;
    notes: string | null;
    fulfilment: string;
    discount_cents: number;
    items_json: WebOrderItem[] | string;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
  }>;
  const row = rows[0]!;
  const items = typeof row.items_json === 'string' ? (JSON.parse(row.items_json) as WebOrderItem[]) : row.items_json;
  return { ...row, items };
}

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  // The till is on and listening.
  await heartbeat();
  await publish(menu(true));
});

describe('POST /api/orders — delivery zones', () => {
  it('adds the zone’s delivery charge as the till’s own item', async () => {
    const r = await place({ zoneId: 'dha-6' });
    expect(r.status).toBe(200);
    const row = await stored(r.json.data!.orderId);
    expect(row.area).toBe('DHA Phase 6');
    expect(row.items.map((i) => [i.posItemId, i.unitPriceCents])).toEqual([
      ['fajita-l', 200_000],
      ['del-200', 20_000],
    ]);
    expect(row.subtotal_cents).toBe(220_000);
    expect(row.tax_cents).toBe(33_000); // 15% of pizza + fee, as the till taxes both
    expect(row.total_cents).toBe(253_000);
    expect(row.notes).toBeNull();
  });

  it('charges Rs 250 in Clifton Block 1', async () => {
    const r = await place({ zoneId: 'clifton-1' });
    const row = await stored(r.json.data!.orderId);
    expect(row.items.at(-1)?.posItemId).toBe('del-250');
    expect(row.area).toBe('Clifton Block 1');
  });

  it('refuses anywhere outside DHA and Clifton, and no zone at all', async () => {
    expect((await place({ zoneId: 'saddar' })).json.error).toBe('outside_zone');
    const none = await place({});
    expect(none.status).toBe(400);
    expect(none.json.error).toBe('validation');
  });

  it('answers a broken request with a 400, and field errors in words a customer can act on', async () => {
    const garbled = await orders.POST(
      new Request('https://site.test/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(garbled.status).toBe(400);
    const short = await place({ zoneId: 'dha-6', customerName: 'A' });
    expect(short.status).toBe(400);
    expect((short.json as { details?: Record<string, string[]> }).details?.['customerName']).toEqual([
      'Please enter your name.',
    ]);
    const tooMany = await place({ zoneId: 'dha-6', items: [{ posItemId: 'fajita-l', quantity: 51, modifierIds: [] }] });
    expect((tooMany.json as { details?: Record<string, string[]> }).details?.['items']?.[0]).toMatch(/Up to 50/);
  });

  it('still takes the order when the till has no charge items yet, and tells the cashier', async () => {
    await publish(menu(false));
    const r = await place({ zoneId: 'emaar', notes: 'Ring twice' });
    expect(r.status).toBe(200);
    const row = await stored(r.json.data!.orderId);
    expect(row.items.map((i) => i.posItemId)).toEqual(['fajita-l']);
    expect(row.subtotal_cents).toBe(225_000);
    expect(row.notes).toBe('Delivery Emaar Crescent Bay (DHA) Rs 250 — add the delivery charge by hand. Ring twice');
  });

  it('refuses pick-up-only food and a client-chosen delivery charge', async () => {
    const pickup = await place({
      zoneId: 'dha-6',
      items: [{ posItemId: 'loaded', quantity: 1, modifierIds: [] }],
    });
    expect(pickup.status).toBe(409);
    expect(pickup.json.error).toBe('not_deliverable');
    const sneaky = await place({
      zoneId: 'clifton-1',
      items: [
        { posItemId: 'fajita-l', quantity: 1, modifierIds: [] },
        { posItemId: 'del-200', quantity: 1, modifierIds: [] },
      ],
    });
    expect(sneaky.status).toBe(409);
  });

  it('keeps the till’s notes under its 500-character cap', async () => {
    await publish(menu(false));
    const r = await place({ zoneId: 'dha-1', notes: 'x'.repeat(500) });
    const row = await stored(r.json.data!.orderId);
    expect(row.notes!.length).toBeLessThanOrEqual(490);
  });
});

describe('POST /api/orders — leave-outs, extras and allergy notes', () => {
  const withChoices = (): PublishedMenu => {
    const m = menu(true);
    m.categories[0]!.items = [
      item('fajita-l', 'Fajita Pizza — Large', 2000, {
        modifierGroups: [
          {
            posGroupId: 'g-leave', name: 'Leave out · Fajita Pizza', selectionType: 'multi',
            minSelect: 0, maxSelect: 2, isRequired: false, sortOrder: 0,
            modifiers: [
              { posModifierId: 'no-onion', name: 'No onion', priceDeltaCents: 0, isDefault: false, sortOrder: 0 },
              { posModifierId: 'no-pepper', name: 'No bell pepper', priceDeltaCents: 0, isDefault: false, sortOrder: 1 },
            ],
          },
          {
            posGroupId: 'g-extra', name: 'Extra toppings', selectionType: 'multi',
            minSelect: 0, maxSelect: 8, isRequired: false, sortOrder: 1,
            modifiers: [
              { posModifierId: 'x-cheese', name: 'Extra cheese', priceDeltaCents: 15_000, isDefault: false, sortOrder: 0 },
            ],
          },
        ],
      }),
    ];
    return m;
  };

  it('prices the extra, keeps the leave-out and the note on the line for the kitchen', async () => {
    await publish(withChoices());
    const r = await place({
      zoneId: 'dha-6',
      items: [{ posItemId: 'fajita-l', quantity: 2, modifierIds: ['no-onion', 'x-cheese'], notes: '  Peanut allergy  ' }],
    });
    expect(r.status).toBe(200);
    const row = await stored(r.json.data!.orderId);
    const pizza = row.items.find((i) => i.posItemId === 'fajita-l')!;
    expect(pizza.unitPriceCents).toBe(215_000);
    expect(pizza.modifiers.map((m) => m.name)).toEqual(['No onion', 'Extra cheese']);
    expect(pizza.notes).toBe('Peanut allergy');
    expect(row.subtotal_cents).toBe(2 * 215_000 + 20_000);
  });

  it('names the group as customers see it when too many are picked', async () => {
    const m = withChoices();
    m.categories[0]!.items[0]!.modifierGroups[0]!.maxSelect = 1;
    await publish(m);
    const r = await place({ zoneId: 'dha-6', items: [{ posItemId: 'fajita-l', quantity: 1, modifierIds: ['no-onion', 'no-pepper'] }] });
    expect(r.status).toBe(409);
    expect(r.json.message).toBe('"Leave out" allows at most 1 choices.');
  });
});

describe('POST /api/orders — pickup at the till’s discount', () => {
  it('is not offered until the till announces it can import pickups', async () => {
    const off = await place({ fulfilment: 'pickup', addressLine: undefined });
    expect(off.status).toBe(409);
    expect(off.json.error).toBe('pickup_unavailable');
    const before = (await (await storeStatus.GET()).json()) as { data: { pickupAvailable: boolean } };
    expect(before.data.pickupAvailable).toBe(false);

    await heartbeat(['pickup']);
    const after = (await (await storeStatus.GET()).json()) as { data: { pickupAvailable: boolean } };
    expect(after.data.pickupAvailable).toBe(true);
  });

  it('a v0.7.0 till (no percent announced) gets 10% off; no zone, address or delivery charge', async () => {
    await heartbeat(['pickup']);
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, notes: 'Collecting at 9' });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({
      fulfilment: 'pickup',
      subtotalCents: 200_000,
      discountCents: 20_000,
      taxCents: 27_000, // 15% of the discounted 1,800 — the till's own maths
      totalCents: 207_000,
    });
    const row = await stored(r.json.data!.orderId);
    expect(row.fulfilment).toBe('pickup');
    expect(row.discount_cents).toBe(20_000);
    expect(row.items.map((i) => i.posItemId)).toEqual(['fajita-l']);
    expect(row.area).toBe('Pick-up');
    expect(row.address_line).toMatch(/collects from the shop/);
    expect(row.notes).toBe('Collecting at 9');
  });

  it('sells pick-up-only food on a pickup', async () => {
    await heartbeat(['pickup']);
    const r = await place({
      fulfilment: 'pickup',
      items: [{ posItemId: 'loaded', quantity: 1, modifierIds: [] }],
    });
    expect(r.status).toBe(200);
    expect(r.json.data!.discountCents).toBe(7_000);
  });

  it('closes pickup again when a till without it takes over', async () => {
    await heartbeat(['pickup']);
    await heartbeat();
    expect((await place({ fulfilment: 'pickup' })).json.error).toBe('pickup_unavailable');
  });

  it('hands the till fulfilment and discount; deliveries stay deliveries', async () => {
    await heartbeat(['pickup']);
    const p = await place({ fulfilment: 'pickup' });
    const d = await place({ zoneId: 'dha-6' });
    const res = await bridgeOrders.GET(bridge('/api/bridge/orders'));
    const json = (await res.json()) as { data: Array<{ id: string; fulfilment: string; discountCents: number; addressLine: string }> };
    const byId = new Map(json.data.map((o) => [o.id, o]));
    expect(byId.get(p.json.data!.orderId)).toMatchObject({ fulfilment: 'pickup', discountCents: 20_000 });
    expect(byId.get(d.json.data!.orderId)).toMatchObject({ fulfilment: 'delivery', discountCents: 0, addressLine: 'House 12, Street 4' });
  });

  // v0.7.1 tills announce 15% (v0.7.2 went back to 10): the site bills whatever the till says.
  it('uses the percent the till announces — 15% from a v0.7.1 till', async () => {
    await heartbeat(['pickup'], 15);
    const st = (await (await storeStatus.GET()).json()) as { data: { pickupDiscountPercent: number } };
    expect(st.data.pickupDiscountPercent).toBe(15);
    const r = await place({ fulfilment: 'pickup' });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({
      subtotalCents: 200_000,
      discountCents: 30_000,
      taxCents: 25_500, // 15% tax on the discounted 1,700
      totalCents: 195_500,
    });
  });
});

describe('two tills and the order journey', () => {
  const pull = async (device: string) => {
    const res = await bridgeOrders.GET(bridge(`/api/bridge/orders?device=${device}`));
    const json = (await res.json()) as { data: Array<{ id: string }> };
    return json.data.map((o) => o.id);
  };

  it('hands a new order to one till only, and to that till again on its next poll', async () => {
    const p = await place({ zoneId: 'dha-6' });
    const id = p.json.data!.orderId;
    expect(await pull('till-A')).toContain(id);
    expect(await pull('till-B')).not.toContain(id);
    expect(await pull('till-A')).toContain(id);
  });

  it('gives the order to the other till once the first one has gone quiet', async () => {
    const p = await place({ zoneId: 'dha-6' });
    const id = p.json.data!.orderId;
    expect(await pull('till-A')).toContain(id);
    await db.pg.query(`UPDATE web_orders SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    expect(await pull('till-B')).toContain(id);
    expect(await pull('till-A')).not.toContain(id);
  });

  it('keeps a delivered order delivered', async () => {
    const p = await place({ zoneId: 'dha-6' });
    const id = p.json.data!.orderId;
    const push = async (status: string) => {
      const res = await bridgeOrderStatus.POST(
        bridge(`/api/bridge/orders/${id}/status`, { method: 'POST', body: { status } }),
        { params: { id } },
      );
      return (await res.json()) as { ok: boolean; data?: { updated: boolean; finalStatus?: string } };
    };
    expect((await push('out_for_delivery')).data).toEqual({ updated: true });
    expect((await push('delivered')).data).toEqual({ updated: true });
    expect((await push('cancelled')).data).toEqual({ updated: false, finalStatus: 'delivered' });
    expect((await push('delivered')).data).toEqual({ updated: true });
    const rows = (await db.pg.query(`SELECT status FROM web_orders WHERE id = $1`, [id])).rows as Array<{ status: string }>;
    expect(rows[0]!.status).toBe('delivered');
  });
});

describe('POST /api/orders — value deals take no pick-up discount (v0.7.34, NO DISCOUNT ON VALUE DEALS)', () => {
  /** menu(true) with a made-up Value Deals section; Big Two marked as a v0.7.34 till publishes it, or not. */
  function dealsMenu(marked: boolean): PublishedMenu {
    const m = menu(true);
    m.categories.splice(2, 0, {
      posCategoryId: 'c-deals',
      name: 'Value Deals',
      displayOrder: 5,
      items: [item('big-two', 'Big Two', 3600, marked ? { noDiscount: true } : {})],
    });
    return m;
  }
  /** The till's block for a menu, by its own code (pos-domain buildSettingsBlock): today's areas, pick-up 10%. */
  function tillBlock(m: PublishedMenu): PublishedSettings {
    return buildSettingsBlock({
      zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] })),
      pickup: { offered: true, percent: 10 },
      stamps: [{ version: 1, updatedAt: '2026-09-27T10:00:00.000Z' }],
      menuItems: m.categories.flatMap((c) =>
        c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents })),
      ),
      deviceId: 'till-1',
    });
  }
  /** A till's Publish, through the bridge (so the mark must get past its schema). */
  async function publishFromTill(m: PublishedMenu) {
    const res = await bridgeMenu.PUT(bridge('/api/bridge/menu', { method: 'PUT', body: m }));
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  }
  async function storedMenu(): Promise<PublishedMenu> {
    const rows = (await db.pg.query('SELECT menu_json FROM site_menu WHERE id = 1', [])).rows as Array<{
      menu_json: PublishedMenu | string;
    }>;
    const v = rows[0]!.menu_json;
    return typeof v === 'string' ? (JSON.parse(v) as PublishedMenu) : v;
  }
  const line = (posItemId: string) => ({ posItemId, quantity: 1, modifierIds: [] });
  /** A stored line as today's route writes it: no noDiscount key. */
  const todayLine = (posItemId: string, name: string, unitPriceCents: number) => ({
    posItemId,
    name,
    quantity: 1,
    unitPriceCents,
    modifiers: [],
    notes: null,
  });
  /** The items_json text the route sent with its last order. */
  const itemsSent = () => db.orderInsert.find((v) => typeof v === 'string' && v.startsWith('[{"posItemId"'));

  it('the bridge keeps the mark, GET /api/menu shows it, and both PUT answers say this website does', async () => {
    const m = dealsMenu(true);
    expect(await publishFromTill(m)).toMatchObject({ websiteMessages: true, noDiscountItems: true });
    expect(await storedMenu()).toEqual(m);
    const pub = (await (await apiMenu.GET()).json()) as { data: PublishedMenu };
    const items = pub.data.categories.flatMap((c) => c.items);
    expect(items.filter((i) => 'noDiscount' in i).map((i) => [i.posItemId, i.noDiscount])).toEqual([['big-two', true]]);
    // A Save on the till (the block alone): the same answer, and the stored mark stays.
    const save = await bridgeSettings.PUT(
      bridge('/api/bridge/settings', { method: 'PUT', body: { settings: tillBlock(m), feeItems: [] } }),
    );
    expect(save.status).toBe(200);
    expect(((await save.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      settings: 'stored',
      websiteMessages: true,
      noDiscountItems: true,
    });
    const { settings: _block, ...menuAfterSave } = await storedMenu();
    expect(menuAfterSave).toEqual(m);
  });

  it('a menu with nothing marked (any till up to v0.7.33) is stored exactly as sent, no key added', async () => {
    const m = dealsMenu(false);
    await publishFromTill(m);
    const stored = await storedMenu();
    expect(stored).toEqual(m);
    expect(JSON.stringify(stored)).not.toContain('noDiscount');
  });

  it('a pick-up of Big Two + a pizza: 10% off the pizza only, Big Two’s line says so, the till reads 10%', async () => {
    await heartbeat(['pickup']);
    await publishFromTill(dealsMenu(true));
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, items: [line('big-two'), line('fajita-l')] });
    expect(r.status).toBe(200);
    // Rs 200 off the Rs 2,000 pizza (never Rs 560 off Rs 5,600); Big Two taxed on its full Rs 3,600.
    expect(r.json.data).toMatchObject({
      subtotalCents: 560_000,
      discountCents: 20_000,
      taxCents: 54_000 + 27_000,
      totalCents: 621_000,
    });
    // The flag is the marked line's LAST key; the pizza's line is today's.
    expect(itemsSent()).toBe(
      JSON.stringify([
        { ...todayLine('big-two', 'Big Two', 360_000), noDiscount: true },
        todayLine('fajita-l', 'Fajita Pizza — Large', 200_000),
      ]),
    );
    const row = await stored(r.json.data!.orderId);
    expect(row.items.map((i) => i.posItemId)).toEqual(['big-two', 'fajita-l']);
    expect(row.items[0]!.noDiscount).toBe(true);
    expect(row.items[1]).not.toHaveProperty('noDiscount');
    // The till gets the flag, and reads the % back on the lines it was worked on (never 4%).
    const res = await bridgeOrders.GET(bridge('/api/bridge/orders'));
    const json = (await res.json()) as {
      data: Array<{ id: string; fulfilment: string; subtotalCents: number; discountCents: number; items: WebOrderItem[] }>;
    };
    const toTill = json.data.find((o) => o.id === r.json.data!.orderId)!;
    expect(toTill.items.map((i) => i.noDiscount === true)).toEqual([true, false]);
    expect(webOrderPickupPercent(toTill)).toBe(10);
  });

  it('a pick-up of deals only takes nothing off, and reads 0%', async () => {
    await heartbeat(['pickup']);
    await publishFromTill(dealsMenu(true));
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, items: [line('big-two')] });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ subtotalCents: 360_000, discountCents: 0, taxCents: 54_000, totalCents: 414_000 });
    const row = await stored(r.json.data!.orderId);
    expect(
      webOrderPickupPercent({
        fulfilment: row.fulfilment,
        subtotalCents: row.subtotal_cents,
        discountCents: row.discount_cents,
        items: row.items,
      }),
    ).toBe(0);
  });

  it('a delivery: the flag rides on Big Two’s line too, never on the delivery charge, and nothing comes off', async () => {
    await publishFromTill(dealsMenu(true));
    const r = await place({ zoneId: 'dha-6', items: [line('big-two'), line('fajita-l')] });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ subtotalCents: 580_000, discountCents: 0, taxCents: 87_000, totalCents: 667_000 });
    expect(itemsSent()).toBe(
      JSON.stringify([
        { ...todayLine('big-two', 'Big Two', 360_000), noDiscount: true },
        todayLine('fajita-l', 'Fajita Pizza — Large', 200_000),
        todayLine('del-200', 'Delivery Charge (Rs 200)', 20_000),
      ]),
    );
    const row = await stored(r.json.data!.orderId);
    expect(row.items.map((i) => [i.posItemId, i.noDiscount === true])).toEqual([
      ['big-two', true],
      ['fajita-l', false],
      ['del-200', false],
    ]);
  });

  it('nothing marked: items_json is today’s, string for string, and so are the totals; the browser cannot set the flag', async () => {
    await heartbeat(['pickup']);
    await publishFromTill(dealsMenu(false));
    // The browser sends a flag of its own: the order schema drops it.
    const r = await place({
      fulfilment: 'pickup',
      addressLine: undefined,
      items: [{ ...line('big-two'), noDiscount: true }, line('fajita-l')],
    });
    expect(r.status).toBe(200);
    // 10% of every line, as before: Rs 560 off Rs 5,600, 15% tax on the Rs 5,040 left.
    expect(r.json.data).toMatchObject({ subtotalCents: 560_000, discountCents: 56_000, taxCents: 75_600, totalCents: 579_600 });
    expect(itemsSent()).toBe(
      JSON.stringify([todayLine('big-two', 'Big Two', 360_000), todayLine('fajita-l', 'Fajita Pizza — Large', 200_000)]),
    );
    const d = await place({ zoneId: 'clifton-1', items: [line('big-two')] });
    expect(d.status).toBe(200);
    expect(itemsSent()).toBe(
      JSON.stringify([todayLine('big-two', 'Big Two', 360_000), todayLine('del-250', 'Delivery Charge (Rs 250)', 25_000)]),
    );
    expect(JSON.stringify((await stored(d.json.data!.orderId)).items)).not.toContain('noDiscount');
  });
});

describe('POST /api/orders — the website % off a delivery’s food (v0.7.37, WEBSITE DELIVERY DISCOUNT)', () => {
  /** menu(true) with a made-up Value Deals section, Big Two marked as a v0.7.34+ till publishes it. */
  function dealsMenu(): PublishedMenu {
    const m = menu(true);
    m.categories.splice(2, 0, {
      posCategoryId: 'c-deals',
      name: 'Value Deals',
      displayOrder: 5,
      items: [item('big-two', 'Big Two', 3600, { noDiscount: true })],
    });
    return m;
  }
  /** The till's block by its own code: today's areas, 10%, "also on delivery orders" as given; `version` orders the Saves. */
  function tillBlock(m: PublishedMenu, alsoDelivery: boolean, version = 1): PublishedSettings {
    return buildSettingsBlock({
      zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] })),
      pickup: { offered: true, percent: 10, alsoDelivery },
      stamps: [{ version, updatedAt: `2026-10-04T10:0${version}:00.000Z` }],
      menuItems: m.categories.flatMap((c) =>
        c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents })),
      ),
      deviceId: 'till-1',
    });
  }
  /** A till's Publish, then a Save of the website offer (the block alone), through the bridge. */
  async function setUp(alsoDelivery: boolean, version = 1) {
    const m = dealsMenu();
    const pub = await bridgeMenu.PUT(bridge('/api/bridge/menu', { method: 'PUT', body: m }));
    expect(pub.status).toBe(200);
    const save = await bridgeSettings.PUT(
      bridge('/api/bridge/settings', { method: 'PUT', body: { settings: tillBlock(m, alsoDelivery, version), feeItems: [] } }),
    );
    expect(save.status).toBe(200);
    return ((await save.json()) as { data: Record<string, unknown> }).data;
  }
  async function shownPct(): Promise<unknown> {
    const json = (await (await storeStatus.GET()).json()) as { data: { deliveryDiscountPercent?: unknown } };
    return json.data.deliveryDiscountPercent;
  }
  const line = (posItemId: string) => ({ posItemId, quantity: 1, modifierIds: [] });
  const todayLine = (posItemId: string, name: string, unitPriceCents: number) => ({
    posItemId,
    name,
    quantity: 1,
    unitPriceCents,
    modifiers: [],
    notes: null,
  });
  const itemsSent = () => db.orderInsert.find((v) => typeof v === 'string' && v.startsWith('[{"posItemId"'));

  it('off until the owner ticks it AND the listening till bills it: a delivery pays full price, as today', async () => {
    // The box unticked: no key in the block, nothing off — even from a till that could bill it.
    await heartbeat(['pickup', 'delivery_discount']);
    expect(await setUp(false)).toMatchObject({ settings: 'stored', deliveryDiscount: true });
    expect(await shownPct()).toBe(0);
    let r = await place({ zoneId: 'dha-6', items: [line('fajita-l')] });
    expect(r.json.data).toMatchObject({ subtotalCents: 220_000, discountCents: 0, taxCents: 33_000, totalCents: 253_000 });
    // Ticked, but the listening till is older (no 'delivery_discount'): it would bill full price, so nothing off.
    await heartbeat(['pickup']);
    await setUp(true, 2);
    expect(await shownPct()).toBe(0);
    r = await place({ zoneId: 'dha-6', items: [line('fajita-l')] });
    expect(r.json.data).toMatchObject({ discountCents: 0, totalCents: 253_000 });
    // The shop closed: nothing shown either.
    await bridgeStatus.PUT(
      bridge('/api/bridge/status', { method: 'PUT', body: { acceptingOrders: false, deviceId: 'till-1', features: ['pickup', 'delivery_discount'] } }),
    );
    expect(await shownPct()).toBe(0);
  });

  it('on: Big Two + a pizza to DHA Phase 6 — 10% off the pizza only, never Big Two or the Rs 200 charge; the till reads 10%', async () => {
    await heartbeat(['pickup', 'delivery_discount']);
    await setUp(true);
    expect(await shownPct()).toBe(10);
    const r = await place({ zoneId: 'dha-6', items: [line('big-two'), line('fajita-l')] });
    expect(r.status).toBe(200);
    // Rs 200 off the Rs 2,000 pizza; Big Two (Rs 3,600) and the charge (Rs 200) taxed in full; the pizza on Rs 1,800.
    expect(r.json.data).toMatchObject({
      fulfilment: 'delivery',
      subtotalCents: 580_000,
      discountCents: 20_000,
      taxCents: 54_000 + 27_000 + 3_000,
      totalCents: 644_000,
    });
    // The stored lines are today's: the flag only on Big Two, never on the charge (the till knows it by name).
    expect(itemsSent()).toBe(
      JSON.stringify([
        { ...todayLine('big-two', 'Big Two', 360_000), noDiscount: true },
        todayLine('fajita-l', 'Fajita Pizza — Large', 200_000),
        todayLine('del-200', 'Delivery Charge (Rs 200)', 20_000),
      ]),
    );
    const res = await bridgeOrders.GET(bridge('/api/bridge/orders'));
    const json = (await res.json()) as {
      data: Array<{ id: string; fulfilment: string; discountCents: number; items: WebOrderItem[] }>;
    };
    const toTill = json.data.find((o) => o.id === r.json.data!.orderId)!;
    expect(toTill.discountCents).toBe(20_000);
    expect(webOrderDeliveryPercent(toTill)).toBe(10);
    // The pick-up reader still says 0 for a delivery (an older till never discounts it).
    expect(webOrderPickupPercent({ ...toTill, subtotalCents: 580_000 })).toBe(0);
  });

  it('a delivery of value deals only takes nothing off; the minimum is still the food before any discount', async () => {
    await heartbeat(['pickup', 'delivery_discount']);
    await setUp(true);
    const r = await place({ zoneId: 'clifton-1', items: [line('big-two')] });
    expect(r.json.data).toMatchObject({ subtotalCents: 385_000, discountCents: 0 });
  });

  it('a pick-up is unchanged: its own 10%, no charge', async () => {
    await heartbeat(['pickup', 'delivery_discount']);
    await setUp(true);
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, items: [line('big-two'), line('fajita-l')] });
    expect(r.json.data).toMatchObject({ subtotalCents: 560_000, discountCents: 20_000, totalCents: 621_000 });
  });

  it('a v0.7.36 till beating in turns it off again (the heartbeat row is the last till’s)', async () => {
    await heartbeat(['pickup', 'delivery_discount']);
    await setUp(true);
    expect(await shownPct()).toBe(10);
    await heartbeat(['pickup']);
    expect(await shownPct()).toBe(0);
    const r = await place({ zoneId: 'dha-6', items: [line('fajita-l')] });
    expect(r.json.data).toMatchObject({ discountCents: 0 });
  });
});

// Last in the file on purpose: the bridge's order pull returns 25 rows, so orders placed here must not come
// before the tests above that look their own order up in it.
describe('POST /api/orders — location pin and social handle (5 Oct 2026)', () => {
  const PIN = { lat: 24.80835364, lng: 67.06845187, accuracyM: 24.6 };
  const PIN_LINE = 'Map pin: https://maps.google.com/?q=24.808354,67.068452 (about 25 m)';

  it('a delivery with a pin and a handle: both lead the notes, the customer’s words follow; the totals are untouched', async () => {
    const plain = await place({ zoneId: 'dha-6' });
    const r = await place({ zoneId: 'dha-6', locationPin: PIN, social: '  @ahmed_k ', notes: 'Ring twice' });
    expect(r.status).toBe(200);
    const row = await stored(r.json.data!.orderId);
    expect(row.notes).toBe(`${PIN_LINE}. Social: @ahmed_k. Ring twice`);
    expect(row.total_cents).toBe((await stored(plain.json.data!.orderId)).total_cents);
  });

  it('a pin alone, a handle alone, and neither (notes stay null, as before)', async () => {
    const pinOnly = await place({ zoneId: 'dha-6', locationPin: PIN });
    expect((await stored(pinOnly.json.data!.orderId)).notes).toBe(PIN_LINE);
    const socialOnly = await place({ zoneId: 'dha-6', social: '@ahmed_k' });
    expect((await stored(socialOnly.json.data!.orderId)).notes).toBe('Social: @ahmed_k');
    const neither = await place({ zoneId: 'dha-6' });
    expect((await stored(neither.json.data!.orderId)).notes).toBeNull();
  });

  it('with the till lacking charge items, the cashier’s reminder stays with the customer’s words, after the pin', async () => {
    await publish(menu(false));
    const r = await place({ zoneId: 'emaar', locationPin: PIN, notes: 'Ring twice' });
    const row = await stored(r.json.data!.orderId);
    expect(row.notes).toBe(`${PIN_LINE}. Delivery Emaar Crescent Bay (DHA) Rs 250 — add the delivery charge by hand. Ring twice`);
  });

  it('never a reason to refuse: a pin or a handle that does not read is dropped and the order goes through', async () => {
    for (const bad of [
      { locationPin: 'here', social: 42 },
      { locationPin: { lat: 'x', lng: 67 }, social: { a: 1 } },
      { locationPin: { lat: 95, lng: 67 }, social: '@' },
      { locationPin: { lat: 0, lng: 0 }, social: '   ' },
      { locationPin: null, social: null },
    ]) {
      const r = await place({ zoneId: 'dha-6', ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(200);
      expect((await stored(r.json.data!.orderId)).notes, JSON.stringify(bad)).toBeNull();
    }
  });

  it('a handle is cleaned: control characters and angle brackets out, at most 80 characters', async () => {
    const r = await place({ zoneId: 'dha-6', social: '@a\nhmed <b>' + 'z'.repeat(200) });
    const notes = (await stored(r.json.data!.orderId)).notes!;
    expect(notes.startsWith('Social: @a hmed b zzz')).toBe(true);
    expect(notes).not.toMatch(/[<>\n]/);
    expect(notes.length).toBeLessThanOrEqual('Social: '.length + 80);
  });

  it('a long note gives way, the pin and the handle never do; the whole stays under the till’s cap', async () => {
    await publish(menu(false));
    const r = await place({ zoneId: 'dha-1', locationPin: PIN, social: '@ahmed_k', notes: 'x'.repeat(500) });
    const notes = (await stored(r.json.data!.orderId)).notes!;
    expect(notes.length).toBeLessThanOrEqual(490);
    expect(notes.startsWith(`${PIN_LINE}. Social: @ahmed_k. `)).toBe(true);
  });

  it('a pick-up has no address to pin: the pin is dropped, the handle is kept', async () => {
    await heartbeat(['pickup']);
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, locationPin: PIN, social: '@ahmed_k', notes: 'Collecting at 9' });
    expect(r.status).toBe(200);
    const row = await stored(r.json.data!.orderId);
    expect(row.notes).toBe('Social: @ahmed_k. Collecting at 9');
    expect(row.notes).not.toMatch(/maps\.google/);
  });
});

describe('POST /api/orders — "CALL TO CONFIRM BEFORE COOKING" (user, 24 Oct 2026, lib/call-first)', () => {
  const NEW = 'CALL TO CONFIRM BEFORE COOKING: new number';
  const PIN = { lat: 24.80835364, lng: 67.06845187, accuracyM: 24.6 };
  const PIN_LINE = 'Map pin: https://maps.google.com/?q=24.808354,67.068452 (about 25 m)';

  beforeEach(async () => {
    // The flood limiter's site-wide count is every order the tests above placed in the last 15 minutes. None of
    // them matters here.
    await db.pg.query('DELETE FROM web_orders', []);
  });

  async function setStatus(id: string, status: string) {
    const res = await bridgeOrderStatus.POST(
      bridge(`/api/bridge/orders/${id}/status`, { method: 'POST', body: { status } }),
      { params: { id } },
    );
    expect(res.status).toBe(200);
  }

  it('order #4 as it came in: a new number and "ABC Road" lead the notes with both reasons; the order still goes through', async () => {
    const r = await place(
      { zoneId: 'dha-6', customerName: 'Rashid', customerPhone: '+923340020300', addressLine: 'ABC Road House No 99' },
      { newCustomer: true },
    );
    expect(r.status).toBe(200);
    expect((await stored(r.json.data!.orderId)).notes).toBe(`${NEW}; check the address ("ABC")`);
  });

  it('a new number with a real address: the one reason, then the customer’s words; the totals are untouched', async () => {
    const known = await place({ zoneId: 'dha-6', notes: 'Ring twice' });
    const r = await place({ zoneId: 'dha-6', notes: 'Ring twice' }, { newCustomer: true });
    const row = await stored(r.json.data!.orderId);
    expect(row.notes).toBe(`${NEW}. Ring twice`);
    expect((await stored(known.json.data!.orderId)).notes).toBe('Ring twice');
    expect(row.total_cents).toBe((await stored(known.json.data!.orderId)).total_cents);
  });

  it('the checkout’s own example number reads as made up', async () => {
    const r = await place({ zoneId: 'dha-6', customerPhone: '0300 1234567' }, { newCustomer: true });
    expect((await stored(r.json.data!.orderId)).notes).toBe(`${NEW}; check the number`);
  });

  it('once the till marks an order to the number delivered, its next order has no warning, whatever the address says', async () => {
    const phone = '0321 7654301';
    const first = await place({ zoneId: 'dha-6', customerPhone: phone }, { newCustomer: true });
    expect((await stored(first.json.data!.orderId)).notes).toBe(NEW);
    await setStatus(first.json.data!.orderId, 'delivered');
    const next = await place({ zoneId: 'dha-6', customerPhone: phone, addressLine: 'ABC Road House No 99' }, { newCustomer: true });
    expect((await stored(next.json.data!.orderId)).notes).toBeNull();
  });

  it('a cancelled order earns no trust: the next one from that number is flagged again', async () => {
    const phone = '0321 7654302';
    const first = await place({ zoneId: 'dha-6', customerPhone: phone }, { newCustomer: true });
    await setStatus(first.json.data!.orderId, 'cancelled');
    const next = await place({ zoneId: 'dha-6', customerPhone: phone }, { newCustomer: true });
    expect((await stored(next.json.data!.orderId)).notes).toBe(NEW);
  });

  it('a pick-up from a new number: the warning, with no address to judge', async () => {
    await heartbeat(['pickup']);
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, notes: 'Collecting at 9' }, { newCustomer: true });
    expect(r.status).toBe(200);
    expect((await stored(r.json.data!.orderId)).notes).toBe(`${NEW}. Collecting at 9`);
  });

  it('leads the pin and the handle, and the till’s cap never cuts it — the customer’s words give way', async () => {
    const r = await place(
      { zoneId: 'dha-6', locationPin: PIN, social: '@ahmed_k', notes: 'x'.repeat(500) },
      { newCustomer: true },
    );
    const notes = (await stored(r.json.data!.orderId)).notes!;
    expect(notes.startsWith(`${NEW}. ${PIN_LINE}. Social: @ahmed_k. x`)).toBe(true);
    expect(notes.length).toBeLessThanOrEqual(490);
  });
});


describe('POST /api/orders — Buy 1 Get 1 deals (owner, 7 Oct 2026)', () => {
  /** The menu with a Buy 1 Get 1 deal the till published (never discounted: its category says deals). */
  function dealMenu(): PublishedMenu {
    const m = menu(true);
    m.categories.push({
      posCategoryId: 'c-b1g1',
      name: 'Buy 1 Get 1 Deals',
      displayOrder: 0,
      items: [item('b1g1-lm', 'Large + Free Medium', 2000, { noDiscount: true })],
    });
    return m;
  }
  /**
   * A day in January 2026 at this time on the Karachi clock (UTC+5): in the past of any run, so the till's heartbeat
   * (stamped with the real clock) is never stale — a beat from "the future" still counts as live (lib/store-status).
   */
  const karachi = (hour: number, minute: number) => new Date(Date.UTC(2026, 0, 15, hour - 5, minute));
  const at = (hour: number, minute: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(karachi(hour, minute));
  };
  const DEAL = { zoneId: 'dha-6', items: [{ posItemId: 'b1g1-lm', quantity: 1, modifierIds: [] }] };

  beforeEach(async () => {
    await publish(dealMenu());
    // The flood limiter counts orders newer than 15 minutes before the (faked, January) clock: every order the
    // tests above placed today. None of them matters here.
    await db.pg.query('DELETE FROM web_orders', []);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes a deal from 12 PM to 7 PM with the customer’s Instagram or Facebook name, which leads the notes', async () => {
    at(13, 0);
    const r = await place({ ...DEAL, social: '@ahmed_k', notes: 'Ring twice' });
    expect(r.status).toBe(200);
    const row = await stored(r.json.data!.orderId);
    expect(row.notes).toBe('Buy 1 Get 1: check the post by @ahmed_k. Ring twice');
    expect(row.items.map((i) => [i.posItemId, i.unitPriceCents, i.noDiscount ?? false])).toEqual([
      ['b1g1-lm', 200_000, true],
      ['del-200', 20_000, false],
    ]);
    at(18, 59);
    expect((await place({ ...DEAL, social: '@ahmed_k' })).status).toBe(200);
  });

  it('refuses a deal before 12 PM and from 7 PM, pointing the customer at the cart (12 PM since 24 Oct 2026)', async () => {
    for (const [hour, minute] of [
      [11, 59],
      [19, 0],
      [23, 30],
    ] as const) {
      at(hour, minute);
      const r = await place({ ...DEAL, social: '@ahmed_k' });
      expect(r.status, `${hour}:${minute}`).toBe(409);
      expect(r.json.error).toBe('buy1get1_closed');
      expect(r.json.message).toBe('Buy 1 Get 1 deals are sold from 12 PM to 7 PM. Remove the deal to order now.');
    }
  });

  /** The deal menu with the owner's Buy 1 Get 1 rules in its settings block, as a till of v0.7.39 publishes it. */
  function withRules(rules: Buy1Get1Rules): PublishedMenu {
    const m = dealMenu();
    return {
      ...m,
      settings: buildSettingsBlock({
        zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] })),
        pickup: { offered: true, percent: 10 },
        stamps: [{ version: 1, updatedAt: '2026-01-10T10:00:00.000Z' }],
        menuItems: m.categories.flatMap((c) => c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents }))),
        deviceId: 'till-1',
        buy1Get1: rules,
      }),
    };
  }

  it('follows the owner’s hours from the settings block, past midnight too', async () => {
    await publish(withRules({ ...DEFAULT_BUY_1_GET_1_RULES, opensMinute: 22 * 60, closesMinute: 60 }));
    at(15, 0);
    const r = await place({ ...DEAL, social: '@ahmed_k' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      error: 'buy1get1_closed',
      message: 'Buy 1 Get 1 deals are sold from 10 PM to 1 AM. Remove the deal to order now.',
    });
    at(23, 0);
    expect((await place({ ...DEAL, social: '@ahmed_k' })).status).toBe(200);
    at(0, 30);
    expect((await place({ ...DEAL, social: '@ahmed_k' })).status).toBe(200);
  });

  it('switched off: a deal is refused at any hour; the rest of the menu as before', async () => {
    await publish(withRules({ ...DEFAULT_BUY_1_GET_1_RULES, on: false }));
    at(15, 0);
    const r = await place({ ...DEAL, social: '@ahmed_k' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      error: 'buy1get1_closed',
      message: 'Buy 1 Get 1 deals are not on at the moment. Remove the deal to order now.',
    });
    expect((await place({ zoneId: 'dha-6' })).status).toBe(200);
  });

  it('the name made optional: a deal goes without it, and the notes tell the cashier to ask for the post', async () => {
    await publish(withRules({ ...DEFAULT_BUY_1_GET_1_RULES, asksSocial: false }));
    at(15, 0);
    const r = await place({ ...DEAL, notes: 'Ring twice' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await stored(r.json.data!.orderId)).notes).toBe('Buy 1 Get 1: ask to see the post. Ring twice');
    const named = await place({ ...DEAL, social: '@ahmed_k' });
    expect((await stored(named.json.data!.orderId)).notes).toBe('Buy 1 Get 1: check the post by @ahmed_k');
  });

  it('GET /api/menu leaves the deals out while they are switched off, and shows them while on', async () => {
    const names = async () =>
      ((await (await apiMenu.GET()).json()) as { data: PublishedMenu }).data.categories.map((c) => c.name);
    await publish(withRules({ ...DEFAULT_BUY_1_GET_1_RULES, on: false }));
    expect(await names()).not.toContain('Buy 1 Get 1 Deals');
    await publish(withRules(DEFAULT_BUY_1_GET_1_RULES));
    expect(await names()).toContain('Buy 1 Get 1 Deals');
  });

  it('refuses a deal without the customer’s name (a stray "@" is no name)', async () => {
    at(15, 0);
    for (const social of [undefined, '', '   ', '@']) {
      const r = await place({ ...DEAL, ...(social === undefined ? {} : { social }) });
      expect(r.status, String(social)).toBe(400);
      expect(r.json.error).toBe('buy1get1_social');
    }
  });

  it('leaves every other order alone, at any hour, with or without a name', async () => {
    at(23, 30);
    const r = await place({ zoneId: 'dha-6' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await stored(r.json.data!.orderId)).notes).toBeNull();
    const social = await place({ zoneId: 'dha-6', social: '@ahmed_k' });
    expect((await stored(social.json.data!.orderId)).notes).toBe('Social: @ahmed_k');
  });
});

describe('POST /api/orders — a category’s own % (v0.7.50, WEBSITE DISCOUNT BY CATEGORY)', () => {
  const PIZZA_20 = [{ categoryId: 'c-pizza', percent: 20 }];
  /** menu(true) with Big Two marked as a value deal (v0.7.34+). */
  function dealsMenu(): PublishedMenu {
    const m = menu(true);
    m.categories.splice(2, 0, {
      posCategoryId: 'c-deals',
      name: 'Value Deals',
      displayOrder: 5,
      items: [item('big-two', 'Big Two', 3600, { noDiscount: true })],
    });
    return m;
  }
  /** The till's block by its own code: 10% off, Pizza its own 20% (or none), "also on delivery orders" as given. */
  function tillBlock(m: PublishedMenu, alsoDelivery: boolean, categoryPercents = PIZZA_20, version = 1): PublishedSettings {
    return buildSettingsBlock({
      zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] })),
      pickup: { offered: true, percent: 10, alsoDelivery, categoryPercents },
      stamps: [{ version, updatedAt: `2026-10-13T10:0${version}:00.000Z` }],
      menuItems: m.categories.flatMap((c) => c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents }))),
      deviceId: 'till-1',
    });
  }
  async function setUp(alsoDelivery: boolean, categoryPercents = PIZZA_20, version = 1) {
    const m = dealsMenu();
    expect((await bridgeMenu.PUT(bridge('/api/bridge/menu', { method: 'PUT', body: m }))).status).toBe(200);
    const save = await bridgeSettings.PUT(
      bridge('/api/bridge/settings', {
        method: 'PUT',
        body: { settings: tillBlock(m, alsoDelivery, categoryPercents, version), feeItems: [] },
      }),
    );
    expect(save.status).toBe(200);
  }
  async function shown(): Promise<Record<string, unknown>> {
    return ((await (await storeStatus.GET()).json()) as { data: Record<string, unknown> }).data;
  }
  async function partsStored(id: string): Promise<unknown> {
    const rows = (await db.pg.query('SELECT discount_parts_json FROM web_orders WHERE id = $1', [id])).rows as Array<{
      discount_parts_json: string | null;
    }>;
    return rows[0]!.discount_parts_json;
  }
  /** The order as the till pulls it (every earlier order set aside, so the pull's 25 are never in the way). */
  async function toTill(id: string): Promise<Record<string, unknown>> {
    await db.pg.query(`UPDATE web_orders SET status = 'accepted' WHERE status = 'new' AND id <> $1`, [id]);
    const json = (await (await bridgeOrders.GET(bridge('/api/bridge/orders'))).json()) as { data: Array<Record<string, unknown>> };
    return json.data.find((o) => o['id'] === id)!;
  }
  const line = (posItemId: string) => ({ posItemId, quantity: 1, modifierIds: [] });
  const ALL = ['pickup', 'delivery_discount', 'category_discount'];

  it('off while the listening till cannot bill the parts: a pizza gets the main 10%, nothing stored, nothing shown', async () => {
    await heartbeat(['pickup', 'delivery_discount']);
    await setUp(true);
    const s = await shown();
    expect(s['pickupDiscountPercent']).toBe(10);
    expect(s).not.toHaveProperty('pickupCategoryPercents');
    expect(s).not.toHaveProperty('deliveryCategoryPercents');
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, items: [line('fajita-l')] });
    expect(r.json.data).toMatchObject({ subtotalCents: 200_000, discountCents: 20_000 });
    expect(await partsStored(r.json.data!.orderId)).toBeNull();
    expect(await toTill(r.json.data!.orderId)).not.toHaveProperty('discountParts');
  });

  it('on: a pick-up of Big Two + a pizza + fries — 20% off the pizza, 10% off the fries, Big Two in full; the parts go to the till', async () => {
    await heartbeat(ALL);
    await setUp(true);
    expect(await shown()).toMatchObject({ pickupCategoryPercents: PIZZA_20, deliveryCategoryPercents: PIZZA_20 });
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, items: [line('big-two'), line('fajita-l'), line('loaded')] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Rs 400 off the Rs 2,000 pizza, Rs 70 off the Rs 700 fries; tax 15% on what is left of each line.
    expect(r.json.data).toEqual({
      orderId: r.json.data!.orderId,
      fulfilment: 'pickup',
      subtotalCents: 630_000,
      discountCents: 47_000,
      taxCents: 54_000 + 24_000 + 9_450,
      totalCents: 630_000 - 47_000 + 87_450,
      replayed: false,
    });
    const parts = [
      { percent: 20, categoryId: 'c-pizza' },
      { percent: 10, categoryId: null },
    ];
    expect(await partsStored(r.json.data!.orderId)).toBe(JSON.stringify(parts));
    const order = await toTill(r.json.data!.orderId);
    expect(order).toMatchObject({ fulfilment: 'pickup', discountCents: 47_000, discountParts: parts });
  });

  it('an order with no pizza is priced, stored and pulled exactly as before', async () => {
    await heartbeat(ALL);
    await setUp(true);
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, items: [line('big-two'), line('loaded')] });
    expect(r.json.data).toMatchObject({ subtotalCents: 430_000, discountCents: 7_000 });
    expect(await partsStored(r.json.data!.orderId)).toBeNull();
    const order = await toTill(r.json.data!.orderId);
    expect(order).not.toHaveProperty('discountParts');
    expect(webOrderPickupPercent(order as unknown as Parameters<typeof webOrderPickupPercent>[0])).toBe(10);
  });

  it('a delivery: the pizza’s 20% only with "Also on delivery orders" ticked, and never on the charge', async () => {
    await heartbeat(ALL);
    await setUp(false);
    expect(await shown()).not.toHaveProperty('deliveryCategoryPercents');
    let r = await place({ zoneId: 'dha-6', items: [line('fajita-l')] });
    expect(r.json.data).toMatchObject({ subtotalCents: 220_000, discountCents: 0 });
    expect(await partsStored(r.json.data!.orderId)).toBeNull();
    await setUp(true, PIZZA_20, 2);
    r = await place({ zoneId: 'dha-6', items: [line('fajita-l')] });
    // Rs 400 off the pizza; the Rs 200 charge in full; no other food, so no main part.
    expect(r.json.data).toMatchObject({ subtotalCents: 220_000, discountCents: 40_000, taxCents: 24_000 + 3_000 });
    expect(await partsStored(r.json.data!.orderId)).toBe(JSON.stringify([{ percent: 20, categoryId: 'c-pizza' }]));
  });

  it('a till before 0.7.50 beating in turns it off again; the owner removing the row does too', async () => {
    await heartbeat(ALL);
    await setUp(true);
    await heartbeat(['pickup', 'delivery_discount']);
    expect(await shown()).not.toHaveProperty('pickupCategoryPercents');
    let r = await place({ fulfilment: 'pickup', addressLine: undefined, items: [line('fajita-l')] });
    expect(r.json.data).toMatchObject({ discountCents: 20_000 });
    await heartbeat(ALL);
    await setUp(true, [], 2);
    expect(await shown()).not.toHaveProperty('pickupCategoryPercents');
    r = await place({ fulfilment: 'pickup', addressLine: undefined, items: [line('fajita-l')] });
    expect(r.json.data).toMatchObject({ discountCents: 20_000 });
    expect(await partsStored(r.json.data!.orderId)).toBeNull();
  });
});

describe('POST /api/orders — Meta Conversions API (lib/meta-capi)', () => {
  const PIXEL = '1794891064972562';
  const TOKEN = 'EAAtestTOKEN0123456789abcdefABCDEF';
  const sent: Array<{ url: string; body: { data: CapiEvent[]; test_event_code?: string } }> = [];
  let answer: () => Promise<Response>;

  beforeEach(() => {
    sent.length = 0;
    answer = async () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    process.env['NEXT_PUBLIC_META_PIXEL_ID'] = PIXEL;
    process.env['META_CAPI_ACCESS_TOKEN'] = TOKEN;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return answer();
    });
  });

  afterEach(() => {
    delete process.env['NEXT_PUBLIC_META_PIXEL_ID'];
    delete process.env['META_CAPI_ACCESS_TOKEN'];
    vi.unstubAllGlobals();
  });

  it('sends the order’s Purchase once: its id, the server’s total, the food (no delivery charge), the hashed phone', async () => {
    const clientOrderId = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a77';
    const r = await place({ zoneId: 'dha-6', clientOrderId, customerName: 'Ahmed Khan', metaTestCode: 'TEST4821' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://graph.facebook.com/v26.0/${PIXEL}/events`);
    expect(sent[0]!.body.test_event_code).toBe('TEST4821');
    const event = sent[0]!.body.data[0]!;
    expect(event).toMatchObject({ event_name: 'Purchase', event_id: clientOrderId, action_source: 'website' });
    expect(event.custom_data).toMatchObject({
      value: r.json.data!.totalCents / 100,
      currency: 'PKR',
      content_ids: ['fajita-l'],
      order_id: clientOrderId,
    });
    expect(event.user_data.ph?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(event.user_data.client_ip_address).toMatch(/^10\.0\.0\./);
    expect(JSON.stringify(sent)).not.toMatch(/Ahmed|House 12|0300/);

    // The same checkout sent again is the same order: nothing more goes to Meta.
    const again = await place({ zoneId: 'dha-6', clientOrderId, customerName: 'Ahmed Khan' });
    expect(again.json.data!.orderId).toBe(clientOrderId);
    expect(sent).toHaveLength(1);
  });

  it('takes the order when Meta refuses or is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      answer = async () => new Response(JSON.stringify({ error: { code: 190, message: 'bad token' } }), { status: 400 });
      expect((await place({ zoneId: 'dha-6' })).status).toBe(200);
      answer = async () => {
        throw new Error('ENOTFOUND graph.facebook.com');
      };
      expect((await place({ zoneId: 'dha-6' })).status).toBe(200);
      expect(sent).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('sends nothing for a refused order, or without a token', async () => {
    await place({ zoneId: 'saddar' });
    expect(sent).toHaveLength(0);
    delete process.env['META_CAPI_ACCESS_TOKEN'];
    expect((await place({ zoneId: 'dha-6' })).status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

describe('POST /api/orders — a deal whose price includes its tax (0057)', () => {
  // The shop's live menu: the delivery charges at no tax (Settings → Delivery areas & fees), the deal marked.
  const dealMenu = (): PublishedMenu => {
    const m = menu(true);
    m.categories.push({
      posCategoryId: 'c-deals',
      name: 'Value Deals',
      displayOrder: 0,
      items: [item('mega', 'Mega Cheese Box', 4800, { noDiscount: true, taxIncluded: true })],
    });
    for (const c of m.categories) if (c.name === 'Delivery Charges') for (const i of c.items) i.taxRateBps = 0;
    return m;
  };

  it('a delivery: the printed price plus the delivery fee, nothing added; the line carries the mark to the till', async () => {
    await publish(dealMenu());
    const r = await place({ zoneId: 'dha-6', items: [{ posItemId: 'mega', quantity: 1, modifierIds: [] }] });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ subtotalCents: 500_000, taxCents: 0, totalCents: 500_000 });
    const row = await stored(r.json.data!.orderId);
    expect(row.total_cents).toBe(480_000 + 20_000);
    expect(row.tax_cents).toBe(0);
    expect(row.items[0]).toMatchObject({ posItemId: 'mega', unitPriceCents: 480_000, noDiscount: true, taxIncluded: true });
    // The delivery charge's stored line is as before (no mark).
    expect(row.items[1]).not.toHaveProperty('taxIncluded');
  });

  it('beside a regular pizza: the pizza has its 15% added, the deal stays Rs 4,800', async () => {
    await publish(dealMenu());
    const r = await place({
      zoneId: 'dha-6',
      items: [
        { posItemId: 'mega', quantity: 2, modifierIds: [] },
        { posItemId: 'fajita-l', quantity: 1, modifierIds: [] },
      ],
    });
    const row = await stored(r.json.data!.orderId);
    expect(row.tax_cents).toBe(30_000);
    expect(row.total_cents).toBe(2 * 480_000 + 200_000 + 30_000 + 20_000);
  });

  it('GET /api/menu carries the mark', async () => {
    await publish(dealMenu());
    const json = (await (await apiMenu.GET()).json()) as { data: PublishedMenu };
    const mega = json.data.categories.flatMap((c) => c.items).find((i) => i.posItemId === 'mega');
    expect(mega).toMatchObject({ taxIncluded: true, basePriceCents: 480_000 });
  });
});
