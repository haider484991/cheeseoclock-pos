/**
 * Value deals take no pick-up discount (v0.7.34; owner, 2026-10-02: "Deals
 * never get any discount" and "Yes, say 'not on value deals'"), as the
 * website SAYS it, on a real Postgres (PGlite, in memory, with
 * db/schema.sql), end to end through the bridge, the order routes and the
 * pages. The menu is the pages golden's with its three value deals marked as
 * a v0.7.34 till publishes them (__fixtures__/no-discount.ts):
 *  - every page is the v0.7.30 golden (pages-golden.test.ts) but for ONE
 *    swap: the /menu chip while pick-up is on; GET /api/menu gains only the
 *    three `noDiscount` keys;
 *  - the golden's four pizza-cart checkout states are byte for byte;
 *  - Big Two + Shawarma Pizza on pick-up: the header and the totals say the
 *    deal is left out, with −Rs 220 (10% of the pizza); Big Two alone says
 *    "Not on value deals" instead of "−Rs 0"; the area hint's pick-up offer;
 *  - what the page shows is what POST /api/orders stores;
 *  - the tracking page reads the % on the lines it was worked on: 10%, never
 *    4%; an order with no flag reads as before.
 * Every id, description, name and number here is made up.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  NOT_ON_VALUE_DEALS,
  webOrderDeliveryPercent,
  type DeliveryZoneSetting,
  type PublishedMenu,
  type PublishedSettings,
  type WebFulfilment,
  type WebOrderItem,
} from '@cheeseoclock/shared-types';
import { buildSettingsBlock } from '../../../../packages/pos-domain/src/delivery-charge';
import type { CartLine } from './cart';
import type { PublicMenu } from './public-menu';
import { goldenMenu } from './__fixtures__/golden-menu';
import { DEALS_MARKED_ROUTES, MARKED_DEALS, goldenMenuDealsMarked, htmlWithDealsMarked } from './__fixtures__/no-discount';
import { renderServer, stableHtml } from './__fixtures__/render-pages';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
}));
vi.mock('@/lib/db', () => ({
  // As the Neon client: a tagged template returning rows (PGlite takes $n params).
  sql: () => {
    if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is not configured');
    return async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values)).rows;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/font/google', () => {
  const font = (name: string) => () => ({ className: `font-${name}`, variable: `font-var-${name}`, style: { fontFamily: name } });
  return { Anton: font('anton'), Barlow: font('barlow'), Barlow_Condensed: font('barlow-condensed') };
});

// The pages are JSX compiled for React in scope (as Next does it): give the test the same.
const React = await import('react');
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = await import('react-dom/server');

const layout = await import('@/app/layout');
const home = await import('@/app/page');
const hub = await import('@/app/delivery/page');
const area = await import('@/app/delivery/[area]/page');
const pizza = await import('@/app/pizza-delivery-dha-karachi/page');
const burger = await import('@/app/burger-delivery-dha-karachi/page');
const lateNight = await import('@/app/late-night-food-delivery-dha/page');
const menuPage = await import('@/app/menu/page');
const notFound = await import('@/app/not-found');
const track = await import('@/app/track/[id]/page');
const apiMenu = await import('@/app/api/menu/route');
const menuRoute = await import('@/app/api/bridge/menu/route');
const bridgeStatus = await import('@/app/api/bridge/status/route');
const orders = await import('@/app/api/orders/route');
const orderById = await import('@/app/api/orders/[id]/route');
const { CheckoutSheet } = await import('@/components/ordering/CheckoutSheet');
const { CartPanel } = await import('@/components/ordering/cart-ui');
const { DEFAULT_FACTS, findFactZone, deliveryFeeRange, deliveryOptionNote } = await import('@/lib/delivery-facts');
const { DELIVERY_AREAS } = await import('@/lib/areas');
const { publicMenu } = await import('@/lib/public-menu');
const { cartLineKey, cartPricedLines, cartSubtotalCents } = await import('@/lib/cart');
const { cartDeals, menuHasNoDiscountItems } = await import('@/lib/menu-view');
const { zoneFeeItemFor } = await import('@/lib/delivery-zones');
const { priceOrder } = await import('@/lib/pricing');
const { pickupDiscountWords } = await import('@/lib/order-display');

type SheetProps = Parameters<typeof CheckoutSheet>[0];

const SECRET = 'test-bridge-secret-0123456789';
const golden = JSON.parse(readFileSync(new URL('./__fixtures__/pages-v0.7.30.json', import.meta.url), 'utf8')) as {
  html: Record<string, string>;
  pages: Record<string, Record<string, string>>;
  metadata: Record<string, Record<string, unknown>>;
  apiMenu: Record<string, { ok: boolean; data: PublishedMenu }>;
  checkout: Record<string, string>;
};

// ---------------------------------------------------------------------------

function bridge(path: string, body: unknown) {
  return new Request(`https://site.test${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A v0.7.30 till's settings block for this menu with every setting at its default (as pages-golden.test.ts). */
