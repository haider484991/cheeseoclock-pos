/**
 * Every page of the website as it is SERVED, pinned to v0.7.30 (4fdb900,
 * released): the golden copy __fixtures__/pages-v0.7.30.json was taken from
 * that code, before the shop details (sweep B2 + B4) touched a page, by this
 * very test (WRITE_PAGES_GOLDEN=1). With NOTHING new stored, every page must
 * render it byte for byte:
 *  - the HTML of every page inside the root layout (visible text, links —
 *    every wa.me and tel: — and the layout's JSON-LD), deep-rendered: async
 *    server components awaited, client components as their server render;
 *  - every page's title, description, canonical, Open Graph and Twitter
 *    blocks (its metadata or generateMetadata), and the root layout's;
 *  - the share images (what they draw, as markup), the app manifest,
 *    robots.txt and the sitemap (without lastModified, which is the build's
 *    clock), and GET /api/menu;
 *  - the checkout sheet (client only: never in a page's first HTML) in its
 *    four states.
 * In three states of the database:
 *  (a) none (a build or a preview without DATABASE_URL);
 *  (b) a published menu (made-up ids and words, today's names and prices:
 *      __fixtures__/golden-menu.ts) and no settings block — /menu open,
 *      then closed;
 *  (c) the same with a v0.7.30 till's settings block at every default.
 * The one difference (sweep B2, since the golden was taken): with the menu
 * unknown (a) the home and landing pages' prices come from the menu, so none
 * show — compared against the golden with exactly those prices taken out
 * (__fixtures__/menu-unknown.ts). States (b) and (c) are the golden byte for byte.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DELIVERY_ZONES, type DeliveryZoneSetting, type PublishedMenu, type PublishedSettings } from '@cheeseoclock/shared-types';
import { buildSettingsBlock } from '../../../../packages/pos-domain/src/delivery-charge';
import { goldenMenu } from './__fixtures__/golden-menu';
import { MENU_PRICED_ROUTES, htmlWithMenuUnknown } from './__fixtures__/menu-unknown';
import { renderServer, stableHtml } from './__fixtures__/render-pages';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
}));
vi.mock('@/lib/db', () => ({
  // As the Neon client: a tagged template returning rows (PGlite takes $n params) — and, like the
  // real one, it throws when no database is configured.
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
const drawn = vi.hoisted(() => ({ images: [] as Array<{ html: string; width: number; height: number }> }));
vi.mock('next/og', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  class ImageResponse {
    constructor(element: unknown, opts: { width: number; height: number }) {
      drawn.images.push({ html: renderToStaticMarkup(element as never), width: opts.width, height: opts.height });
    }
  }
  return { ImageResponse };
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
const manifest = await import('@/app/manifest');
const robots = await import('@/app/robots');
const sitemap = await import('@/app/sitemap');
const ogRoot = await import('@/app/opengraph-image');
const ogArea = await import('@/app/delivery/[area]/opengraph-image');
const apiMenu = await import('@/app/api/menu/route');
const menuRoute = await import('@/app/api/bridge/menu/route');
const bridgeStatus = await import('@/app/api/bridge/status/route');
const { CheckoutSheet } = await import('@/components/ordering/CheckoutSheet');
const { DEFAULT_FACTS, findFactZone, deliveryFeeRange, deliveryOptionNote } = await import('@/lib/delivery-facts');
const { DELIVERY_AREAS } = await import('@/lib/areas');
const { publicMenu } = await import('@/lib/public-menu');

const FIXTURE = new URL('./__fixtures__/pages-v0.7.30.json', import.meta.url);
const SECRET = 'test-bridge-secret-0123456789';

type Metadata = Record<string, unknown>;
interface Golden {
  html: Record<string, string>;
  pages: Record<string, Record<string, string>>;
  metadata: Record<string, Record<string, unknown>>;
  images: Record<string, Record<string, unknown>>;
  routes: Record<string, unknown>;
  apiMenu: Record<string, unknown>;
  checkout: Record<string, string>;
}

// ---------------------------------------------------------------------------

function bridge(path: string, body: unknown) {
  return new Request(`https://site.test${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A v0.7.30 till's settings block for this menu with every setting at its default (online.options too). */
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

