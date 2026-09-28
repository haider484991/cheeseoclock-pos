/**
 * The owner's website messages and smallest delivery order (v0.7.30, sweep
 * B1: shared-types web-bridge.ts, WEBSITE MESSAGES), on a real Postgres
 * (PGlite, in memory, with db/schema.sql), end to end through the route
 * handlers and the pages, with blocks the till's own code builds
 * (pos-domain buildSettingsBlock):
 *  - nothing new stored (no block, a v0.7.29 till's block, a block at the
 *    defaults): the home page is v0.7.29's element for element, the closed
 *    shop says today's sentence, any order goes through;
 *  - the closed notice shows through its last Karachi day and not after,
 *    whatever the server's own time zone;
 *  - the announcement shows on the home page and /menu while on, as page
 *    text only;
 *  - a website delivery under the smallest order is refused on the server,
 *    a pick-up never is, and the checkout agrees;
 *  - a v0.7.29 till's block (no message fields) keeps what the website
 *    stored, on both bridge routes; a block with them at their defaults
 *    clears them;
 *  - the bounds, at the bridge and on a hand-edited stored row.
 * All menu items, figures and words are made up.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  type ClosedNotice,
  type DeliveryZoneSetting,
  type PublishedFeeItem,
  type PublishedMenu,
  type PublishedMenuItem,
  type PublishedSettings,
  type WebsiteAnnouncement,
} from '@cheeseoclock/shared-types';
import { publishedSettingsSchema } from '@cheeseoclock/shared-schemas/web-settings';
import { buildSettingsBlock } from '../../../../packages/pos-domain/src/delivery-charge';
import golden from './__fixtures__/site-copy-v0.7.26.json';
import homeV0729 from './__fixtures__/home-page-v0.7.29.json';
import { DELIVERY_AREAS, getArea, renderArea } from './areas';
import { problemFromServer, validateCheckout, type CheckoutInput } from './checkout-validation';
import { DEFAULT_FACTS, factsFromBlock } from './delivery-facts';
import { KEPT_MESSAGE_FIELDS } from './publish-settings';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
}));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values)).rows,
}));
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => {
    revalidated.push(`${path} ${type ?? ''}`.trim());
  },
}));

const menuRoute = await import('@/app/api/bridge/menu/route');
const settingsRoute = await import('@/app/api/bridge/settings/route');
const bridgeStatus = await import('@/app/api/bridge/status/route');
const orders = await import('@/app/api/orders/route');
const storeStatus = await import('@/app/api/store-status/route');
const { getSiteFacts, parseStoredSettings } = await import('@/lib/site-facts');
// The pages are JSX compiled for React in scope (as Next does it): give the test the same.
(globalThis as { React?: unknown }).React = await import('react');
const homePage = await import('@/app/page');
const menuPage = await import('@/app/menu/page');

const SECRET = 'test-bridge-secret-0123456789';
function bridge(path: string, init?: { method?: string; body?: unknown }) {
  return new Request(`https://site.test${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
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
const RS200 = item('fee-200', 'Delivery Charge (Rs 200)', 200);
const RS250 = item('fee-250', 'Delivery Charge (Rs 250)', 250);
const FEES = { posCategoryId: 'c-del', name: 'Delivery Charges', displayOrder: 6 };
/** A made-up menu: foods at made-up prices (one with a paid choice) and today's two delivery charges. */
function menu(): PublishedMenu {
  return {
    categories: [
      {
        posCategoryId: 'c-food',
        name: 'Test Food',
        displayOrder: 1,
        items: [
          item('food-999', 'Test Wrap', 999),
          item('food-1000', 'Test Platter', 1000),
          item('food-500', 'Test Fries', 500),
          item('food-800', 'Test Burger', 800),
          item('food-1', 'Test Dip', 1),
          item('food-900', 'Test Bowl', 900, {
            modifierGroups: [
              {
                posGroupId: 'g-extra',
                name: 'Extras',
                selectionType: 'multi',
                minSelect: 0,
                maxSelect: 0,
                isRequired: false,
                sortOrder: 0,
                modifiers: [{ posModifierId: 'm-cheese', name: 'Cheese', priceDeltaCents: 10_000, isDefault: false, sortOrder: 0 }],
              },
            ],
          }),
        ],
      },
      { ...FEES, items: [RS200, RS250] },
    ],
    publishedAt: '2026-09-27T09:00:00.000Z',
    store: { name: 'Test Shop', phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}

interface WebsiteFields {
  closedNotice?: ClosedNotice;
  announcement?: WebsiteAnnouncement;
  minDeliveryOrderCents?: number;
}

/**
 * The block a till sends for this menu, by the till's own code: today's
 * areas, stamped as saved `rev` times. Without `website` it is a v0.7.29
 * till's block (no message fields); with it, a v0.7.30 till's (all three,
 * each at its default unless given).
 */
function tillBlock(m: PublishedMenu, opts: { rev?: number; at?: string; device?: string; website?: WebsiteFields } = {}): PublishedSettings {
  const zones: DeliveryZoneSetting[] = DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] }));
  return buildSettingsBlock({
    zones,
    pickup: { offered: true, percent: 10 },
    stamps: [{ version: opts.rev ?? 1, updatedAt: opts.at ?? '2026-09-27T10:00:00.000Z' }],
    menuItems: m.categories.flatMap((c) => c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents }))),
    deviceId: opts.device ?? 'till-1',
    ...(opts.website
      ? {
          website: {
            closedNotice: opts.website.closedNotice ?? { text: '', until: null },
            announcement: opts.website.announcement ?? { on: false, text: '' },
            minDeliveryOrderCents: opts.website.minDeliveryOrderCents ?? 0,
          },
        }
      : {}),
  });
}