function defaultBlock(m: PublishedMenu): PublishedSettings {
  const zones: DeliveryZoneSetting[] = DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] }));
  return buildSettingsBlock({
    zones,
    pickup: { offered: true, percent: 10 },
    stamps: [null, null, null],
    menuItems: m.categories.flatMap((c) => c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents }))),
    deviceId: 'till-golden',
    website: { closedNotice: { text: '', until: null }, announcement: { on: false, text: '' }, minDeliveryOrderCents: 0 },
  });
}

async function publish(m: PublishedMenu, settings?: PublishedSettings): Promise<void> {
  const res = await menuRoute.PUT(bridge('/api/bridge/menu', settings ? { ...m, settings } : m));
  expect(res.status).toBe(200);
}

async function heartbeat(accepting: boolean): Promise<void> {
  const res = await bridgeStatus.PUT(
    bridge('/api/bridge/status', { acceptingOrders: accepting, deviceId: 'till-golden', features: ['pickup'], pickupDiscountPercent: 10 }),
  );
  expect(res.status).toBe(200);
}

/** A page's element inside the root layout, rendered as served (the footer's year pinned). */
async function page(el: React.ReactElement): Promise<string> {
  return stableHtml(await renderServer(React.createElement(layout.default, { children: el })));
}

/** Every page of the site, /menu open then closed: route → HTML (pages-golden.test.ts's routes). */
async function allPages(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  out['/'] = await page(React.createElement(home.default));
  out['/delivery'] = await page(React.createElement(hub.default));
  for (const a of DELIVERY_AREAS) out[`/delivery/${a.slug}`] = await page(React.createElement(area.default, { params: { area: a.slug } }));
  out['/pizza-delivery-dha-karachi'] = await page(React.createElement(pizza.default));
  out['/burger-delivery-dha-karachi'] = await page(React.createElement(burger.default));
  out['/late-night-food-delivery-dha'] = await page(React.createElement(lateNight.default));
  for (const s of ['open', 'closed'] as const) {
    await heartbeat(s === 'open');
    out[`/menu (${s})`] = await page(React.createElement(menuPage.default));
  }
  out['/_not-found'] = await page(React.createElement(notFound.default));
  out['/track/[id]'] = await page(React.createElement(track.default, { params: { id: 'test-order-id' } }));
  return out;
}

