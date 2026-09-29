/**
 * The shop block on the website (sweep B2 + B4: shared-types web-bridge.ts,
 * THE SHOP BLOCK) on a real Postgres (PGlite, in memory, with db/schema.sql),
 * end to end through the route handlers and the pages, with blocks the
 * till's own code builds (pos-domain buildShopBlock):
 *  - the store rule, in the publish's one statement next to the settings
 *    block's (and B1's kept messages): no block keeps the stored one, an
 *    older one is ignored unless it is the same till's later Save; a block
 *    out of its bounds is 400 shop_invalid, never 'validation';
 *  - the block alone (PUT /api/bridge/shop): the stored row's `shop` only;
 *  - what the website holds (GET /api/bridge/status), homeMissing;
 *  - the public never gets it (GET /api/menu, the /menu props);
 *  - the pages' one read (no photos), and every page following the owner's
 *    name, numbers, address, hours, payments, greeting, social links and
 *    allergy notice — the name's pun, "past midnight", "daily" and "cash
 *    only" stepping aside when they stop being true.
 * Every name, number, address, link and word of the owner's here is made up.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  type DeliveryZoneSetting,
  type PublishedMenu,
  type PublishedSettings,
  type PublishedShop,
  type ShopHours,
  type ShopProfile,
  type ShopWebsite,
  type WebsiteHome,
} from '@cheeseoclock/shared-types';
import { buildSettingsBlock } from '../../../../packages/pos-domain/src/delivery-charge';
import { buildShopBlock } from '../../../../packages/pos-domain/src/shop-block';
import { goldenMenu } from './__fixtures__/golden-menu';
import { renderServer } from './__fixtures__/render-pages';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  fail: null as Error | null,
}));
vi.mock('@/lib/db', () => ({
  sql: () => {
    if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is not configured');
    return async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (db.fail) throw db.fail;
      return (await db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values)).rows;
    };
  },
}));
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => {
    revalidated.push(`${path} ${type ?? ''}`.trim());
  },
}));
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
const drawn = vi.hoisted(() => ({ images: [] as string[] }));
vi.mock('next/og', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  class ImageResponse {
    constructor(element: unknown) {
      drawn.images.push(renderToStaticMarkup(element as never));
    }
  }
  return { ImageResponse };
});

const React = await import('react');
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = await import('react-dom/server');

const menuRoute = await import('@/app/api/bridge/menu/route');
const shopRoute = await import('@/app/api/bridge/shop/route');
const settingsRoute = await import('@/app/api/bridge/settings/route');
const bridgeStatus = await import('@/app/api/bridge/status/route');
const apiMenu = await import('@/app/api/menu/route');
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
const manifest = await import('@/app/manifest');
const ogRoot = await import('@/app/opengraph-image');
const ogArea = await import('@/app/delivery/[area]/opengraph-image');
const { CheckoutSheet } = await import('@/components/ordering/CheckoutSheet');
const { ShopFactsContext } = await import('@/components/ordering/ShopContext');
const { DEFAULT_FACTS, findFactZone } = await import('@/lib/delivery-facts');
const { DELIVERY_AREAS } = await import('@/lib/areas');
const { getCopyFacts, getMenuFacts, getShopFacts } = await import('@/lib/site-facts');
const { DEFAULT_SHOP_FACTS, shopFactsFromBlock } = await import('@/lib/shop-facts');
const { publicMenu } = await import('@/lib/public-menu');

const SECRET = 'test-bridge-secret-0123456789';
function bridge(path: string, init?: { method?: string; body?: unknown }) {
  return new Request(`https://site.test${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
type Answer = { status: number; json: { ok: boolean; error?: string; message?: string; data?: Record<string, unknown> } };
async function answer(res: Response): Promise<Answer> {
  return { status: res.status, json: (await res.json()) as Answer['json'] };
}

// ---------------------------------------------------------------------------
// The owner's details, made up
// ---------------------------------------------------------------------------

const OWNER_PROFILE: Omit<ShopProfile, 'v'> = {
  name: 'Test Kitchen',
  tagline: 'Made-up words under the name.',
  phone: { display: '0300 1112233', e164: '+923001112233' },
  whatsappLines: [
    { display: '0321 4445566', e164: '+923214445566' },
    { display: '0333 7778899', e164: '+923337778899' },
  ],
  address: { street: 'Plot 9, Test Street, Test Phase 1', areaLine: 'Test Phase 1, Karachi', postalCode: '75999' },
  socialLinks: ['https://www.instagram.com/test.kitchen.example', 'https://www.facebook.com/test.kitchen.example'],
  priceRange: 'PKR 100–900',
};
const OWNER_HOURS: Omit<ShopHours, 'v'> = { opens: '11:00', closes: '23:00', days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'] };
const OWNER_WEBSITE: Omit<ShopWebsite, 'v'> = {
  whatsappGreeting: 'Hello Test Kitchen & co, one order please: ',
  doorPayments: ['cash', 'card'],
  pickupPayments: ['cash', 'card', 'easypaisa'],
  allergyNotice: 'Made-up allergy words: tell us what to leave out, and we will do our best with it.',
};

/** The shop block a till sends, by the till's own code: today's details with `over` applied, stamped as saved `rev` times. */
function tillShop(
  opts: {
    rev?: number;
    at?: string;
    device?: string;
    profile?: Partial<Omit<ShopProfile, 'v'>>;
    hours?: Partial<Omit<ShopHours, 'v'>>;
    website?: Partial<Omit<ShopWebsite, 'v'>>;
    home?: WebsiteHome;
  } = {},
): PublishedShop {
  return buildShopBlock({
    profile: { ...DEFAULT_SHOP_PROFILE, ...opts.profile, v: 1 } as ShopProfile,
    hours: { ...DEFAULT_SHOP_HOURS, ...opts.hours, v: 1 } as ShopHours,
    website: { ...DEFAULT_SHOP_WEBSITE, ...opts.website, v: 1 } as ShopWebsite,
    home: opts.home ?? (DEFAULT_WEBSITE_HOME as WebsiteHome),
    stamps: [{ version: opts.rev ?? 1, updatedAt: opts.at ?? '2026-09-28T08:00:00.000Z' }, null, null, null],
    deviceId: opts.device ?? 'till-1',
  });
}
/** Every detail the owner's (made up). */
const ownerShop = (opts: { rev?: number; at?: string; device?: string } = {}) =>
  tillShop({ ...opts, profile: OWNER_PROFILE, hours: OWNER_HOURS, website: OWNER_WEBSITE });