/** A module's metadata as Next reads it: generateMetadata when there is one, else the const. */
async function metaOf(mod: { metadata?: unknown; generateMetadata?: (a: never) => unknown }, arg?: unknown): Promise<Metadata | null> {
  const m = mod.generateMetadata ? await mod.generateMetadata(arg as never) : mod.metadata;
  return m === undefined ? null : (JSON.parse(JSON.stringify(m)) as Metadata);
}

const AREA_SLUGS = () => DELIVERY_AREAS.map((a) => a.slug);

/** Every page of the site in this state: route → HTML. */
async function allPages(opts: { menuStates: Array<'open' | 'closed'> | null }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  out['/'] = await page(React.createElement(home.default));
  out['/delivery'] = await page(React.createElement(hub.default));
  for (const slug of AREA_SLUGS()) out[`/delivery/${slug}`] = await page(React.createElement(area.default, { params: { area: slug } }));
  out['/pizza-delivery-dha-karachi'] = await page(React.createElement(pizza.default));
  out['/burger-delivery-dha-karachi'] = await page(React.createElement(burger.default));
  out['/late-night-food-delivery-dha'] = await page(React.createElement(lateNight.default));
  if (opts.menuStates === null) out['/menu'] = await page(React.createElement(menuPage.default));
  else {
    for (const s of opts.menuStates) {
      await heartbeat(s === 'open');
      out[`/menu (${s})`] = await page(React.createElement(menuPage.default));
    }
  }
  out['/_not-found'] = await page(React.createElement(notFound.default));
  out['/track/[id]'] = await page(React.createElement(track.default, { params: { id: 'test-order-id' } }));
  return out;
}

/** Every page's metadata in this state (the root layout's under "layout"). */
async function allMetadata(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  out['layout'] = await metaOf(layout as never);
  out['/'] = await metaOf(home as never);
  out['/delivery'] = await metaOf(hub as never);
  for (const slug of AREA_SLUGS()) out[`/delivery/${slug}`] = await metaOf(area as never, { params: { area: slug } });
  out['/pizza-delivery-dha-karachi'] = await metaOf(pizza as never);
  out['/burger-delivery-dha-karachi'] = await metaOf(burger as never);
  out['/late-night-food-delivery-dha'] = await metaOf(lateNight as never);
  out['/menu'] = await metaOf(menuPage as never);
  out['/_not-found'] = await metaOf(notFound as never);
  out['/track/[id]'] = await metaOf(track as never, { params: { id: 'test-order-id' } });
  return out;
}

/** What each share image draws (markup), with its route's alt, size and type. */
async function allImages(): Promise<Record<string, unknown>> {
  const draw = async (make: () => Promise<unknown>) => {
    drawn.images.length = 0;
    await make();
    expect(drawn.images).toHaveLength(1);
    return drawn.images[0]!;
  };
  const out: Record<string, unknown> = {
    exports: {
      root: { alt: ogRoot.alt, size: ogRoot.size, contentType: ogRoot.contentType },
      area: { alt: ogArea.alt, size: ogArea.size, contentType: ogArea.contentType },
    },
  };
  out['/opengraph-image'] = await draw(() => ogRoot.default() as Promise<unknown>);
  for (const slug of [...AREA_SLUGS(), 'not-an-area']) {
    out[`/delivery/${slug}/opengraph-image`] = await draw(() => ogArea.default({ params: { area: slug } }) as Promise<unknown>);
  }
  return out;
}