/** Every page's metadata (the root layout's under "layout"), as pages-golden.test.ts takes it. */
async function allMetadata(): Promise<Record<string, unknown>> {
  const metaOf = async (mod: { metadata?: unknown; generateMetadata?: (a: never) => unknown }, arg?: unknown) => {
    const m = mod.generateMetadata ? await mod.generateMetadata(arg as never) : mod.metadata;
    return m === undefined ? null : (JSON.parse(JSON.stringify(m)) as unknown);
  };
  const out: Record<string, unknown> = {};
  out['layout'] = await metaOf(layout as never);
  out['/'] = await metaOf(home as never);
  out['/delivery'] = await metaOf(hub as never);
  for (const a of DELIVERY_AREAS) out[`/delivery/${a.slug}`] = await metaOf(area as never, { params: { area: a.slug } });
  out['/pizza-delivery-dha-karachi'] = await metaOf(pizza as never);
  out['/burger-delivery-dha-karachi'] = await metaOf(burger as never);
  out['/late-night-food-delivery-dha'] = await metaOf(lateNight as never);
  out['/menu'] = await metaOf(menuPage as never);
  out['/_not-found'] = await metaOf(notFound as never);
  out['/track/[id]'] = await metaOf(track as never, { params: { id: 'test-order-id' } });
  return out;
}

async function apiMenuBody(): Promise<unknown> {
  return (await (await apiMenu.GET()).json()) as unknown;
}

/** The golden's GET /api/menu with `noDiscount: true` on the marked deals, and nothing else. */
function goldenApiMenuMarked(state: 'b' | 'c'): unknown {
  const body = structuredClone(golden.apiMenu[state]!);
  for (const c of body.data.categories) {
    c.items = c.items.map((i) => (MARKED_DEALS.includes(i.name) ? { ...i, noDiscount: true } : i));
  }
  return body;
}

// ---------------------------------------------------------------------------
// The cart as the ordering page works it out (OrderingApp → CheckoutSheet)
// ---------------------------------------------------------------------------

/** One line of the menu's item by name, with these choices (a deal's pizza slots). */
function lineOf(menu: PublicMenu, name: string, modifierIds: string[] = [], quantity = 1): CartLine {
  const item = menu.categories.flatMap((c) => c.items).find((i) => i.name === name);
  if (!item) throw new Error(`no ${name} on the menu`);
  return { key: cartLineKey(item.posItemId, modifierIds, null), item, label: name, quantity, modifierIds, notes: null };
}

/**
 * The checkout sheet's props for this cart, worked out as OrderingApp does:
 * the page's own helpers for the priced lines (cartPricedLines), the fee
 * line (zoneFeeItemFor), the deal flags (menuHasNoDiscountItems, cartDeals).
 */
function sheetProps(menu: PublicMenu, cart: CartLine[], fulfilment: WebFulfilment, zoneId = ''): SheetProps {
  const pickup = fulfilment === 'pickup';
  const zone = pickup ? undefined : findFactZone(DEFAULT_FACTS, zoneId);
  const priced = cartPricedLines(cart);
  const feeItem = zone ? zoneFeeItemFor(menu, zone) : undefined;
  const deliveryFee = zone && cart.length > 0 ? zone.feeCents : 0;
  if (deliveryFee > 0) priced.push({ lineTotalCents: deliveryFee, taxRateBps: feeItem?.taxRateBps ?? 0 });
  const totals = priceOrder(priced, pickup ? 10 : 0);
  return {
    cart,
    subtotal: cartSubtotalCents(cart),
    deliveryFee,
    discount: totals.discountCents,
    zone,
    tax: totals.taxCents,
    total: totals.totalCents,
    setQty: () => {},
    onClear: () => {},
    fulfilment,
    canPickup: true,
    pickupPct: 10,
    onFulfilment: () => {},
    pickupOnlyInCart: [],
    feeRange: deliveryFeeRange(DEFAULT_FACTS),
    deliveryNote: deliveryOptionNote(DEFAULT_FACTS),
    minDeliveryOrderCents: 0,
    notOnDeals: menuHasNoDiscountItems(menu),
    ...cartDeals(cart),
    zoneId,
    onZone: () => {},
    deliveryFacts: DEFAULT_FACTS,
    acceptingOrders: true,
    closedNotice: null,
    onClose: () => {},
    orderIdFor: () => 'test-order-key',
    onPlaced: () => {},
  };
}