async function publish(m: PublishedMenu, settings?: PublishedSettings) {
  const res = await menuRoute.PUT(bridge('/api/bridge/menu', { method: 'PUT', body: settings ? { ...m, settings } : m }));
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> } };
}
/** A Save on the till: the block alone (PUT /api/bridge/settings), no fee item needed (today's items are published). */
async function save(settings: PublishedSettings, feeItems: PublishedFeeItem[] = []) {
  const res = await settingsRoute.PUT(bridge('/api/bridge/settings', { method: 'PUT', body: { settings, feeItems } }));
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> } };
}
async function storedSettings(): Promise<Record<string, unknown> | null> {
  const rows = (await db.pg.query('SELECT menu_json FROM site_menu WHERE id = 1', [])).rows as Array<{ menu_json: PublishedMenu | string }>;
  const v = rows[0]?.menu_json;
  if (!v) return null;
  const doc = typeof v === 'string' ? (JSON.parse(v) as PublishedMenu) : v;
  return (doc.settings as unknown as Record<string, unknown> | undefined) ?? null;
}

async function heartbeat(accepting: boolean, features?: string[]) {
  const res = await bridgeStatus.PUT(
    bridge('/api/bridge/status', { method: 'PUT', body: { acceptingOrders: accepting, deviceId: 'till-1', features } }),
  );
  expect(res.status).toBe(200);
}

let ip = 0;
async function place(body: Record<string, unknown>) {
  ip += 1;
  const res = await orders.POST(
    new Request('https://site.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.3.${Math.floor(ip / 200)}.${ip % 200}` },
      body: JSON.stringify({
        customerName: 'Test Customer',
        customerPhone: `0300 3${String(ip).padStart(6, '0')}`,
        addressLine: 'House 1, Street 1',
        zoneId: 'dha-6',
        items: [{ posItemId: 'food-1000', quantity: 1, modifierIds: [] }],
        ...body,
      }),
    }),
  );
  return {
    status: res.status,
    json: (await res.json()) as { ok: boolean; error?: string; message?: string; data?: { orderId: string; subtotalCents: number } },
  };
}
async function orderCount(): Promise<number> {
  const rows = (await db.pg.query('SELECT count(*)::int AS n FROM web_orders', [])).rows as Array<{ n: number }>;
  return rows[0]!.n;
}

/** Today's store_closed sentence (v0.7.29's, word for word). */
const TODAY_CLOSED =
  'We are not taking online orders at the moment. Please order on WhatsApp or give us a call — we will take it right away.';

// ---------------------------------------------------------------------------
// A server page's element tree, as data: what React renders (a condition that
// is off renders nothing, so it is not part of it). The golden copy
// __fixtures__/home-page-v0.7.29.json was taken this way from v0.7.29's code.
// ---------------------------------------------------------------------------

function typeName(t: unknown): string {
  if (typeof t === 'string') return t;
  if (typeof t === 'function') return (t as { displayName?: string; name?: string }).displayName ?? (t as { name: string }).name ?? 'anonymous';
  if (t && typeof t === 'object') {
    const o = t as { displayName?: string; render?: { name?: string; displayName?: string }; $$typeof?: symbol };
    return o.displayName ?? o.render?.displayName ?? o.render?.name ?? String(o.$$typeof);
  }
  return String(t);
}
function tree(node: unknown): unknown {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node;
  if (typeof node === 'function') return `fn:${(node as { name?: string }).name ?? ''}`;
  if (Array.isArray(node)) return node.map(tree);
  if (typeof node === 'object') {
    const el = node as { $$typeof?: unknown; type?: unknown; key?: unknown; props?: Record<string, unknown> };
    if (el.$$typeof) {
      const props: Record<string, unknown> = { ...(el.props ?? {}) };
      const gone = (c: unknown) => c === null || c === undefined || typeof c === 'boolean';
      if (Array.isArray(props['children'])) props['children'] = (props['children'] as unknown[]).filter((c) => !gone(c));
      else if ('children' in props && gone(props['children'])) delete props['children'];
      return { type: typeName(el.type), key: el.key ?? null, props: tree(props) };
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as object).sort()) out[k] = tree((node as Record<string, unknown>)[k]);
    return out;
  }
  return String(node);
}
async function homeTree(): Promise<unknown> {
  return tree(await homePage.default());
}