/** A v0.7.30 till's settings block for the menu (today's areas; the messages at their defaults unless `website`). */
function settingsBlock(
  m: PublishedMenu,
  opts: { rev?: number; website?: false | { announcement?: { on: boolean; text: string } } } = {},
): PublishedSettings {
  const zones: DeliveryZoneSetting[] = DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] }));
  return buildSettingsBlock({
    zones,
    pickup: { offered: true, percent: 10 },
    stamps: [{ version: opts.rev ?? 1, updatedAt: '2026-09-28T07:00:00.000Z' }],
    menuItems: m.categories.flatMap((c) => c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents }))),
    deviceId: 'till-1',
    ...(opts.website === false
      ? {}
      : {
          website: {
            closedNotice: { text: '', until: null },
            announcement: opts.website?.announcement ?? { on: false, text: '' },
            minDeliveryOrderCents: 0,
          },
        }),
  });
}

async function publish(m: PublishedMenu, blocks: { settings?: PublishedSettings; shop?: unknown } = {}): Promise<Answer> {
  const body = { ...m, ...(blocks.settings ? { settings: blocks.settings } : {}), ...(blocks.shop !== undefined ? { shop: blocks.shop } : {}) };
  return answer(await menuRoute.PUT(bridge('/api/bridge/menu', { method: 'PUT', body })));
}
async function sendShop(body: unknown): Promise<Answer> {
  return answer(await shopRoute.PUT(bridge('/api/bridge/shop', { method: 'PUT', body })));
}
async function storedDoc(): Promise<PublishedMenu | null> {
  const rows = (await db.pg.query('SELECT menu_json FROM site_menu WHERE id = 1', [])).rows as Array<{ menu_json: PublishedMenu | string }>;
  const v = rows[0]?.menu_json;
  if (!v) return null;
  return typeof v === 'string' ? (JSON.parse(v) as PublishedMenu) : v;
}
async function statusData(): Promise<Record<string, unknown>> {
  const r = await answer(await bridgeStatus.GET(bridge('/api/bridge/status')));
  return r.json.data!;
}
async function heartbeat(accepting: boolean): Promise<void> {
  const r = await answer(
    await bridgeStatus.PUT(
      bridge('/api/bridge/status', { method: 'PUT', body: { acceptingOrders: accepting, deviceId: 'till-1', features: ['pickup'], pickupDiscountPercent: 10 } }),
    ),
  );
  expect(r.status).toBe(200);
}

// ---------------------------------------------------------------------------
// Pages as served
// ---------------------------------------------------------------------------

async function page(el: React.ReactElement): Promise<string> {
  return renderServer(React.createElement(layout.default, { children: el }));
}
/** Every page of the site (inside the root layout), route → HTML. */
async function allPages(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  out['/'] = await page(React.createElement(home.default));
  out['/delivery'] = await page(React.createElement(hub.default));
  for (const a of DELIVERY_AREAS) out[`/delivery/${a.slug}`] = await page(React.createElement(area.default, { params: { area: a.slug } }));
  out['/pizza'] = await page(React.createElement(pizza.default));
  out['/burger'] = await page(React.createElement(burger.default));
  out['/late-night'] = await page(React.createElement(lateNight.default));
  out['/menu'] = await page(React.createElement(menuPage.default));
  out['/_not-found'] = await page(React.createElement(notFound.default));
  out['/track'] = await page(React.createElement(track.default, { params: { id: 'test-order' } }));
  return out;
}
/** What a reader sees: tags out, the few entities React writes decoded. */
function visible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}
/** The JSON-LD graphs of a page. */
function jsonLd(html: string): Array<Record<string, unknown>> {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(
    (m) => (JSON.parse(m[1]!) as { '@graph': Array<Record<string, unknown>> })['@graph'],
  );
}
function restaurant(html: string): Record<string, unknown> {
  return jsonLd(html).find((n) => n['@type'] === 'Restaurant')!;
}
/** Every href of a page. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&').replace(/&#x27;/g, "'"));
}
/** What each page says in its metadata (the root layout's under "layout"). */
async function metadata(): Promise<Record<string, Record<string, unknown>>> {
  const meta = async (mod: { metadata?: unknown; generateMetadata?: (a: never) => unknown }, arg?: unknown) =>
    JSON.parse(JSON.stringify((mod.generateMetadata ? await mod.generateMetadata(arg as never) : mod.metadata) ?? null)) as Record<string, unknown>;
  return {
    layout: await meta(layout as never),
    hub: await meta(hub as never),
    area: await meta(area as never, { params: { area: 'dha-phase-6' } }),
    pizza: await meta(pizza as never),
    burger: await meta(burger as never),
    lateNight: await meta(lateNight as never),
    menu: await meta(menuPage as never),
  };
}

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = 'postgres://test.invalid/db';
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  revalidated.length = 0;
  db.fail = null;
  await db.pg.query('DELETE FROM site_menu', []);
  await heartbeat(true);
});

// ===========================================================================