const sheet = (props: SheetProps) => renderToStaticMarkup(React.createElement(CheckoutSheet, props));
/** The same props as a page that knows nothing of value deals passed them (v0.7.33's words). */
const withoutDealWords = (props: SheetProps): SheetProps => {
  const { notOnDeals: _menu, dealInCart: _cart, onlyDeals: _only, ...rest } = props;
  return rest;
};

const MARKED = publicMenu(goldenMenuDealsMarked());
const UNMARKED = publicMenu(goldenMenu());
/** Big Two with a Large Fajita and a 2nd Large Classic Supreme (its two required slots, Rs 0 each). */
const bigTwo = (m: PublicMenu, quantity = 1) => lineOf(m, 'Big Two', ['g-two-1-a', 'g-two-2-b'], quantity);
const shawarma = (m: PublicMenu) => lineOf(m, 'Shawarma Pizza — Large');

const HEADER = (words: string) => `<p class="mt-1.5 font-cond text-sm font-bold uppercase tracking-wide text-cheese">${words}</p>`;
const PICKUP_ROW = (dt: string, dd: string) =>
  `<div class="flex justify-between font-semibold text-emerald-700"><dt>${dt}</dt><dd class="tabular-nums">${dd}</dd></div>`;

// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = 'postgres://test.invalid/db';
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
}, 120_000);

afterAll(() => {
  delete process.env['BRIDGE_SECRET'];
});

describe('the value deals marked: every page as v0.7.30 but the /menu chip', () => {
  const now: {
    pages: Record<string, Record<string, string>>;
    metadata: Record<string, unknown>;
    apiMenu: Record<string, unknown>;
  } = { pages: {}, metadata: {}, apiMenu: {} };

  beforeAll(async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await db.pg.query('DELETE FROM site_menu', []);
      const m = goldenMenuDealsMarked();
      // (b) a published menu, no settings block
      await publish(m);
      now.pages['b'] = await allPages();
      now.metadata['b'] = await allMetadata();
      now.apiMenu['b'] = await apiMenuBody();
      // (c) the same with a v0.7.30 till's block at the defaults
      await publish(m, defaultBlock(m));
      now.pages['c'] = await allPages();
      now.metadata['c'] = await allMetadata();
      now.apiMenu['c'] = await apiMenuBody();
    } finally {
      quiet.mockRestore();
    }
  }, 120_000);

  for (const state of ['b', 'c'] as const) {
    it(`(${state}) every page’s HTML is the golden, but '/menu (open)' by exactly the chip`, () => {
      expect(Object.keys(now.pages[state]!)).toEqual(Object.keys(golden.pages[state]!));
      for (const [route, key] of Object.entries(golden.pages[state]!)) {
        const was = golden.html[key]!;
        expect(now.pages[state]![route], `${state} ${route}`).toBe(htmlWithDealsMarked(route, was));
        expect(now.pages[state]![route] === was, `${state} ${route} unchanged`).toBe(!DEALS_MARKED_ROUTES.includes(route));
      }
      // The chip in its new words, once; the old words nowhere. Closed (no pick-up offered): no chip at all, as before.
      const open = now.pages[state]!['/menu (open)']!;
      expect(open.split('10% off online pick-up · not on value deals</li>').length - 1).toBe(1);
      expect(open).not.toContain('when you order online');
      expect(now.pages[state]!['/menu (closed)']).not.toContain('% off');
    });

    it(`(${state}) every page’s title, description, canonical, Open Graph and Twitter blocks, and the root layout’s`, () => {
      expect(now.metadata[state]).toEqual(golden.metadata[state]);
    });

    it(`(${state}) GET /api/menu gains only the three deals’ noDiscount`, () => {
      expect(now.apiMenu[state]).toEqual(goldenApiMenuMarked(state));
      expect(JSON.stringify(now.apiMenu[state]).split('"noDiscount":true').length - 1).toBe(3);
    });
  }
});