/** The props of the first element in `node` whose props carry `key` (a server page's element tree). */
function propsWith(node: unknown, key: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = propsWith(n, key);
      if (found) return found;
    }
    return null;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return null;
  if (key in props) return props;
  return propsWith(props['children'], key);
}
async function menuPageProps(): Promise<{ closedNotice: string | null; facts: typeof DEFAULT_FACTS; jsonLd: unknown }> {
  const page = await menuPage.default();
  const app = propsWith(page, 'deliveryFacts')!;
  return {
    closedNotice: (app['closedNotice'] as string | null | undefined) ?? null,
    facts: app['deliveryFacts'] as typeof DEFAULT_FACTS,
    jsonLd: propsWith(page, 'nodes')!['nodes'],
  };
}

/** The closed notice the /menu page's status poll gets (api/store-status), as the browser reads it. */
async function polledNotice(): Promise<string | null | undefined> {
  const res = await storeStatus.GET();
  const json = (await res.json()) as { ok: boolean; data: { acceptingOrders: boolean; closedNotice?: string | null } };
  expect(json.ok).toBe(true);
  return json.data.closedNotice;
}

/** How many times `text` appears in `value` (serialized). */
function occurrences(value: unknown, text: string): number {
  return JSON.stringify(value).split(text).length - 1;
}

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = 'postgres://test.invalid/db';
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  revalidated.length = 0;
  await db.pg.query('DELETE FROM site_menu', []);
  await heartbeat(true, ['pickup']);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('nothing new stored: the website exactly as v0.7.29', () => {
  it('the home page is v0.7.29’s element for element — no database, no block, a v0.7.29 till’s block, a block at the defaults, an announcement switched off', async () => {
    const url = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      expect(await homeTree()).toEqual(homeV0729);
    } finally {
      process.env['DATABASE_URL'] = url;
    }
    expect(await homeTree()).toEqual(homeV0729);
    const m = menu();
    expect((await publish(m, tillBlock(m))).json.data).toMatchObject({ settings: 'stored' });
    expect(await homeTree()).toEqual(homeV0729);
    expect((await publish(m, tillBlock(m, { rev: 2, website: {} }))).json.data).toMatchObject({ settings: 'stored' });
    expect(await homeTree()).toEqual(homeV0729);
    await publish(m, tillBlock(m, { rev: 3, website: { announcement: { on: false, text: 'Made-up words, switched off' } } }));
    expect(await homeTree()).toEqual(homeV0729);
  });

  it('/menu: no closed notice, no announcement, no minimum; the public menu’s block and the JSON-LD as before', async () => {
    const m = menu();
    for (const block of [undefined, tillBlock(m), tillBlock(m, { rev: 2, website: {} })]) {
      await publish(m, block);
      const p = await menuPageProps();
      expect(p.closedNotice).toBeNull();
      expect(await polledNotice()).toBeNull();
      expect([p.facts.announcement, p.facts.minDeliveryOrderCents]).toEqual([null, 0]);
      const app = propsWith(await menuPage.default(), 'deliveryFacts')!;
      const settings = (app['menu'] as { settings?: Record<string, unknown> }).settings;
      if (settings) expect(Object.keys(settings).sort()).toEqual(['pickup', 'v', 'zones']);
      expect(JSON.stringify(p.jsonLd)).not.toMatch(/closedNotice|announcement|minDelivery/);
    }
  });

  it('a closed shop answers today’s sentence — no block, a v0.7.29 till’s block, a block at the defaults', async () => {
    await heartbeat(false);
    const m = menu();
    await publish(m);
    let r = await place({});
    expect([r.status, r.json.error, r.json.message]).toEqual([409, 'store_closed', TODAY_CLOSED]);
    await publish(m, tillBlock(m));
    r = await place({});
    expect([r.status, r.json.message]).toEqual([409, TODAY_CLOSED]);
    await publish(m, tillBlock(m, { rev: 2, website: {} }));
    r = await place({});
    expect([r.status, r.json.message]).toEqual([409, TODAY_CLOSED]);
    // The checkout's own fallback, for a reply with no words (as before).
    expect(problemFromServer({ error: 'store_closed' }).message).toBe(
      'We are not taking online orders at the moment. Please order on WhatsApp.',
    );
  });

  it('any delivery goes through with no minimum stored — a Rs 1 order, with a v0.7.29 till’s block and with a block at the defaults', async () => {
    const m = menu();
    for (const block of [undefined, tillBlock(m), tillBlock(m, { rev: 2, website: {} })]) {
      await publish(m, block);
      const r = await place({ items: [{ posItemId: 'food-1', quantity: 1, modifierIds: [] }] });
      expect(r.status).toBe(200);
      expect(r.json.data?.subtotalCents).toBe(100 + 20_000);
    }
  });
});

