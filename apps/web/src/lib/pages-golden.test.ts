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
 * The differences since the golden was taken, each one spelled out:
 *  - sweep B2: with the menu unknown (a) the home and landing pages' prices
 *    come from the menu, so none show — compared against the golden with
 *    exactly those prices taken out (__fixtures__/menu-unknown.ts);
 *  - 2026-10-13: the footer's bottom line credits the ordering system, one
 *    link after "Staff login" on every page (__fixtures__/footer-credit.ts);
 *  - 2026-10-14: the home hero starts with the deals slider, worked out from
 *    the menu's deals, when there is a menu with deals — (b) and (c), not
 *    (a) (__fixtures__/hero-deals.ts).
 *  - 2026-10-24 (the ordering funnel): /menu's hook, deal cards (photo,
 *    price coin, one button) and the checkout's optional fields folded
 *    under one line — the golden's /menu pages (b, c) and its four checkout
 *    states were swapped for the new ones, nothing else (the last test here
 *    spells out what came in).
 *  - 2026-10-25: the root layout's metadata carries Meta's domain-verification
 *    tag for cheeseoclock.net (__fixtures__/domain-verification.ts).
 * Apart from those, states (b) and (c) are the golden byte for byte.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DELIVERY_ZONES, type DeliveryZoneSetting, type PublishedMenu, type PublishedSettings } from '@cheeseoclock/shared-types';
import { buildSettingsBlock } from '../../../../packages/pos-domain/src/delivery-charge';
import { goldenMenu } from './__fixtures__/golden-menu';
import { MENU_PRICED_ROUTES, htmlWithMenuUnknown } from './__fixtures__/menu-unknown';
import { FOOTER_CREDIT, withFooterCredit } from './__fixtures__/footer-credit';
import { heroDealsHtml, withHeroDeals } from './__fixtures__/hero-deals';
import { withDomainVerification } from './__fixtures__/domain-verification';
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
/**
 * The deals slider each state's home page starts its hero with ('' = none: (a) knows no menu); (c)'s block adds
 * its website offer (10% off pick-up orders).
 */