describe('the checkout with the value deals marked', () => {
  it('the golden’s four pizza-cart states (delivery and pick-up, open and closed) are byte for byte the golden', () => {
    const cart = [{ ...shawarma(MARKED), label: 'Shawarma Pizza · Large 12"' }];
    // The golden's figures exactly (pages-golden.test.ts allCheckout), with the flags as the page works them out.
    const base: SheetProps = {
      ...sheetProps(MARKED, cart, 'delivery', 'dha-6'),
      deliveryFee: 20_000,
      discount: 0,
      tax: 33_000,
      total: 273_000,
    };
    expect([base.notOnDeals, base.dealInCart, base.onlyDeals]).toEqual([true, false, false]);
    for (const fulfilment of ['delivery', 'pickup'] as const) {
      for (const acceptingOrders of [true, false]) {
        const props = { ...base, fulfilment, acceptingOrders, ...(fulfilment === 'pickup' ? { discount: 22_000, deliveryFee: 0 } : {}) };
        const k = `${fulfilment}, ${acceptingOrders ? 'open' : 'closed'}`;
        expect(sheet(props), k).toBe(golden.checkout[k]);
      }
    }
  });

  it('Big Two (Rs 3,600) + Shawarma Pizza (Rs 2,200) on pick-up: −Rs 220, and the header and the totals say value deals are left out — nothing else moves', () => {
    const props = sheetProps(MARKED, [bigTwo(MARKED), shawarma(MARKED)], 'pickup');
    // 10% of the pizza only; Big Two taxed on its full price.
    expect([props.subtotal, props.discount, props.tax, props.total]).toEqual([580_000, 22_000, 54_000 + 29_700, 641_700]);
    const html = sheet(props);
    expect(html).toContain(HEADER('Pick-up · 10% off, not on value deals · pay at the counter'));
    expect(html).toContain(PICKUP_ROW('Pick-up 10% off (not on value deals)', '−Rs 220'));
    expect(html).toContain('Place order · Rs 6,417');
    // The toggle keeps its words.
    expect(html).toContain('Pick up · 10% off</span>');
    // Without the deal words (the same figures) the sheet is the page as before, byte for byte.
    expect(
      html
        .replace(HEADER('Pick-up · 10% off, not on value deals · pay at the counter'), HEADER('Pick-up · 10% off · pay at the counter'))
        .replace(PICKUP_ROW('Pick-up 10% off (not on value deals)', '−Rs 220'), PICKUP_ROW('Pick-up 10% off', '−Rs 220')),
    ).toBe(sheet(withoutDealWords(props)));
    // The desktop cart says the same.
    const panel = renderToStaticMarkup(React.createElement(CartPanel, { ...props, onCheckout: () => {} }));
    expect(panel).toContain(PICKUP_ROW('Pick-up 10% off (not on value deals)', '−Rs 220'));
  });

  it('Big Two alone on pick-up: "Not on value deals" where the amount off would be, never "−Rs 0"', () => {
    const props = sheetProps(MARKED, [bigTwo(MARKED)], 'pickup');
    expect([props.subtotal, props.discount, props.tax, props.total]).toEqual([360_000, 0, 54_000, 414_000]);
    expect([props.dealInCart, props.onlyDeals]).toEqual([true, true]);
    const html = sheet(props);
    expect(html).toContain(HEADER('Pick-up · 10% off, not on value deals · pay at the counter'));
    expect(html).toContain(PICKUP_ROW('Pick-up 10% off', 'Not on value deals'));
    expect(html).not.toContain('−Rs 0');
    // Said twice (the header, the row), nowhere else.
    expect(html.match(/not on value deals/gi)).toHaveLength(2);
  });

  it('a delivery: the totals and header as before; with no area chosen yet, the hint’s pick-up offer says value deals are left out', () => {
    const cart = [bigTwo(MARKED), shawarma(MARKED)];
    const chosen = sheet(sheetProps(MARKED, cart, 'delivery', 'dha-6'));
    expect(chosen).toContain(HEADER('Cash on delivery · pay the rider'));
    expect(chosen).not.toContain(NOT_ON_VALUE_DEALS);
    expect(chosen).toBe(sheet(withoutDealWords(sheetProps(MARKED, cart, 'delivery', 'dha-6'))));
    const noArea = sheet(sheetProps(MARKED, cart, 'delivery'));
    expect(noArea).toContain('We deliver in DHA and Clifton only. Elsewhere? Choose pick-up — 10% off, not on value deals.');
    // Nothing marked: today's hint.
    expect(sheet(sheetProps(UNMARKED, [shawarma(UNMARKED)], 'delivery'))).toContain(
      'We deliver in DHA and Clifton only. Elsewhere? Choose pick-up — 10% off.</span>',
    );
  });

  it('nothing marked (every menu a till up to v0.7.33 publishes): no deal words anywhere, and Big Two takes its 10% as before', () => {
    expect(menuHasNoDiscountItems(UNMARKED)).toBe(false);
    const props = sheetProps(UNMARKED, [bigTwo(UNMARKED), shawarma(UNMARKED)], 'pickup');
    expect([props.discount, props.notOnDeals, props.dealInCart, props.onlyDeals]).toEqual([58_000, false, false, false]);
    const html = sheet(props);
    expect(html).toContain(PICKUP_ROW('Pick-up 10% off', '−Rs 580'));
    expect(html).not.toMatch(/value deals/i);
    expect(html).toBe(sheet(withoutDealWords(props)));
  });

  it('a delivery charge marked by mistake never makes the menu say it', () => {
    const m = goldenMenu();
    const chargeMarked = publicMenu({
      ...m,
      categories: m.categories.map((c) => (c.name === 'Delivery Charges' ? { ...c, items: c.items.map((i) => ({ ...i, noDiscount: true })) } : c)),
    });
    expect(menuHasNoDiscountItems(chargeMarked)).toBe(false);
    expect(menuHasNoDiscountItems(MARKED)).toBe(true);
  });
});