describe('the closed notice: the owner’s words through its last Karachi day, today’s after', () => {
  const NOTICE = 'Closed for a made-up holiday — back on Tuesday';
  const LAST_DAY = '2026-10-05';
  // Karachi is UTC+5 all year: the 5th starts at 19:00 UTC on the 4th and ends at 19:00 UTC on the 5th.
  const MOMENTS: Array<[string, boolean]> = [
    ['2026-10-04T18:59:59.999Z', true], // the 4th, 23:59 in Karachi
    ['2026-10-04T19:00:00.000Z', true], // the 5th begins in Karachi
    ['2026-10-05T12:00:00.000Z', true],
    ['2026-10-05T18:59:59.999Z', true], // the 5th, 23:59:59.999 in Karachi: its last moment
    ['2026-10-05T19:00:00.000Z', false], // the 6th, 00:00 in Karachi: gone
    ['2026-10-06T10:00:00.000Z', false],
  ];

  // The server's own clock zone must not matter: Vercel runs in UTC, a laptop anywhere.
  for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Karachi']) {
    it(`order route and /menu agree, to the millisecond (TZ=${tz})`, async () => {
      const tzBefore = process.env['TZ'];
      process.env['TZ'] = tz;
      try {
        await heartbeat(false);
        const m = menu();
        await publish(m, tillBlock(m, { website: { closedNotice: { text: NOTICE, until: LAST_DAY } } }));
        vi.useFakeTimers({ toFake: ['Date'] });
        for (const [at, shows] of MOMENTS) {
          vi.setSystemTime(new Date(at));
          const r = await place({});
          expect([r.status, r.json.error, r.json.message], at).toEqual([409, 'store_closed', shows ? NOTICE : TODAY_CLOSED]);
          expect((await menuPageProps()).closedNotice, at).toBe(shows ? NOTICE : null);
          // …and the status a /menu page left open polls: it drops the notice at the same moment.
          expect(await polledNotice(), at).toBe(shows ? NOTICE : null);
        }
      } finally {
        vi.useRealTimers();
        if (tzBefore === undefined) delete process.env['TZ'];
        else process.env['TZ'] = tzBefore;
      }
    });
  }

  it('a /menu page left open: its status poll brings a notice saved since, and takes it away once cleared', async () => {
    await heartbeat(false);
    const m = menu();
    await publish(m, tillBlock(m));
    expect((await menuPageProps()).closedNotice).toBeNull();
    expect(await polledNotice()).toBeNull();
    await publish(m, tillBlock(m, { rev: 2, website: { closedNotice: { text: NOTICE, until: null } } }));
    expect(await polledNotice()).toBe(NOTICE);
    await publish(m, tillBlock(m, { rev: 3, website: { closedNotice: { text: '', until: null } } }));
    expect(await polledNotice()).toBeNull();
    // No database (a local preview): no word, so the page keeps what it was served — never a forced "none".
    await publish(m, tillBlock(m, { rev: 4, website: { closedNotice: { text: NOTICE, until: null } } }));
    const url = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      expect(await polledNotice()).toBeUndefined();
    } finally {
      process.env['DATABASE_URL'] = url;
    }
  });

  it('with no last day it shows every time the website is closed; with no words, today’s', async () => {
    await heartbeat(false);
    const m = menu();
    await publish(m, tillBlock(m, { website: { closedNotice: { text: NOTICE, until: null } } }));
    expect((await place({})).json.message).toBe(NOTICE);
    expect((await menuPageProps()).closedNotice).toBe(NOTICE);
    await publish(m, tillBlock(m, { rev: 2, website: { closedNotice: { text: '', until: '2099-12-31' } } }));
    expect((await place({})).json.message).toBe(TODAY_CLOSED);
    expect((await menuPageProps()).closedNotice).toBeNull();
  });

  it('a past last day is stored like any other (the website just stops showing it) and blocks nothing else in the block', async () => {
    await heartbeat(false);
    const m = menu();
    const r = await publish(m, tillBlock(m, { website: { closedNotice: { text: NOTICE, until: '2020-01-01' }, minDeliveryOrderCents: 100_000 } }));
    expect(r.json.data).toMatchObject({ settings: 'stored' });
    expect((await place({})).json.message).toBe(TODAY_CLOSED);
    expect((await getSiteFacts()).minDeliveryOrderCents).toBe(100_000);
  });

  it('an open shop takes the order: the notice is only for when the website is closed', async () => {
    const m = menu();
    await publish(m, tillBlock(m, { website: { closedNotice: { text: NOTICE, until: null } } }));
    const r = await place({});
    expect(r.status).toBe(200);
  });

  it('the /menu page hands the browser the resolved words only: never the last day, never in the page’s facts', async () => {
    await heartbeat(false);
    const m = menu();
    await publish(m, tillBlock(m, { website: { closedNotice: { text: NOTICE, until: '2099-12-31' } } }));
    const p = await menuPageProps();
    expect(p.closedNotice).toBe(NOTICE);
    expect(JSON.stringify(p.facts)).not.toMatch(/2099-12-31|closedNotice|made-up holiday/);
    expect(JSON.stringify(p.jsonLd)).not.toContain(NOTICE);
  });
});