describe('the store rule: the shop block in the publish’s one statement', () => {
  it('a Publish with the block stores it with the menu and says so — the held stamp, and the featured home items the menu lacks (none)', async () => {
    const m = goldenMenu();
    const shop = ownerShop({ rev: 2 });
    const r = await publish(m, { settings: settingsBlock(m), shop });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({
      settings: 'stored',
      shop: 'stored',
      shopRev: 2,
      shopAt: '2026-09-28T08:00:00.000Z',
      shopTie: Date.parse('2026-09-28T08:00:00.000Z'),
      shopDeviceId: 'till-1',
      homeMissing: [],
    });
    expect((await storedDoc())?.shop).toEqual(shop);
    expect(revalidated).toEqual(['/ layout']);
  });

  it('a publish WITHOUT the block (every till up to v0.7.30, and a Publish sent again without it) keeps the stored one', async () => {
    const m = goldenMenu();
    const shop = ownerShop();
    await publish(m, { shop });
    // A v0.7.30 till's body: no `shop` key.
    const r = await publish(m, { settings: settingsBlock(m) });
    expect(r.json.data).toMatchObject({ settings: 'stored', shop: 'kept', shopRev: 1, shopDeviceId: 'till-1' });
    expect((await storedDoc())?.shop).toEqual(shop);
    // A v0.7.29 till's body: neither block.
    expect((await publish(m)).json.data).toMatchObject({ settings: 'kept', shop: 'kept' });
    expect((await storedDoc())?.shop).toEqual(shop);
    // Nothing ever stored: 'none', and no `shop` in the row.
    await db.pg.query('DELETE FROM site_menu', []);
    const none = await publish(m);
    expect(none.json.data).toMatchObject({ shop: 'none', shopRev: null, shopAt: null, shopTie: null, shopDeviceId: null, homeMissing: [] });
    expect(await storedDoc()).not.toHaveProperty('shop');
  });

  it('an OLDER block is ignored (the stored one stays, the menu is stored) — unless it is the same till’s later Save', async () => {
    const m = goldenMenu();
    await publish(m, { shop: ownerShop({ rev: 3, at: '2026-09-28T09:00:00.000Z', device: 'till-2' }) });
    const older = await publish(
      { ...m, publishedAt: '2026-09-28T10:00:00.000Z' },
      { shop: tillShop({ rev: 2, at: '2026-09-28T08:30:00.000Z', device: 'till-1' }) },
    );
    expect(older.json.data).toMatchObject({ shop: 'ignored_older', shopRev: 3, shopDeviceId: 'till-2' });
    const doc = await storedDoc();
    expect(doc?.shop?.profile.name).toBe('Test Kitchen');
    expect(doc?.publishedAt).toBe('2026-09-28T10:00:00.000Z');
    // The same till (restored from an older backup) Saves later: its block takes, whatever its revision.
    const own = await publish(m, { shop: tillShop({ rev: 1, at: '2026-09-28T11:00:00.000Z', device: 'till-2' }) });
    expect(own.json.data).toMatchObject({ shop: 'stored', shopRev: 1, shopDeviceId: 'till-2' });
    expect((await storedDoc())?.shop?.profile.name).toBe("Cheese O'Clock");
    // An EQUAL stamp from the other till takes (newer or equal).
    const equal = await publish(m, { shop: tillShop({ rev: 1, at: '2026-09-28T11:00:00.000Z', device: 'till-1', profile: { name: 'Equal Stamp Kitchen' } }) });
    expect(equal.json.data).toMatchObject({ shop: 'stored', shopDeviceId: 'till-1' });
  });

  it('decided apart from the settings block: an older settings block with a newer shop block, and the other way round', async () => {
    const m = goldenMenu();
    await publish(m, { settings: settingsBlock(m, { rev: 5 }), shop: ownerShop({ rev: 5 }) });
    const a = await publish(m, { settings: settingsBlock(m, { rev: 2 }), shop: ownerShop({ rev: 6, at: '2026-09-28T12:00:00.000Z' }) });
    expect(a.json.data).toMatchObject({ settings: 'ignored_older', shop: 'stored', shopRev: 6 });
    const b = await publish(m, { settings: settingsBlock(m, { rev: 7 }), shop: ownerShop({ rev: 1, device: 'till-9' }) });
    expect(b.json.data).toMatchObject({ settings: 'stored', settingsRev: 7, shop: 'ignored_older', shopRev: 6 });
  });

  it('B1’s kept website messages still hold in the same statement: a v0.7.29 till’s settings block keeps the announcement, and the shop block with it', async () => {
    const m = goldenMenu();
    await publish(m, { settings: settingsBlock(m, { website: { announcement: { on: true, text: 'Made-up news' } } }), shop: ownerShop() });
    const r = await publish(m, { settings: settingsBlock(m, { rev: 2, website: false }) });
    expect(r.json.data).toMatchObject({ settings: 'stored', shop: 'kept' });
    const doc = await storedDoc();
    expect(doc?.settings?.announcement).toEqual({ on: true, text: 'Made-up news' });
    expect(doc?.settings?.settingsRev).toBe(2);
    expect(doc?.shop?.profile.name).toBe('Test Kitchen');
    expect((await getCopyFacts()).announcement).toBe('Made-up news');
  });

  it('a block out of its bounds is 400 shop_invalid with the owner’s reason — never "validation" — and NOTHING is stored, not the menu either', async () => {
    const m = goldenMenu();
    await publish(m, { shop: ownerShop() });
    const before = await storedDoc();
    const bad: Array<[string, unknown, RegExp]> = [
      ['a greeting with no space at its end', { ...ownerShop({ rev: 4 }), website: { ...OWNER_WEBSITE, whatsappGreeting: 'Hello' } }, /ends with one space/],
      ['payments without cash', { ...ownerShop({ rev: 4 }), website: { ...OWNER_WEBSITE, doorPayments: ['card'] } }, /cash/],
      ['a social link to the shop’s own site', { ...ownerShop({ rev: 4 }), profile: { ...OWNER_PROFILE, socialLinks: ['https://www.cheeseoclock.net/x'] } }, /own website/],
      ['hours closing after 5 am', { ...ownerShop({ rev: 4 }), hours: { ...OWNER_HOURS, opens: '12:00', closes: '06:00' } }, /before 5 am/],
      ['a phone that is not its number', { ...ownerShop({ rev: 4 }), profile: { ...OWNER_PROFILE, phone: { display: '0300 1112233', e164: '+923009999999' } } }, /phone/],
      ['no block at all, just words', 'not a block', /./],
      ['a stamp far ahead of this clock', ownerShop({ rev: 4, at: '2099-01-01T00:00:00.000Z' }), /clock is ahead/],
    ];
    for (const [what, shop, reason] of bad) {
      const r = await publish({ ...m, publishedAt: '2026-09-30T00:00:00.000Z' }, { shop });
      expect([r.status, r.json.error], what).toEqual([400, 'shop_invalid']);
      expect(r.json.message, what).toMatch(reason);
      expect(await storedDoc(), what).toEqual(before);
    }
    // The till then sends the menu again without it: stored, the block kept.
    const again = await publish({ ...m, publishedAt: '2026-09-30T00:00:00.000Z' });
    expect(again.json.data).toMatchObject({ shop: 'kept' });
  });

  it('a newer till’s extra field inside the block is dropped, never refused', async () => {
    const m = goldenMenu();
    const shop = ownerShop();
    const r = await publish(m, { shop: { ...shop, profile: { ...shop.profile, fromTheFuture: 'x' }, extraTopLevel: 1 } });
    expect(r.json.data).toMatchObject({ shop: 'stored' });
    const stored = (await storedDoc())?.shop as unknown as Record<string, Record<string, unknown>>;
    expect(stored['profile']).not.toHaveProperty('fromTheFuture');
    expect(stored).not.toHaveProperty('extraTopLevel');
  });

  it('the home page’s featured items the menu lacks, in the lineup’s order (the owner’s, else today’s)', async () => {
    const m = goldenMenu();
    // Two of today's are not on this menu (a rename, an item off the website).
    m.categories[0]!.items = m.categories[0]!.items.filter((i) => i.name !== 'Cheetos — Large');
    m.categories[4]!.items = m.categories[4]!.items.filter((i) => i.name !== 'Family Feast');
    expect((await publish(m)).json.data).toMatchObject({ homeMissing: ['Cheetos — Large', 'Family Feast'] });
    const home: WebsiteHome = {
      v: 1,
      pizzas: [{ itemRef: { posItemId: 'gi-sig-0', name: 'Renamed on the till' } }, { itemRef: { posItemId: null, name: 'Not On The Menu — Large' } }],
      burger: null,
      deals: [],
    };
    const r = await publish(m, { shop: tillShop({ home }) });
    expect(r.json.data).toMatchObject({ shop: 'stored', homeMissing: ['Not On The Menu — Large'] });
    expect((await statusData())['homeMissing']).toEqual(['Not On The Menu — Large']);
  });
});