/** The checkout sheet as the server would render it (client only in practice), in four states. */
function allCheckout(): Record<string, string> {
  const m = publicMenu(goldenMenu());
  const pizzaItem = m.categories[0]!.items[0]!;
  const zone = findFactZone(DEFAULT_FACTS, 'dha-6');
  const base = {
    cart: [{ key: `${pizzaItem.posItemId}||`, item: pizzaItem, label: 'Shawarma Pizza · Large 12"', quantity: 1, modifierIds: [], notes: null }],
    subtotal: pizzaItem.basePriceCents,
    deliveryFee: 20_000,
    discount: 0,
    zone,
    tax: 33_000,
    total: 273_000,
    setQty: () => {},
    onClear: () => {},
    fulfilment: 'delivery' as const,
    canPickup: true,
    pickupPct: 10,
    onFulfilment: () => {},
    pickupOnlyInCart: [],
    feeRange: deliveryFeeRange(DEFAULT_FACTS),
    deliveryNote: deliveryOptionNote(DEFAULT_FACTS),
    minDeliveryOrderCents: 0,
    zoneId: 'dha-6',
    onZone: () => {},
    deliveryFacts: DEFAULT_FACTS,
    acceptingOrders: true,
    closedNotice: null,
    onClose: () => {},
    orderIdFor: () => 'test-order-key',
    onPlaced: () => {},
  };
  const out: Record<string, string> = {};
  for (const fulfilment of ['delivery', 'pickup'] as const) {
    for (const acceptingOrders of [true, false]) {
      const props = { ...base, fulfilment, acceptingOrders, ...(fulfilment === 'pickup' ? { discount: 22_000, deliveryFee: 0 } : {}) };
      out[`${fulfilment}, ${acceptingOrders ? 'open' : 'closed'}`] = renderToStaticMarkup(React.createElement(CheckoutSheet, props));
    }
  }
  return out;
}

async function apiMenuBody(): Promise<unknown> {
  const res = await apiMenu.GET();
  return (await res.json()) as unknown;
}

async function routesNow(): Promise<Record<string, unknown>> {
  const map = sitemap.default().map((e) => {
    const { lastModified: _clock, ...rest } = e;
    return rest;
  });
  // The manifest reads the owner's settings since sweep B4 (async); v0.7.30's was plain.
  return { manifest: await manifest.default(), robots: robots.default(), sitemap: map };
}

// ---------------------------------------------------------------------------

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** The site now, in the three states — the shape of the golden copy. */
async function capture(): Promise<Golden> {
  const html: Record<string, string> = {};
  const keep = (pages: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(pages).map(([route, h]) => {
        const k = hash(h);
        html[k] = h;
        return [route, k];
      }),
    );
  const g: Golden = { html, pages: {}, metadata: {}, images: {}, routes: {}, apiMenu: {}, checkout: {} };
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // (a) no database
    const url = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      g.pages['a'] = keep(await allPages({ menuStates: null }));
      g.metadata['a'] = await allMetadata();
      g.images['a'] = await allImages();
      g.routes['a'] = await routesNow();
    } finally {
      process.env['DATABASE_URL'] = url;
    }
    // (b) a published menu, no settings block
    await db.pg.query('DELETE FROM site_menu', []);
    const m = goldenMenu();
    await publish(m);
    g.pages['b'] = keep(await allPages({ menuStates: ['open', 'closed'] }));
    g.metadata['b'] = await allMetadata();
    g.images['b'] = await allImages();
    g.routes['b'] = await routesNow();
    g.apiMenu['b'] = await apiMenuBody();
    // (c) the same with a v0.7.30 till's block at the defaults
    await publish(m, defaultBlock(m));
    g.pages['c'] = keep(await allPages({ menuStates: ['open', 'closed'] }));
    g.metadata['c'] = await allMetadata();
    g.images['c'] = await allImages();
    g.routes['c'] = await routesNow();
    g.apiMenu['c'] = await apiMenuBody();
  } finally {
    quiet.mockRestore();
  }
  g.checkout = allCheckout();
  return g;
}

let now: Golden;
let golden: Golden;

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = 'postgres://test.invalid/db';
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  now = await capture();
  if (process.env['WRITE_PAGES_GOLDEN'] === '1') writeFileSync(FIXTURE, `${JSON.stringify(now, null, 1)}\n`);
  golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden;
}, 120_000);

afterAll(() => {
  delete process.env['BRIDGE_SECRET'];
});