describe('the announcement: page text on the home page and /menu while on', () => {
  const WORDS = 'Made-up news: a new test pizza this week';

  it('on: the hero and the ticker say it (first), nowhere else; /menu gets it; the JSON-LD never', async () => {
    const m = menu();
    await publish(m, tillBlock(m, { website: { announcement: { on: true, text: WORDS } } }));
    const home = await homeTree();
    expect(occurrences(home, WORDS)).toBe(2);
    const marquee = propsWith(await homePage.default(), 'items')!['items'] as string[];
    expect(marquee).toEqual([WORDS, ...(propsWith(homeV0729, 'items')!['items'] as string[])]);
    const p = await menuPageProps();
    expect(p.facts.announcement).toBe(WORDS);
    expect(JSON.stringify(p.jsonLd)).not.toContain(WORDS);
    // Off again (the till always sends it): the home page is v0.7.29's.
    await publish(m, tillBlock(m, { rev: 2, website: { announcement: { on: false, text: WORDS } } }));
    expect(await homeTree()).toEqual(homeV0729);
    expect((await menuPageProps()).facts.announcement).toBeNull();
  });

  it('a Save of the messages alone (PUT /api/bridge/settings) stores them with the menu held and refreshes the pages', async () => {
    const m = menu();
    await publish(m, tillBlock(m));
    revalidated.length = 0;
    const r = await save(tillBlock(m, { rev: 2, website: { announcement: { on: true, text: WORDS } } }));
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ settings: 'stored', categories: 2, items: 8 });
    expect(revalidated).toEqual(['/ layout']);
    expect((await getSiteFacts()).announcement).toBe(WORDS);
    expect(occurrences(await homeTree(), WORDS)).toBe(2);
  });
});

describe('the smallest website delivery order', () => {
  const MIN = 100_000; // Rs 1,000 (made up)
  const refusal = (short: string, pickup: boolean) =>
    `Website delivery orders start at Rs 1,000 of food, before tax and the delivery charge. Add ${short} more${
      pickup ? ', or choose pick-up (no minimum)' : ' to order delivery'
    }.`;
  async function withMinimum() {
    const m = menu();
    await publish(m, tillBlock(m, { website: { minDeliveryOrderCents: MIN } }));
  }

  it('a delivery Rs 1 under it is refused on the server, after pricing — nothing stored; exactly the minimum passes', async () => {
    await withMinimum();
    const before = await orderCount();
    const r = await place({ items: [{ posItemId: 'food-999', quantity: 1, modifierIds: [] }] });
    expect([r.status, r.json.ok, r.json.error, r.json.message]).toEqual([409, false, 'below_minimum', refusal('Rs 1', true)]);
    expect(await orderCount()).toBe(before);
    const ok = await place({ items: [{ posItemId: 'food-1000', quantity: 1, modifierIds: [] }] });
    expect(ok.status).toBe(200);
    // The food, then today's Rs 200 charge for Phase 6: the minimum never adds anything to the bill.
    expect(ok.json.data?.subtotalCents).toBe(100_000 + 20_000);
  });

  it('a pick-up is never refused, however small', async () => {
    await withMinimum();
    const r = await place({ fulfilment: 'pickup', addressLine: undefined, zoneId: undefined, items: [{ posItemId: 'food-1', quantity: 1, modifierIds: [] }] });
    expect(r.status).toBe(200);
  });

  it('the food counts each line’s choices and quantity; the delivery charge does not', async () => {
    await withMinimum();
    // Rs 900 + a Rs 100 choice = Rs 1,000.
    expect((await place({ items: [{ posItemId: 'food-900', quantity: 1, modifierIds: ['m-cheese'] }] })).status).toBe(200);
    // Two Rs 500 = Rs 1,000.
    expect((await place({ items: [{ posItemId: 'food-500', quantity: 2, modifierIds: [] }] })).status).toBe(200);
    // Rs 800 of food in a Rs 200 area is Rs 1,000 with the charge: still Rs 200 short.
    const r = await place({ items: [{ posItemId: 'food-800', quantity: 1, modifierIds: [] }] });
    expect([r.status, r.json.message]).toEqual([409, refusal('Rs 200', true)]);
  });

  it('with pick-up not on offer, the sentence does not suggest it', async () => {
    await heartbeat(true);
    await withMinimum();
    const r = await place({ items: [{ posItemId: 'food-999', quantity: 1, modifierIds: [] }] });
    expect(r.json.message).toBe(refusal('Rs 1', false));
  });

  it('the checkout says the same before sending, on the cart; a pick-up passes; the server’s refusal points at the cart', () => {
    const input: CheckoutInput = {
      fulfilment: 'delivery',
      hasZone: true,
      name: 'Test',
      phone: '0300 1234567',
      address: 'House 1, Street 1',
      cartSize: 1,
      pickupOnlyInCart: [],
      canPickup: true,
      minDeliveryOrderCents: MIN,
      foodSubtotalCents: 99_900,
    };
    expect(validateCheckout(input)).toEqual({ field: 'cart', message: refusal('Rs 1', true) });
    expect(validateCheckout({ ...input, canPickup: false })?.message).toBe(refusal('Rs 1', false));
    expect(validateCheckout({ ...input, foodSubtotalCents: 100_000 })).toBeNull();
    expect(validateCheckout({ ...input, fulfilment: 'pickup', address: '' })).toBeNull();
    // Without the new fields (a page from before): no minimum, as before.
    const { minDeliveryOrderCents: _m, foodSubtotalCents: _f, ...old } = input;
    expect(validateCheckout(old)).toBeNull();
    expect(problemFromServer({ error: 'below_minimum', message: refusal('Rs 1', true) })).toEqual({ field: 'cart', message: refusal('Rs 1', true) });
  });

  it('the FAQ: no minimum reads as v0.7.26; a minimum set is named, and "No minimum" is said nowhere', () => {
    const faq = (facts: typeof DEFAULT_FACTS) =>
      renderArea(getArea('dha-phase-7')!, facts).faqs.find((f) => f.q === 'Is there a minimum order for Phase 7?')?.a;
    const goldenFaq = golden.areas.find((a) => a.slug === 'dha-phase-7')!.faqs.find((f) => f.q === 'Is there a minimum order for Phase 7?')!.a;
    const base = tillBlock(menu());
    expect(faq(DEFAULT_FACTS)).toBe(goldenFaq);
    expect(faq(factsFromBlock(base))).toBe(goldenFaq);
    expect(faq(factsFromBlock({ ...base, minDeliveryOrderCents: 0 }))).toBe(goldenFaq);
    const withMin = factsFromBlock({ ...base, minDeliveryOrderCents: MIN });
    expect(faq(withMin)).toBe(
      'For delivery, yes: Rs 1,000 of food, before tax and the delivery fee — pick-up has no minimum. You pay cash on delivery: the menu total plus 15% tax and the Rs 200 delivery fee.',
    );
    const every = JSON.stringify(DELIVERY_AREAS.map((a) => renderArea(a, withMin)));
    expect(every).not.toMatch(/no minimum on the website/i);
    // Both Phase 7 areas switched off: the answer would name a fee of no area on, so it is left out
    // (as before) — with a minimum or without, never an error and never a zero amount.
    const off7 = factsFromBlock({
      ...base,
      zones: base.zones.map((z) => (z.id === 'dha-7' || z.id === 'dha-7-ext' ? { ...z, active: false } : z)),
    });
    expect(faq(off7)).toBeUndefined();
    expect(faq({ ...off7, minDeliveryOrderCents: MIN })).toBeUndefined();
  });
});