describe('the block alone: PUT /api/bridge/shop', () => {
  it('no menu yet: 409 menu_not_published (the till says "press Publish"), nothing stored', async () => {
    const r = await sendShop({ shop: ownerShop() });
    expect([r.status, r.json.error]).toEqual([409, 'menu_not_published']);
    expect(await storedDoc()).toBeNull();
  });

  it('puts the block on the row and changes NOTHING else of it — the menu and the settings block byte for byte — and refreshes every page', async () => {
    const m = goldenMenu();
    await publish(m, { settings: settingsBlock(m, { website: { announcement: { on: true, text: 'Made-up news' } } }) });
    const before = await storedDoc();
    revalidated.length = 0;
    const shop = ownerShop({ rev: 2 });
    const r = await sendShop({ shop });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({
      shop: 'stored',
      shopRev: 2,
      shopAt: '2026-09-28T08:00:00.000Z',
      shopTie: Date.parse('2026-09-28T08:00:00.000Z'),
      shopDeviceId: 'till-1',
      homeMissing: [],
    });
    const after = await storedDoc();
    const { shop: stored, ...rest } = after!;
    expect(stored).toEqual(shop);
    expect(rest).toEqual(before);
    expect(revalidated).toEqual(['/ layout']);
  });

  it('an older block writes nothing (ignored_older, no refresh); the same till’s later Save replaces its own', async () => {
    const m = goldenMenu();
    await publish(m, { shop: ownerShop({ rev: 3, device: 'till-2' }) });
    revalidated.length = 0;
    const older = await sendShop({ shop: tillShop({ rev: 2, device: 'till-1', at: '2026-09-28T10:00:00.000Z' }) });
    expect(older.json.data).toMatchObject({ shop: 'ignored_older', shopRev: 3, shopDeviceId: 'till-2' });
    expect((await storedDoc())?.shop?.profile.name).toBe('Test Kitchen');
    expect(revalidated).toEqual([]);
    const own = await sendShop({ shop: tillShop({ rev: 1, device: 'till-2', at: '2026-09-28T10:00:00.000Z' }) });
    expect(own.json.data).toMatchObject({ shop: 'stored', shopRev: 1 });
  });

  it('refuses a block out of its bounds (400 shop_invalid, the reason) and a body that is not { shop } (400 validation)', async () => {
    const m = goldenMenu();
    await publish(m);
    const bad = await sendShop({ shop: { ...ownerShop(), website: { ...OWNER_WEBSITE, allergyNotice: 'Too short.' } } });
    expect([bad.status, bad.json.error]).toEqual([400, 'shop_invalid']);
    expect(bad.json.message).toMatch(/allergy notice/i);
    expect((await storedDoc())).not.toHaveProperty('shop');
    const none = await sendShop({ notShop: 1 });
    expect([none.status, none.json.error]).toEqual([400, 'validation']);
  });

  it('the settings block alone (PUT /api/bridge/settings) keeps the stored shop block', async () => {
    const m = goldenMenu();
    await publish(m, { settings: settingsBlock(m), shop: ownerShop() });
    const r = await answer(await settingsRoute.PUT(bridge('/api/bridge/settings', { method: 'PUT', body: { settings: settingsBlock(m, { rev: 2 }), feeItems: [] } })));
    expect(r.json.data).toMatchObject({ settings: 'stored' });
    expect((await storedDoc())?.shop?.profile.name).toBe('Test Kitchen');
  });
});