describe('what the page shows is what the website stores', () => {
  let ip = 0;
  /** POST /api/orders with this cart, as the checkout sends it. */
  async function place(cart: CartLine[], fulfilment: WebFulfilment, zoneId?: string) {
    ip += 1;
    const phone = `0300 12399${String(ip).padStart(2, '0')}`;
    const res = await orders.POST(
      new Request('https://site.test/api/orders', {
        method: 'POST',
        // A fresh made-up phone and client address per call keep the flood limiter out of the way.
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.9.${ip}` },
        body: JSON.stringify({
          clientOrderId: crypto.randomUUID(),
          customerName: 'Test Customer',
          customerPhone: phone,
          fulfilment,
          ...(fulfilment === 'pickup' ? {} : { addressLine: 'House 1, Test Street', zoneId }),
          items: cart.map((l) => ({ posItemId: l.item.posItemId, quantity: l.quantity, modifierIds: l.modifierIds })),
        }),
      }),
    );
    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
      data?: { orderId: string; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number };
    };
    expect([res.status, json.ok], JSON.stringify(json)).toEqual([200, true]);
    return { ...json.data!, phone };
  }
  /** The tracking page's read of the order (GET /api/orders/[id]). */
  async function tracked(id: string, phone: string) {
    const res = await orderById.GET(new Request(`https://site.test/api/orders/${id}?phone=${encodeURIComponent(phone)}`), { params: { id } });
    const json = (await res.json()) as { ok: boolean; data: { fulfilment: string; items: WebOrderItem[]; subtotalCents: number; discountCents?: number } };
    expect(json.ok).toBe(true);
    return json.data;
  }
  const figures = (p: SheetProps) => ({ subtotalCents: p.subtotal + p.deliveryFee, discountCents: p.discount, taxCents: p.tax, totalCents: p.total });

  beforeAll(async () => {
    await db.pg.query('DELETE FROM site_menu', []);
    const m = goldenMenuDealsMarked();
    await publish(m, defaultBlock(m));
    await heartbeat(true);
  });

  it('pick-ups and deliveries with and without a deal: the page’s totals are the stored ones', async () => {
    const carts: Array<[CartLine[], WebFulfilment, string?]> = [
      [[bigTwo(MARKED), shawarma(MARKED)], 'pickup'],
      [[bigTwo(MARKED)], 'pickup'],
      [[bigTwo(MARKED, 2), lineOf(MARKED, 'Perfect Pair', ['g-pair-1-a', 'g-pair-2-a']), lineOf(MARKED, 'Nuggets', [], 3)], 'pickup'],
      [[lineOf(MARKED, 'Family Feast', ['g-feast-1-b', 'g-feast-2-a']), lineOf(MARKED, 'Signature Cheese Dipped', ['m-cheese-3', 'm-dip-a-b3'])], 'pickup'],
      [[shawarma(MARKED), lineOf(MARKED, 'Fries — Large', [], 2)], 'pickup'],
      [[bigTwo(MARKED), shawarma(MARKED)], 'delivery', 'dha-6'],
      [[lineOf(MARKED, 'Perfect Pair', ['g-pair-1-b', 'g-pair-2-b'])], 'delivery', 'clifton-1'],
    ];
    for (const [cart, fulfilment, zoneId] of carts) {
      const shown = sheetProps(MARKED, cart, fulfilment, zoneId);
      const placed = await place(cart, fulfilment, zoneId);
      expect(placed, cart.map((l) => l.label).join(' + ')).toMatchObject(figures(shown));
    }
  });

  it('the tracking page of that Big Two + Shawarma Pizza pick-up: 10% off, "(not on value deals)"', async () => {
    const placed = await place([bigTwo(MARKED), shawarma(MARKED)], 'pickup');
    const order = await tracked(placed.orderId, placed.phone);
    expect(order.items.map((i) => i.noDiscount === true)).toEqual([true, false]);
    expect(pickupDiscountWords(order)).toEqual({ pct: 10, row: 'Pick-up 10% off (not on value deals)' });
  });
});

describe('the tracking page’s pick-up % (OrderTracker, lib/order-display pickupDiscountWords)', () => {
  const ln = (name: string, rs: number, flagged = false): WebOrderItem => ({
    posItemId: `t-${name}`,
    name,
    quantity: 1,
    unitPriceCents: rs * 100,
    modifiers: [],
    notes: null,
    ...(flagged ? { noDiscount: true } : {}),
  });

  it('Rs 150 off Rs 4,100 with the Rs 2,600 deal flagged: 10% and "(not on value deals)" — never 4%', () => {
    const order = { items: [ln('Perfect Pair', 2600, true), ln('Fajita Pizza — Medium', 1500)], subtotalCents: 410_000, discountCents: 15_000 };
    expect(pickupDiscountWords(order)).toEqual({ pct: 10, row: 'Pick-up 10% off (not on value deals)' });
    // What v0.7.33's tracker worked out (discount ÷ subtotal).
    expect(Math.round((15_000 * 100) / 410_000)).toBe(4);
  });

  it('an order with no flag reads as today: discount ÷ subtotal, today’s words', () => {
    expect(pickupDiscountWords({ items: [ln('Fajita Pizza — Large', 4100)], subtotalCents: 410_000, discountCents: 41_000 })).toEqual({
      pct: 10,
      row: 'Pick-up 10% off',
    });
    // No discount stored (an order from before the field), or nothing in it: 0, as before.
    expect(pickupDiscountWords({ items: [ln('Fries', 300)], subtotalCents: 30_000 }).pct).toBe(0);
    expect(pickupDiscountWords({ items: [], subtotalCents: 0, discountCents: 0 }).pct).toBe(0);
    // Every pick-up % up to the website's 50%, on seeded orders: the old formula's number.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let k = 0; k < 500; k += 1) {
      const items = Array.from({ length: 1 + rand(5) }, (_, i) => ({ ...ln(`Item ${i}`, 100 + rand(5000)), quantity: 1 + rand(3) }));
      const subtotalCents = items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
      const discountCents = Math.round((subtotalCents * rand(51)) / 100);
      const was = Math.round((discountCents * 100) / subtotalCents);
      expect(pickupDiscountWords({ items, subtotalCents, discountCents })).toEqual({ pct: was, row: `Pick-up ${was}% off` });
    }
  });

  it('the tracker uses it for its header and totals row (read from the source)', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/OrderTracker.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('const { pct, row: discountRow } = pickupDiscountWords(order);');
    expect(src).toContain('<dt>{discountRow}</dt>');
    expect(src).toContain("Pick-up{pct > 0 ? ` · ${pct}% off` : ''} · pay at the counter");
    expect(src).not.toMatch(/\/\s*order\.subtotalCents/);
  });
});

describe('the tracking page’s delivery % (v0.7.37, WEBSITE DELIVERY DISCOUNT)', () => {
  const ln = (name: string, rs: number, flagged = false): WebOrderItem => ({
    posItemId: `t-${name}`,
    name,
    quantity: 1,
    unitPriceCents: rs * 100,
    modifiers: [],
    notes: null,
    ...(flagged ? { noDiscount: true } : {}),
  });

  it('Rs 200 off a delivery of a Rs 2,000 pizza + Big Two + a Rs 200 charge reads 10% off the food, deals left out', () => {
    const order = {
      fulfilment: 'delivery',
      items: [ln('Big Two', 3600, true), ln('Fajita Pizza — Large', 2000), ln('Delivery Charge (Rs 200)', 200)],
      subtotalCents: 580_000,
      discountCents: 20_000,
    };
    expect(pickupDiscountWords(order)).toEqual({ pct: 10, row: 'Online 10% off food (not on value deals)' });
  });

  it('the charge is never in the base: Rs 220 off Rs 2,200 of food with a Rs 250 charge is 10%, not 9%', () => {
    const order = {
      fulfilment: 'delivery',
      items: [ln('Cheesy Star — Large', 2200), ln('Delivery Charge (Rs 250)', 250)],
      subtotalCents: 245_000,
      discountCents: 22_000,
    };
    expect(pickupDiscountWords(order)).toEqual({ pct: 10, row: 'Online 10% off food' });
    expect(webOrderDeliveryPercent(order)).toBe(10);
    // …and when the website priced the charge without a line (its item missing), the lines alone are the base.
    expect(webOrderDeliveryPercent({ ...order, items: [ln('Cheesy Star — Large', 2200)] })).toBe(10);
  });

  it('a delivery with no discount (every order before v0.7.37) reads 0; a pick-up never reads the delivery way', () => {
    expect(webOrderDeliveryPercent({ fulfilment: 'delivery', items: [ln('Fries', 300)], discountCents: 0 })).toBe(0);
    expect(webOrderDeliveryPercent({ fulfilment: 'delivery', items: [ln('Fries', 300)] })).toBe(0);
    expect(webOrderDeliveryPercent({ fulfilment: 'pickup', items: [ln('Fries', 300)], discountCents: 3_000 })).toBe(0);
    // Deals only: nothing could take a share.
    expect(webOrderDeliveryPercent({ fulfilment: 'delivery', items: [ln('Big Two', 3600, true)], discountCents: 100 })).toBe(0);
    // Kept to 0–50%.
    expect(webOrderDeliveryPercent({ fulfilment: 'delivery', items: [ln('Fries', 300)], discountCents: 30_000 })).toBe(50);
    // A pick-up's words are today's.
    expect(pickupDiscountWords({ fulfilment: 'pickup', items: [ln('Fajita Pizza — Large', 4100)], subtotalCents: 410_000, discountCents: 41_000 }).row).toBe(
      'Pick-up 10% off',
    );
  });
});