describe('a v0.7.29 till’s block keeps what the website stored; a v0.7.30 block at the defaults clears it', () => {
  const MESSAGES = {
    closedNotice: { text: 'Made-up closed words', until: '2099-01-31' },
    announcement: { on: true, text: 'Made-up announcement' },
    minDeliveryOrderCents: 150_000,
  };

  it('PUT /api/bridge/menu: field by field, only the message fields', async () => {
    const m = menu();
    await publish(m, tillBlock(m, { rev: 1, website: MESSAGES }));
    expect(await storedSettings()).toMatchObject(MESSAGES);
    // A v0.7.29 till's newer block: its areas win, the messages it does not carry stay.
    const old = tillBlock(m, { rev: 2, device: 'till-2' });
    expect(old).not.toHaveProperty('closedNotice');
    expect((await publish(m, old)).json.data).toMatchObject({ settings: 'stored', settingsRev: 2, settingsDeviceId: 'till-2' });
    expect(await storedSettings()).toEqual({ ...old, ...MESSAGES });
    const facts = await getSiteFacts();
    expect([facts.announcement, facts.minDeliveryOrderCents]).toEqual(['Made-up announcement', 150_000]);
    // A menu publish with no block at all keeps everything (as before).
    expect((await publish(m)).json.data).toMatchObject({ settings: 'kept' });
    expect(await storedSettings()).toEqual({ ...old, ...MESSAGES });
    // A v0.7.30 till sends them at their defaults: cleared.
    const cleared = tillBlock(m, { rev: 3, website: {} });
    await publish(m, cleared);
    expect(await storedSettings()).toEqual(cleared);
    expect((await getSiteFacts()).announcement).toBeNull();
    expect((await getSiteFacts()).minDeliveryOrderCents).toBe(0);
  });

  it('both routes tell the till this website keeps the messages and "Pick-up only" (websiteMessages: true) — an older one does not say it', async () => {
    const m = menu();
    expect((await publish(m)).json.data).toMatchObject({ websiteMessages: true });
    expect((await publish(m, tillBlock(m, { rev: 1, website: MESSAGES }))).json.data).toMatchObject({ websiteMessages: true });
    expect((await save(tillBlock(m, { rev: 2, website: MESSAGES }))).json.data).toMatchObject({ websiteMessages: true });
  });

  it('PUT /api/bridge/settings (a Save): the same', async () => {
    const m = menu();
    await publish(m);
    expect((await save(tillBlock(m, { rev: 1, website: MESSAGES }))).json.data).toMatchObject({ settings: 'stored' });
    const old = tillBlock(m, { rev: 2, device: 'till-2' });
    expect((await save(old)).json.data).toMatchObject({ settings: 'stored', settingsRev: 2 });
    expect(await storedSettings()).toEqual({ ...old, ...MESSAGES });
    const cleared = tillBlock(m, { rev: 3, website: {} });
    await save(cleared);
    expect(await storedSettings()).toEqual(cleared);
  });

  it('one field sent, the others kept (field by field)', async () => {
    const m = menu();
    await publish(m, tillBlock(m, { rev: 1, website: MESSAGES }));
    const onlyMinimum = { ...tillBlock(m, { rev: 2 }), minDeliveryOrderCents: 0 };
    await publish(m, onlyMinimum);
    expect(await storedSettings()).toEqual({ ...onlyMinimum, closedNotice: MESSAGES.closedNotice, announcement: MESSAGES.announcement });
    const onlyAnnouncement = { ...tillBlock(m, { rev: 3 }), announcement: { on: false, text: '' } };
    await save(onlyAnnouncement);
    expect(await storedSettings()).toEqual({ ...onlyAnnouncement, closedNotice: MESSAGES.closedNotice, minDeliveryOrderCents: 0 });
  });

  it('an older block is ignored as before, messages and all', async () => {
    const m = menu();
    await publish(m, tillBlock(m, { rev: 5, website: MESSAGES }));
    const r = await publish(m, tillBlock(m, { rev: 1, device: 'till-2', website: {} }));
    expect(r.json.data).toMatchObject({ settings: 'ignored_older' });
    expect(await storedSettings()).toMatchObject(MESSAGES);
  });

  it('the fields kept are exactly the block’s optional ones, the same in the publish’s statement and in a Save', () => {
    const shape = (publishedSettingsSchema as unknown as { innerType(): { shape: Record<string, { isOptional(): boolean }> } }).innerType()
      .shape;
    const optional = Object.keys(shape)
      .filter((k) => shape[k]!.isOptional())
      .sort();
    expect([...KEPT_MESSAGE_FIELDS].sort()).toEqual(optional);
    const src = readFileSync(new URL('./publish-settings.ts', import.meta.url), 'utf8');
    const inStatement = /kept\.key IN \(([^)]*)\)/
      .exec(src)![1]!
      .split(',')
      .map((k) => k.trim().replace(/'/g, ''))
      .sort();
    expect(inStatement).toEqual([...KEPT_MESSAGE_FIELDS].sort());
  });

  it('nothing but the three message fields is kept from a stored block (a key an older or newer website left there goes)', async () => {
    const m = menu();
    const stored = { ...tillBlock(m, { rev: 1, website: MESSAGES }), someOtherField: 'left by another website' };
    for (const next of [
      (b: PublishedSettings) => publish(m, b),
      (b: PublishedSettings) => save(b),
    ]) {
      await db.pg.query(
        `INSERT INTO site_menu (id, menu_json, published_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET menu_json = EXCLUDED.menu_json`,
        [JSON.stringify({ ...m, settings: stored })],
      );
      const old = tillBlock(m, { rev: 2 });
      expect((await next(old)).json.data).toMatchObject({ settings: 'stored' });
      expect(await storedSettings()).toEqual({ ...old, ...MESSAGES });
    }
  });

  it('a stored block that does not read, or a stored message that does not (hand-edited rows): a publish and a Save keep the same message fields, as the row holds them', async () => {
    const m = menu();
    const EDITS: Array<[string, string]> = [
      // Two areas with one id: the whole block does not read (the pages use the built-in areas).
      ['the block', `UPDATE site_menu SET menu_json = jsonb_set(menu_json, '{settings,zones,1,id}', menu_json #> '{settings,zones,0,id}') WHERE id = 1`],
      // A notice too long: the block reads, that message reads as absent.
      ['a message', `UPDATE site_menu SET menu_json = jsonb_set(menu_json, '{settings,closedNotice,text}', to_jsonb(repeat('x', 500))) WHERE id = 1`],
    ];
    const messagesOf = (block: Record<string, unknown>) =>
      Object.fromEntries(KEPT_MESSAGE_FIELDS.filter((k) => k in block).map((k) => [k, block[k]]));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [what, edit] of EDITS) {
        const after: Record<string, unknown> = {};
        for (const route of ['publish', 'save'] as const) {
          await db.pg.query('DELETE FROM site_menu', []);
          await publish(m, tillBlock(m, { rev: 1, website: MESSAGES }));
          await db.pg.query(edit, []);
          const held = (await storedSettings())!;
          expect(parseStoredSettings(held) === null, what).toBe(what === 'the block');
          const old = tillBlock(m, { rev: 2, device: 'till-2' }); // a v0.7.29 till: no message fields
          const r = route === 'publish' ? await publish(m, old) : await save(old);
          expect(r.json.data, `${what}, ${route}`).toMatchObject({ settings: 'stored' });
          after[route] = await storedSettings();
          expect(after[route], `${what}, ${route}`).toEqual({ ...old, ...messagesOf(held) });
        }
        expect(after['save'], what).toEqual(after['publish']);
      }
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('the bounds', () => {
  const at = (over: Record<string, unknown>) => ({ ...tillBlock(menu(), { website: {} }), ...over });
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['a closed notice of 161 letters', { closedNotice: { text: 'x'.repeat(161), until: null } }],
    ['a line break', { closedNotice: { text: 'Closed\ntoday', until: null } }],
    ['a tab', { closedNotice: { text: 'Closed\ttoday', until: null } }],
    ['a line separator', { closedNotice: { text: 'Closed today', until: null } }],
    ['a direction mark', { closedNotice: { text: 'Closed ‮today', until: null } }],
    ['a date that is not one', { closedNotice: { text: 'Closed', until: '2026-02-30' } }],
    ['a date with a time', { closedNotice: { text: 'Closed', until: '2026-10-05T00:00' } }],
    ['an announcement of 121 letters', { announcement: { on: true, text: 'x'.repeat(121) } }],
    ['a control character in the announcement', { announcement: { on: true, text: 'New\u0007' } }],
    ['a minimum over Rs 5,000', { minDeliveryOrderCents: 500_100 }],
    ['a minimum in part rupees', { minDeliveryOrderCents: 100_050 }],
    ['a negative minimum', { minDeliveryOrderCents: -100 }],
    // The Arabic letter mark and the invisible characters, anywhere in the words (the till's Save has the same rule).
    ...[0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0x2064, 0xfeff].flatMap((code): Array<[string, Record<string, unknown>]> => {
      const c = String.fromCharCode(code);
      const u = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
      return [
        [`${u} inside the closed notice`, { closedNotice: { text: `Closed${c}today`, until: null } }],
        [`${u} at the start of the announcement`, { announcement: { on: true, text: `${c}New wrap` } }],
        [`${u} at the end of the closed notice`, { closedNotice: { text: `Closed${c}`, until: null } }],
      ];
    }),
  ];

  for (const [what, over] of BAD) {
    it(`the bridge refuses ${what} — nothing stored`, async () => {
      const m = menu();
      await publish(m, tillBlock(m));
      const before = await storedSettings();
      const r = await publish(m, at(over) as unknown as PublishedSettings);
      expect([r.status, r.json.error]).toEqual([400, 'validation']);
      const s = await save(at(over) as unknown as PublishedSettings);
      expect([s.status, s.json.error]).toEqual([400, 'validation']);
      expect(await storedSettings()).toEqual(before);
    });
  }

  it('takes every message at its limits', async () => {
    const m = menu();
    const block = at({
      closedNotice: { text: 'x'.repeat(160), until: '2028-02-29' },
      announcement: { on: true, text: 'y'.repeat(120) },
      minDeliveryOrderCents: 500_000,
    }) as unknown as PublishedSettings;
    expect((await publish(m, block)).json.data).toMatchObject({ settings: 'stored' });
    expect(await storedSettings()).toEqual(block);
  });

  it('takes Urdu words (its letters are words; only the marks and invisible characters are refused)', async () => {
    const m = menu();
    const block = at({
      closedNotice: { text: 'عید کی چھٹی — پیر کو کھلے گا', until: null },
      announcement: { on: true, text: 'نیا ریپ اس ہفتے' },
    }) as unknown as PublishedSettings;
    expect((await publish(m, block)).json.data).toMatchObject({ settings: 'stored' });
    expect((await save(block)).json.data).toMatchObject({ settings: 'stored' });
    expect(await storedSettings()).toEqual(block);
  });

  it('a stored message that does not fit (a hand-edited row) reads as absent — the areas and fees still read', async () => {
    const m = menu();
    const block = tillBlock(m, { website: {} });
    const p8 = block.zones.find((z) => z.id === 'dha-8')!;
    const edited = {
      ...block,
      zones: block.zones.map((z) => (z.id === 'dha-8' ? { ...z, active: false } : z)),
      closedNotice: { text: 'x'.repeat(500), until: null },
      announcement: { on: 'yes', text: 7 },
      minDeliveryOrderCents: 12_345,
    };
    expect(p8.active).toBe(true);
    const read = parseStoredSettings(JSON.stringify(edited));
    expect(read).not.toBeNull();
    expect(read!.zones.find((z) => z.id === 'dha-8')?.active).toBe(false);
    expect([read!.closedNotice, read!.announcement, read!.minDeliveryOrderCents]).toEqual([undefined, undefined, undefined]);
    const facts = factsFromBlock(read);
    expect([facts.source, facts.announcement, facts.minDeliveryOrderCents]).toEqual(['settings', null, 0]);
  });
});