describe('what the website holds: GET /api/bridge/status', () => {
  it('the shop block’s stamp and the till that sent it (null when none), and the featured items the menu lacks', async () => {
    const m = goldenMenu();
    await publish(m);
    expect(await statusData()).toMatchObject({ settings: null, shop: null, homeMissing: [] });
    await sendShop({ shop: ownerShop({ rev: 4 }) });
    expect((await statusData())['shop']).toEqual({
      shopRev: 4,
      shopAt: '2026-09-28T08:00:00.000Z',
      shopTie: Date.parse('2026-09-28T08:00:00.000Z'),
      shopDeviceId: 'till-1',
    });
  });

  it('no menu: nothing held; unreadable: no `shop` key at all (the till keeps what it knew)', async () => {
    expect(await statusData()).toMatchObject({ settings: null, shop: null, homeMissing: [] });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await publish(goldenMenu(), { shop: ownerShop() });
      await db.pg.query(`UPDATE site_menu SET menu_json = '"not an object"'::jsonb`, []);
      const data = await statusData();
      expect(data).not.toHaveProperty('shop');
      expect(data).not.toHaveProperty('settings');
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('the public never gets the block: its stamps and device id are the bridge’s', () => {
  it('GET /api/menu and the /menu page’s props carry no `shop` and no stamp; the page gets the details as ShopFacts', async () => {
    await publish(goldenMenu(), { shop: ownerShop({ rev: 7, device: 'till-secret-device' }) });
    const api = (await (await apiMenu.GET()).json()) as { data: Record<string, unknown> };
    expect(api.data).not.toHaveProperty('shop');
    const sent = JSON.stringify(api.data);
    const pageEl = await menuPage.default();
    const app = propsWith(pageEl, 'deliveryFacts')!;
    const all = sent + JSON.stringify(app);
    for (const secret of ['shopRev', 'shopAt', 'shopTie', 'deviceId', 'till-secret-device']) expect(all, secret).not.toContain(secret);
    expect(app['shop']).toEqual(shopFactsFromBlock(ownerShop()));
    expect((app['menu'] as Record<string, unknown>)['shop']).toBeUndefined();
  });

  it('publicMenu drops the block whatever the row holds', () => {
    const m = { ...goldenMenu(), shop: ownerShop() };
    expect(publicMenu(m)).not.toHaveProperty('shop');
  });
});

describe('the pages’ one read: both blocks and the menu without its photos', () => {
  it('the menu as stored, in its order, every photo left out (imageUrl null), nothing else changed', async () => {
    const m = goldenMenu();
    m.categories[1]!.items[0]!.imageUrl = `data:image/webp;base64,${'A'.repeat(50_000)}`;
    await publish(m, { shop: ownerShop() });
    const facts = await getMenuFacts();
    const expected = m.categories.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, imageUrl: null })) }));
    expect(facts?.categories).toEqual(expected);
    expect(JSON.stringify(facts)).not.toContain('data:image');
    expect(await getShopFacts()).toEqual(shopFactsFromBlock(ownerShop()));
  });

  it('no menu published: no menu facts, today’s details; no database: the same', async () => {
    expect(await getMenuFacts()).toBeNull();
    expect(await getShopFacts()).toBe(DEFAULT_SHOP_FACTS);
    await publish(goldenMenu(), { shop: ownerShop() });
    const url = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      expect(await getShopFacts()).toBe(DEFAULT_SHOP_FACTS);
      expect(await getMenuFacts()).toBeNull();
    } finally {
      process.env['DATABASE_URL'] = url;
    }
  });

  it('a database error renders from the last read (the owner’s details, never today’s over them); Next’s own signals pass through', async () => {
    await publish(goldenMenu(), { shop: ownerShop() });
    const good = await getShopFacts();
    expect(good.profile.name).toBe('Test Kitchen');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.fail = new Error('connection refused');
    try {
      expect(await getShopFacts()).toEqual(good);
      db.fail = Object.assign(new Error('Dynamic server usage: no-store fetch'), { digest: 'DYNAMIC_SERVER_USAGE' });
      await expect(getShopFacts()).rejects.toThrow(/Dynamic server usage/);
    } finally {
      db.fail = null;
      quiet.mockRestore();
    }
  });

  it('a stored section that does not read (a hand-edited row) falls back to today’s for that section only', async () => {
    await publish(goldenMenu(), { shop: ownerShop() });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await db.pg.query(`UPDATE site_menu SET menu_json = jsonb_set(menu_json, '{shop,hours}', '{"opens":"nonsense"}'::jsonb)`, []);
      const shop = await getShopFacts();
      expect(shop.hours).toEqual(DEFAULT_SHOP_FACTS.hours);
      expect(shop.profile.name).toBe('Test Kitchen');
      // A stamp that does not read: the whole block is none (today's details).
      await db.pg.query(`UPDATE site_menu SET menu_json = jsonb_set(menu_json, '{shop,shopRev}', '"x"'::jsonb)`, []);
      expect(await getShopFacts()).toBe(DEFAULT_SHOP_FACTS);
    } finally {
      quiet.mockRestore();
    }
  });
});

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

// ===========================================================================