describe('nothing new stored: every page exactly as v0.7.30', () => {
  it('the same pages, in every state', () => {
    for (const state of Object.keys(golden.pages)) {
      expect(Object.keys(now.pages[state] ?? {}), state).toEqual(Object.keys(golden.pages[state]!));
    }
  });

  for (const state of ['a', 'b', 'c']) {
    it(`(${state}) every page’s HTML, byte for byte`, () => {
      for (const [route, key] of Object.entries(golden.pages[state]!)) {
        // (a) the menu unknown: the golden without its prices (sweep B2) on the home and landing pages.
        const want = state === 'a' ? htmlWithMenuUnknown(route, golden.html[key]!) : golden.html[key];
        expect(now.html[now.pages[state]![route]!], `${state} ${route}`).toBe(want);
      }
    });

    it(`(${state}) every page’s title, description, canonical, Open Graph and Twitter blocks, and the root layout’s`, () => {
      expect(now.metadata[state]).toEqual(golden.metadata[state]);
    });

    it(`(${state}) the share images, the manifest, robots.txt and the sitemap`, () => {
      expect(now.images[state]).toEqual(golden.images[state]);
      expect(now.routes[state]).toEqual(golden.routes[state]);
    });
  }

  it('GET /api/menu with a menu published, with and without a settings block', () => {
    expect(now.apiMenu).toEqual(golden.apiMenu);
  });

  it('the checkout sheet: delivery and pick-up, open and closed', () => {
    for (const [k, html] of Object.entries(golden.checkout)) expect(now.checkout[k], k).toBe(html);
    expect(Object.keys(now.checkout)).toEqual(Object.keys(golden.checkout));
  });

  it('(a) the menu unknown changes only the pages that print menu prices, and on them only the prices', () => {
    for (const [route, key] of Object.entries(golden.pages['a']!)) {
      const was = golden.html[key]!;
      const is = now.html[now.pages['a']![route]!]!;
      expect(is === was, route).toBe(!MENU_PRICED_ROUTES.includes(route));
    }
    // With the menu published at today's prices, those same pages are the golden exactly.
    for (const route of MENU_PRICED_ROUTES) expect(now.html[now.pages['b']![route]!], route).toBe(golden.html[golden.pages['b']![route]!]);
  });

  it('the golden copy is the one taken from v0.7.30 (a few of its facts, spelled out)', () => {
    const homeHtml = golden.html[golden.pages['a']!['/']!]!;
    expect(homeHtml).toContain('Open daily · 1 pm – 1 am');
    // The greeting in every order link (the HTML writes its apostrophes as &#x27;).
    expect(homeHtml).toContain('https://wa.me/923009367865?text=Hi%20Cheese%20O&#x27;Clock!%20I&#x27;d%20like%20to%20place%20an%20order%3A%20');
    expect(homeHtml).toContain('"openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],"opens":"13:00","closes":"01:00"}]');
    expect(homeHtml).toContain('"paymentAccepted":"Cash on Delivery"');
    // The shop's Instagram and Facebook (owner, 5 Oct 2026: "add social media"): JSON-LD and the footer name them.
    expect(homeHtml).toContain('"sameAs":["https://www.instagram.com/cheeseoclock_/","https://www.facebook.com/cheeseoclock.karachi"]');
    expect(homeHtml).toContain('Instagram →');
    // The owner's and managers' phone dashboard (owner, 8 Oct 2026): one plain link at the end of the footer, not followed by crawlers.
    expect(homeHtml).toContain(' · <a href="/dashboard" rel="nofollow" class="hover:text-cheese">Staff login</a></div></footer>');
    expect((golden.metadata['a']!['layout'] as Metadata)['description']).toBe(
      'Signature pizzas, crispy chicken burgers and fries delivered across DHA Phases 1–8 and Clifton. Cash on delivery, open daily 1 pm – 1 am. Order online or on WhatsApp.',
    );
    expect(JSON.stringify(golden.images['a']!['/opengraph-image'])).toContain('1 PM – 1 AM');
    expect((golden.routes['a'] as { manifest: { short_name: string } }).manifest.short_name).toBe("Cheese O'Clock");
    // The /menu page in each state: no database → the WhatsApp fallback; a menu → the ordering app, open and closed.
    expect(golden.html[golden.pages['a']!['/menu']!]).toContain('Menu coming right up');
    expect(golden.html[golden.pages['b']!['/menu (open)']!]).toContain('The Menu');
    expect(golden.html[golden.pages['b']!['/menu (closed)']!]).toContain('We’re not taking online orders right now');
  });
});