const HERO: Record<string, string> = {
  a: '',
  b: heroDealsHtml(goldenMenu()),
  c: heroDealsHtml(goldenMenu(), { pickup: defaultBlock(goldenMenu()).pickup }),
};

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
        // Every state: the footer credit added (2026-10-13); the home page: the deals slider first in
        // its hero while the menu has deals (2026-10-14).
        const want = withFooterCredit(state === 'a' ? htmlWithMenuUnknown(route, golden.html[key]!) : golden.html[key]!);
        expect(now.html[now.pages[state]![route]!], `${state} ${route}`).toBe(route === '/' ? withHeroDeals(want, HERO[state]!) : want);
      }
    });

    it(`(${state}) every page’s title, description, canonical, Open Graph and Twitter blocks, and the root layout’s`, () => {
      // The root layout's block gains Meta's domain-verification tag (2026-10-25, __fixtures__/domain-verification).
      expect(now.metadata[state]).toEqual(withDomainVerification(golden.metadata[state]));
    });

    it(`(${state}) the share images, the manifest, robots.txt and the sitemap`, () => {
      expect(now.images[state]).toEqual(golden.images[state]);
      expect(now.routes[state]).toEqual(golden.routes[state]);
    });
  }

  it('GET /api/menu with a menu published, with and without a settings block', () => {
    expect(now.apiMenu).toEqual(golden.apiMenu);
  });

  it('every page credits the ordering system once, in the footer’s bottom line (2026-10-13)', () => {
    for (const state of ['a', 'b', 'c']) {
      for (const [route, key] of Object.entries(now.pages[state]!)) {
        expect(now.html[key]!.split(FOOTER_CREDIT).length - 1, `${state} ${route}`).toBe(1);
      }
    }
  });

  it('the deals slider (2026-10-14): first in the home hero with the menu’s deals — once, on the home page only; none with the menu unknown', () => {
    expect(HERO['b']).toContain('aria-roledescription="carousel"');
    // Today's golden menu: its three pizza deals at the menu's prices; with (c)'s block, its 10% too.
    expect(HERO['b']).toContain('Pizza deals');
    expect(HERO['b']).not.toContain('% off');
    expect(HERO['c']).toContain('10% off pick-up orders');
    for (const state of ['b', 'c']) {
      for (const [route, key] of Object.entries(now.pages[state]!)) {
        expect(now.html[key]!.split(HERO[state]!).length - 1, `${state} ${route}`).toBe(route === '/' ? 1 : 0);
      }
    }
    for (const key of Object.values(now.pages['a']!)) expect(now.html[key]).not.toContain('aria-roledescription="carousel" aria-label="Deals"');
  });

  it('the checkout sheet: delivery and pick-up, open and closed', () => {
    for (const [k, html] of Object.entries(golden.checkout)) expect(now.checkout[k], k).toBe(html);
    expect(Object.keys(now.checkout)).toEqual(Object.keys(golden.checkout));
  });

  it('(a) the menu unknown changes only the pages that print menu prices, and on them only the prices', () => {
    for (const [route, key] of Object.entries(golden.pages['a']!)) {
      const was = withFooterCredit(golden.html[key]!);
      const is = now.html[now.pages['a']![route]!]!;
      expect(is === was, route).toBe(!MENU_PRICED_ROUTES.includes(route));
    }
    // With the menu published at today's prices, those same pages are the golden exactly (plus the footer credit,
    // and the home page's deals slider).
    for (const route of MENU_PRICED_ROUTES) {
      const want = withFooterCredit(golden.html[golden.pages['b']![route]!]!);
      expect(now.html[now.pages['b']![route]!], route).toBe(route === '/' ? withHeroDeals(want, HERO['b']!) : want);
    }
  });

  it('the golden copy is the one taken from v0.7.30 (a few of its facts, spelled out)', () => {
    const homeHtml = golden.html[golden.pages['a']!['/']!]!;
    expect(homeHtml).toContain('Open daily · 1 pm – 1 am');
    // The greeting in every order link (the HTML writes its apostrophes as &#x27;).
    expect(homeHtml).toContain('https://wa.me/923009367865?text=Hi%20Cheese%20O&#x27;Clock!%20I&#x27;d%20like%20to%20place%20an%20order%3A%20');
    expect(homeHtml).toContain('"openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],"opens":"13:00","closes":"01:00"}]');
    expect(homeHtml).toContain('"paymentAccepted":"Cash on Delivery"');
    // The shop's Instagram and Facebook (owner, 5 Oct 2026: "add social media"): JSON-LD and the footer name them.
    // Instagram is @cheeseoclock.karachi since 17 Oct 2026 (@cheeseoclock_ was disabled): the golden took the new link.
    expect(homeHtml).toContain('"sameAs":["https://www.instagram.com/cheeseoclock.karachi/","https://www.facebook.com/cheeseoclock.karachi"]');
    expect(homeHtml).toContain('Instagram →');
    // The shop's email (17 Oct 2026): the footer links it after the call line, JSON-LD names it.
    expect(homeHtml).toContain('Call 0300 9367865</a></li><li><a href="mailto:contact@cheeseoclock.net" class="hover:text-cheese">Email contact@cheeseoclock.net</a></li>');
    expect(homeHtml).toContain('"telephone":"+923009367865","email":"contact@cheeseoclock.net"');
    // 0331 2188295 is call only (owner, 30 Sep 2026): no page offers it on WhatsApp (17 Oct 2026, the golden took it out).
    for (const html of Object.values(golden.html)) expect(html).not.toContain('923312188295');
    // Words people search for (18 Oct 2026), in the home FAQ and the burger page's: the golden took them in.
    expect(homeHtml).toContain('Do you have Crown Crust pizza?');
    expect(homeHtml).toContain('Do you have a zinger burger?');
    expect(homeHtml).toContain('Regular pizzas such as Chicken Tikka, Fajita and Classic Pepperoni come in Medium 9&quot; and Large 12&quot;.');
    expect(homeHtml).toContain('Every day from 1 pm to 1 am. Late-night cravings are covered: the value deals run right up to closing, so they double as midnight deals.');
    expect(golden.html[golden.pages['a']!['/burger-delivery-dha-karachi']!]).toContain(
      'Start with the Classic Crispy Chicken (our zinger-style burger), step up to the Crispy Signature',
    );
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
    // (24 Oct 2026: closed is one slim line under the header, the shop's hours in it, WhatsApp beside it.)
    expect(golden.html[golden.pages['b']!['/menu (closed)']!]).toContain('Online orders closed (open daily · 1 pm – 1 am)');
    // The cleaner menu (20 Oct 2026: "too much information" in its header): the golden took the four /menu pages in —
    // one line of facts, the money off as chips, Buy 1 Get 1 as one line that opens to its rules, and the allergy
    // words after the last section; no "Order online · …" line and no tagline above the title.
    for (const state of ['b', 'c']) {
      for (const route of ['/menu (open)', '/menu (closed)']) {
        const menuHtml = golden.html[golden.pages[state]![route]!]!;
        const header = menuHtml.slice(menuHtml.indexOf('The Menu</h1>'), menuHtml.indexOf('aria-label="Menu sections"'));
        // (24 Oct 2026: hours and payment only — the delivery fee went to the cart bar and the checkout.)
        expect(header, `${state} ${route}`).toContain('<ul aria-label="Hours and payment"');
        expect(header, `${state} ${route}`).toContain('<details class="group');
        expect(header, `${state} ${route}`).not.toContain('Hygienically Made');
        expect(menuHtml, `${state} ${route}`).not.toContain('Order online · ');
        expect(menuHtml.indexOf('Allergy? Tell us'), `${state} ${route}`).toBeGreaterThan(menuHtml.lastIndexOf('</section>'));
      }
    }
    // The ordering funnel (24 Oct 2026): the golden took the /menu pages and the checkout states in — the hook in
    // English and Roman Urdu under the title, each deal a dark card with melted cheese on top, its price on a coin and
    // one button (a tap opens the golden menu's pizza deals with their first pizzas chosen), and the checkout's
    // optional fields folded under one line.
    for (const state of ['b', 'c']) {
      for (const route of ['/menu (open)', '/menu (closed)']) {
        const menuHtml = golden.html[golden.pages[state]![route]!]!;
        expect(menuHtml, `${state} ${route}`).toContain('Craving cheese? Order in 2 minutes.');
        expect(menuHtml, `${state} ${route}`).toContain('lang="ur-Latn"');
        expect(menuHtml, `${state} ${route}`).toContain('id="deal-big-two"');
        expect(menuHtml, `${state} ${route}`).toContain('aria-label="Choose options for Big Two');
        // The owner's brand lines: the pizzas' three under the first pizza section's title, the burgers' one on theirs.
        expect(menuHtml, `${state} ${route}`).toContain('Master-crafted premium sauces');
        expect(menuHtml, `${state} ${route}`).toContain('Creamy, crispy &amp; authentic burgers');
        expect(menuHtml, `${state} ${route}`).not.toContain('Delivery Rs 200');
        // The first screen (24 Oct 2026): a compact header — the title and the hook on one line — and, on a wide
        // screen, the shop's pizza linking down to the value deals.
        expect(menuHtml, `${state} ${route}`).toContain('src="/images/promise/pizza-peel-wide.webp"');
        expect(menuHtml, `${state} ${route}`).toContain('href="#value-deals"');
      }
    }
    for (const [k, html] of Object.entries(golden.checkout)) {
      expect(html, k).toMatch(/Add (directions or a map pin|a note)/);
    }
  });
});