describe('every page follows the owner’s details', () => {
  /** The words that must be gone once the owner's details differ from today's. */
  const TODAYS = [
    '0300 9367865',
    '0331 2188295',
    '923009367865',
    '923312188295',
    'Sehar Lane',
    '75500',
    'Hygienically Made',
    '12 noon',
    'NOON',
    'daily',
    'every day',
    'every night',
    'every single day',
    'past midnight',
    'after midnight',
    'AFTER MIDNIGHT',
    'a midnight craving',
    'Cheese O’Clock',
    "Cheese O'Clock",
    "CHEESE O'CLOCK",
    'no cards or wallets needed',
    'No card or app required',
    'paid in cash at your door',
    'pay the rider in cash',
    'Pay cash at your door',
    'Not at the moment',
    'You pay the rider in cash',
    'Allergy? Tell us',
  ];
  /** The logo's own words stay (the image says them): the home page's H1 names it for screen readers. */
  const LOGO = 'It’s always Cheese O’Clock.';

  it('with every detail the owner’s: no page says today’s name, numbers, address, hours, "daily", "past midnight" or "cash only" — and each says the owner’s', async () => {
    const m = goldenMenu();
    await publish(m, { settings: settingsBlock(m), shop: ownerShop() });
    const pages = await allPages();
    for (const [route, html] of Object.entries(pages)) {
      const text = visible(html).replace(LOGO, '');
      for (const w of TODAYS) expect(text, `${route}: "${w}"`).not.toContain(w);
      // Today's closing time ("11 am" is not it).
      expect(text, route).not.toMatch(/(?<![\d:])1 (am|AM)\b/);
      expect(text, route).toContain('Open Tue–Sun · 11 am – 11 pm');
      expect(text, route).toContain('Test Kitchen');
      expect(text, route).toContain('Plot 9, Test Street, Test Phase 1');
      expect(text, route).toContain('Karachi 75999, Sindh, Pakistan');
      expect(text, route).toContain('© ');
      expect(text, route).toContain('Test Kitchen · Test Phase 1, Karachi · 0300 1112233');
      // Every link: the owner's lines and phone only; every order link greets with the owner's words.
      for (const h of hrefs(html)) {
        if (h.startsWith('tel:')) expect(h, route).toBe('tel:+923001112233');
        if (!h.startsWith('https://wa.me/')) continue;
        expect(h, route).toMatch(/^https:\/\/wa\.me\/(923214445566|923337778899)(\?text=|$)/);
        const text = new URL(h).searchParams.get('text');
        if (text !== null) {
          expect(text === OWNER_WEBSITE.whatsappGreeting || text.startsWith('Hi Test Kitchen!') || text.startsWith('Hi! Do you deliver'), `${route}: ${text}`).toBe(true);
        }
      }
      // The Restaurant node: the owner's name, phone, address, hours, payments, price range and profiles.
      expect(restaurant(html), route).toMatchObject({
        name: 'Test Kitchen',
        telephone: '+923001112233',
        priceRange: 'PKR 100–900',
        paymentAccepted: 'Cash on Delivery, Card',
        address: { streetAddress: 'Plot 9, Test Street, Test Phase 1', postalCode: '75999', addressLocality: 'Karachi' },
        openingHoursSpecification: [
          {
            '@type': 'OpeningHoursSpecification',
            dayOfWeek: ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
            opens: '11:00',
            closes: '23:00',
          },
        ],
        sameAs: OWNER_PROFILE.socialLinks,
      });
      // …and the footer shows the same profiles (JSON-LD mirrors visible content).
      expect(text, route).toContain('Instagram →');
      expect(text, route).toContain('Facebook →');
      expect(hrefs(html), route).toEqual(expect.arrayContaining(OWNER_PROFILE.socialLinks));
    }
    // The pages' own words, with the owner's details in them.
    const home = visible(pages['/']!);
    expect(home).toContain('Pay cash or card at your door.');
    expect(home).toContain('11 am – 11 pm · Tue–Sun');
    expect(home).toContain('Tue–Sun from 11 am to 11 pm.');
    expect(home).toContain('Cash or card on delivery. 15% tax is added on the bill');
    expect(home).toContain('Yes — message 0321 4445566 or 0333 7778899 with your order');
    expect(home).toContain('Hungry? Order now.');
    expect(home).toContain('MADE-UP WORDS UNDER THE NAME.');
    expect(home).toContain('OPEN 11 AM – 11 PM');
    expect(home).not.toContain("IT'S ALWAYS");
    expect(home).toContain('Pay at your door');
    expect(home).toContain('open Tue–Sun');
    const late = visible(pages['/late-night']!);
    expect(late).toContain('LATE-NIGHT FOOD DELIVERY IN DHA KARACHI — OPEN TILL 11 PM');
    expect(late).toContain('It is late, half of DHA’s kitchens have gone dark');
    expect(late).toContain('WHAT DHA ORDERS AT NIGHT');
    expect(late).toContain('The late pizza');
    expect(late).toContain('Which areas do you cover late at night?');
    expect(late).toContain('The kitchen takes orders Tue–Sun until 11 pm — website and WhatsApp both — and opens at 11 am.');
    expect(late).toContain('LATE CRAVING? ORDER UP.');
    expect(late).toContain('pay the rider at the gate.');
    const burgerText = visible(pages['/burger']!);
    expect(burgerText).toContain('No — the rider takes cash or card.');
    expect(burgerText).toContain('both are cash on delivery, Tue–Sun, from 11 am to 11 pm.');
    const dha5 = visible(pages['/delivery/dha-phase-5']!);
    expect(dha5).toContain('The rider takes cash or card.');
    expect(dha5).toContain('all paid at your door.');
    const dha6 = visible(pages['/delivery/dha-phase-6']!);
    expect(dha6).toContain('Our kitchen is at Plot 9, Test Street, Test Phase 1');
    expect(dha6).toContain('Late study session or family dinner — we are open Tue–Sun, from 11 am until 11 pm.');
    expect(dha6).toContain('HUNGRY IN DHA PHASE 6? ORDER UP.');
    const menuText = visible(pages['/menu']!);
    expect(menuText).toContain(OWNER_WEBSITE.allergyNotice);
    expect(menuText).toContain('pay cash or card on delivery or at the counter');
    const trackEl = await track.default({ params: { id: 'test-order' } });
    expect(propsWith(trackEl, 'orderId')!['shop']).toEqual(shopFactsFromBlock(ownerShop()));

    // Titles, descriptions, share blocks: the owner's name and hours. "Cash on Delivery" titles stay (cash is always taken).
    const meta = await metadata();
    expect(meta['layout']).toMatchObject({
      title: { default: 'Pizza & Burger Delivery in DHA Karachi | Test Kitchen', template: '%s · Test Kitchen' },
      description:
        'Signature pizzas, crispy chicken burgers and fries delivered across DHA Phases 1–8 and Clifton. Cash on delivery, open Tue–Sun 11 am – 11 pm. Order online or on WhatsApp.',
      openGraph: { title: 'Test Kitchen — Pizza & Burger Delivery in DHA Karachi', siteName: 'Test Kitchen' },
      twitter: { title: 'Test Kitchen — Pizza & Burger Delivery in DHA Karachi' },
    });
    expect(meta['lateNight']!['title']).toBe('Late-Night Food Delivery in DHA Karachi — Open Till 11 pm');
    expect(meta['pizza']!['title']).toBe('Pizza Delivery in DHA Karachi — Medium & Large, Cash on Delivery');
    expect(meta['pizza']!['description']).toMatch(/till 11 pm\.$/);
    expect(meta['burger']!['description']).toMatch(/open Tue–Sun till 11 pm\.$/);
    expect(meta['hub']!['description']).toBe(
      'Test Kitchen delivers pizza & burgers across DHA Phases 1–8 and Clifton from our Phase 6 kitchen. Rs 200–250 delivery, cash on delivery, open Tue–Sun till 11 pm.',
    );
    expect((meta['area']!['openGraph'] as Record<string, unknown>)['title']).toBe('Pizza & Burger Delivery in DHA Phase 6, Karachi · Test Kitchen');
    expect(meta['menu']!['description']).toMatch(/^Full Test Kitchen menu/);
    for (const [k, v] of Object.entries(meta)) expect(JSON.stringify(v), k).not.toMatch(/Cheese O|(?<![\d:])1 am|noon|daily/);

    // The share images and the app manifest.
    drawn.images.length = 0;
    await ogRoot.default();
    await ogArea.default({ params: { area: 'clifton' } });
    expect(drawn.images[0]).toContain('TEST KITCHEN.');
    for (const img of drawn.images) {
      expect(img).toContain('11 AM – 11 PM');
      expect(img).not.toContain('1 AM<');
      expect(img).not.toContain("IT&#x27;S ALWAYS");
    }
    expect(await manifest.default()).toMatchObject({
      name: 'Test Kitchen — Pizza & Burger Delivery',
      short_name: 'Test Kitchen',
      description: 'Signature pizzas, crispy chicken burgers and fries delivered across DHA & Clifton. Cash on delivery, open 11 am – 11 pm.',
    });
  });

  it('the checkout: the owner’s pick-up address, allergy notice, WhatsApp line and name, and what the rider and the counter take', () => {
    const shop = shopFactsFromBlock(ownerShop());
    const m = publicMenu(goldenMenu());
    const item = m.categories[0]!.items[0]!;
    const base = {
      cart: [{ key: 'k', item, label: 'Shawarma Pizza · Large 12"', quantity: 1, modifierIds: [], notes: null }],
      subtotal: item.basePriceCents,
      deliveryFee: 20_000,
      discount: 0,
      zone: findFactZone(DEFAULT_FACTS, 'dha-6'),
      tax: 0,
      total: item.basePriceCents,
      setQty: () => {},
      onClear: () => {},
      canPickup: true,
      pickupPct: 10,
      onFulfilment: () => {},
      pickupOnlyInCart: [],
      feeRange: 'Rs 200–250',
      deliveryNote: 'Rs 200–250 · DHA & Clifton',
      minDeliveryOrderCents: 0,
      zoneId: 'dha-6',
      onZone: () => {},
      deliveryFacts: DEFAULT_FACTS,
      closedNotice: null,
      onClose: () => {},
      orderIdFor: () => 'key',
      onPlaced: () => {},
    };
    const render = (fulfilment: 'delivery' | 'pickup', acceptingOrders: boolean) =>
      renderToStaticMarkup(
        React.createElement(ShopFactsContext.Provider, { value: shop }, React.createElement(CheckoutSheet, { ...base, fulfilment, acceptingOrders })),
      );
    const delivery = visible(render('delivery', true));
    expect(delivery).toContain('You pay the rider — cash or card. The printed receipt from the kitchen is the final bill.');
    expect(delivery).toContain(OWNER_WEBSITE.allergyNotice);
    const pickup = visible(render('pickup', true));
    expect(pickup).toContain('You pay when you collect — cash, card or EasyPaisa.');
    expect(pickup).toContain('Plot 9, Test Street, Test Phase 1, Karachi');
    const closed = render('delivery', false);
    expect(visible(closed)).toContain('(open tue–sun · 11 am – 11 pm)');
    const wa = hrefs(closed).filter((h) => h.startsWith('https://wa.me/'));
    expect(wa.length).toBeGreaterThan(0);
    for (const h of wa) {
      expect(h).toMatch(/^https:\/\/wa\.me\/923214445566\?text=/);
      expect(new URL(h).searchParams.get('text')).toMatch(/^Hi Test Kitchen! I'd like to order:/);
    }
  });

  it('closing at midnight: no "past midnight" (nor after it), the late-night title names midnight; every day: "every day" again', async () => {
    const m = goldenMenu();
    await publish(m, { shop: tillShop({ hours: { opens: '11:00', closes: '00:00', days: [...DEFAULT_SHOP_HOURS.days] } }) });
    const pages = await allPages();
    for (const [route, html] of Object.entries(pages)) {
      const text = visible(html);
      expect(text, route).not.toContain('past midnight');
      expect(text, route).not.toContain('a midnight craving');
      expect(text, route).toContain('Open daily · 11 am – midnight');
    }
    const late = visible(pages['/late-night']!);
    expect(late).toContain('OPEN TILL MIDNIGHT');
    expect(late).toContain('The kitchen takes orders every single day until midnight — website and WhatsApp both — and opens again at 11 am.');
    expect(late).toContain("LATE CRAVING? STILL CHEESE O'CLOCK.");
    expect(visible(pages['/']!)).toContain('Every day from 11 am to midnight.');
    expect(visible(pages['/']!)).toContain("IT'S ALWAYS CHEESE O'CLOCK");
  });

  it('closing at 2 am: "Open Till 2 am", the premise holds (past midnight, every night)', async () => {
    const m = goldenMenu();
    await publish(m, { shop: tillShop({ hours: { opens: '12:00', closes: '02:00', days: [...DEFAULT_SHOP_HOURS.days] } }) });
    const meta = await metadata();
    expect(meta['lateNight']!['title']).toBe('Late-Night Food Delivery in DHA Karachi — Open Till 2 am');
    const late = visible((await allPages())['/late-night']!);
    expect(late).toContain('It is past midnight, half of DHA’s kitchens went dark hours ago');
    expect(late).toContain('until 2 am — every night, not just weekends.');
    expect(late).toContain('WHAT DHA ORDERS AFTER MIDNIGHT');
    expect(late).toContain('MIDNIGHT CRAVING? STILL CHEESE O');
  });

  it('opening at 2 pm: the office FAQ no longer promises lunch', async () => {
    await publish(goldenMenu(), { shop: tillShop({ hours: { opens: '14:00', closes: '01:00', days: [...DEFAULT_SHOP_HOURS.days] } }) });
    const dha4 = visible((await allPages())['/delivery/dha-phase-4']!);
    expect(dha4).toContain('Yes — from 2 pm. Put the office name');
    expect(dha4).not.toContain('lunch and dinner');
  });

  it('tax follows the published menu: food at one other rate names it; food at two rates names none; a delivery charge’s rate never counts', async () => {
    const TAX_SURFACES = /\d+(?:\.\d+)?% tax/g;
    const at = (m: PublishedMenu, bps: number, only?: (name: string) => boolean) => ({
      ...m,
      categories: m.categories.map((c) => ({ ...c, items: c.items.map((i) => (only && !only(i.name) ? i : { ...i, taxRateBps: bps })) })),
    });
    // Every food item at 16.5% (the charges at 16%: ignored).
    const m1 = at(at(goldenMenu(), 1650), 1600, (n) => n.startsWith('Delivery Charge'));
    await publish(m1, { settings: settingsBlock(m1) });
    let pages = await allPages();
    const all = Object.values(pages).map(visible).join('\n');
    expect(new Set(all.match(TAX_SURFACES))).toEqual(new Set(['16.5% tax']));
    expect(visible(pages['/delivery/dha-phase-6']!)).toContain('the menu total plus 16.5% tax and the Rs 200 delivery fee');
    expect(visible(pages['/menu']!)).toContain('Prices in PKR · 16.5% tax added on the bill');
    // A drink at another rate: no number anywhere, the sentences still read.
    const m2 = at(goldenMenu(), 1300, (n) => n.startsWith('Soft Drink'));
    await publish(m2, { settings: settingsBlock(m2, { rev: 2 }) });
    pages = await allPages();
    for (const [route, html] of Object.entries(pages)) expect(visible(html), route).not.toMatch(/\d% tax/);
    expect(visible(pages['/']!)).toContain('Cash on delivery. Tax is added on the bill');
    expect(visible(pages['/']!)).toContain('Cash on delivery · tax on the bill');
    expect(visible(pages['/pizza']!)).toContain('the menu total plus tax and your area’s delivery fee');
    expect(visible(pages['/menu']!)).toContain('Prices in PKR · tax added on the bill');
  });

  it('no social links: no sameAs and no footer row (today’s); only the greeting changed: every order link carries it, encoded once, and the page-specific messages keep their words', async () => {
    const greeting = 'Salaam Cheese O’Clock, order please: ';
    await publish(goldenMenu(), { shop: tillShop({ website: { whatsappGreeting: greeting } }) });
    const pages = await allPages();
    for (const [route, html] of Object.entries(pages)) {
      expect(restaurant(html), route).not.toHaveProperty('sameAs');
      expect(visible(html), route).not.toContain('Instagram →');
      expect(html, route).not.toContain('place%20an%20order');
      for (const h of hrefs(html).filter((x) => x.includes('?text='))) {
        const text = new URL(h).searchParams.get('text')!;
        // Encoded once: decoding once gives the words back.
        expect(text, route).not.toMatch(/%[0-9A-F]{2}/);
        expect(text === greeting || /^Hi( Cheese O'Clock)?!/.test(text), `${route}: ${text}`).toBe(true);
      }
    }
    expect(pages['/']).toContain(`https://wa.me/923009367865?text=${encodeURIComponent(greeting).replace(/'/g, '&#x27;')}`);
    // The page-specific messages: their words, today's name.
    const pizzaLinks = hrefs(pages['/pizza']!).filter((h) => h.includes('?text='));
    expect(pizzaLinks.map((h) => new URL(h).searchParams.get('text'))).toContain("Hi Cheese O'Clock! I'd like to order pizza. ");
  });
});
