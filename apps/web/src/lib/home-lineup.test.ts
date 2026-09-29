/**
 * The website's copy from the published menu (sweep B2): the home page's
 * featured items (the owner's 'website.home', today's with none saved) with
 * the menu's prices and deal worth, the landing pages' price tokens, and the
 * till's photo of a featured item — on a real Postgres (PGlite, in memory,
 * with db/schema.sql), end to end through the bridge routes and the pages.
 *  - today's menu: every page is the v0.7.30 golden (pages-golden.test.ts);
 *    a price changed on the till moves only its card and its slide;
 *  - an item not on the menu (renamed, deleted, priced at 0, off the
 *    website) hides its card, slide or deal — never "Rs 0" — and the till
 *    hears which (homeMissing);
 *  - a deal's saving and struck-through worth only when it is worth more;
 *    the hero's chip is the cheapest deal shown;
 *  - the owner's picks: by the till's id, else the name; his words (never a
 *    drink brand); the till's photo by link, else a plain panel;
 *  - the landing pages' {price:…} tokens and their words without a price.
 * Every id, description and photo here is made up; the prices are the
 * golden menu's (today's, as the website printed them).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  type PublishedMenu,
  type PublishedMenuItem,
  type PublishedShop,
  type ShopHours,
  type ShopProfile,
  type ShopWebsite,
  type WebsiteHome,
} from '@cheeseoclock/shared-types';
import { buildShopBlock } from '../../../../packages/pos-domain/src/shop-block';
import { goldenMenu } from './__fixtures__/golden-menu';
import { renderServer, stableHtml } from './__fixtures__/render-pages';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
}));
vi.mock('@/lib/db', () => ({
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
const pizza = await import('@/app/pizza-delivery-dha-karachi/page');
const burger = await import('@/app/burger-delivery-dha-karachi/page');
const lateNight = await import('@/app/late-night-food-delivery-dha/page');
const menuRoute = await import('@/app/api/bridge/menu/route');
const photoRoute = await import('@/app/api/menu-photo/[id]/route');
const { PizzaCarousel3DClient } = await import('@/components/PizzaCarousel3DClient');
const { getMenuFacts } = await import('@/lib/site-facts');
const { DEFAULT_FACTS, claimHolds, copyText, fillFees } = await import('@/lib/delivery-facts');
const { PRICE_LINES, priceWords } = await import('@/lib/menu-prices');
const { dealSaveCents, dealsFromCents, resolveHome } = await import('@/lib/home-lineup');

const golden = JSON.parse(readFileSync(new URL('./__fixtures__/pages-v0.7.30.json', import.meta.url), 'utf8')) as {
  html: Record<string, string>;
  pages: Record<string, Record<string, string>>;
};
const SECRET = 'test-bridge-secret-0123456789';

// ---------------------------------------------------------------------------

function bridge(path: string, body: unknown) {
  return new Request(`https://site.test${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function publish(m: PublishedMenu, shop?: PublishedShop): Promise<{ homeMissing: string[] }> {
  const res = await menuRoute.PUT(bridge('/api/bridge/menu', shop ? { ...m, shop } : m));
  const json = (await res.json()) as { ok: boolean; data: { homeMissing: string[] } };
  expect([res.status, json.ok], JSON.stringify(json)).toEqual([200, true]);
  return json.data;
}

/** The till's shop block with today's details and this home lineup (pos-domain buildShopBlock). */
function shopWith(homeLineup: WebsiteHome): PublishedShop {
  return buildShopBlock({
    profile: { ...DEFAULT_SHOP_PROFILE, v: 1 } as ShopProfile,
    hours: { ...DEFAULT_SHOP_HOURS, v: 1 } as ShopHours,
    website: { ...DEFAULT_SHOP_WEBSITE, v: 1 } as ShopWebsite,
    home: homeLineup,
    stamps: [null, null, null, { version: 1, updatedAt: '2026-09-28T08:00:00.000Z' }],
    deviceId: 'till-1',
  });
}

/** The golden menu with `edit` applied to its items (by name); `null` removes one. */
function menuWith(edit: Record<string, Partial<PublishedMenuItem> | null>, m: PublishedMenu = goldenMenu()): PublishedMenu {
  return {
    ...m,
    categories: m.categories.map((c) => ({
      ...c,
      items: c.items.flatMap((i) => {
        if (!(i.name in edit)) return [i];
        const e = edit[i.name];
        return e === null ? [] : [{ ...i, ...e }];
      }),
    })),
  };
}

async function homeHtml(): Promise<string> {
  return stableHtml(await renderServer(React.createElement(layout.default, { children: React.createElement(home.default) })));
}
async function pageHtml(mod: { default: () => unknown }): Promise<string> {
  return stableHtml(await renderServer(React.createElement(layout.default, { children: React.createElement(mod.default as never) })));
}

/** What a reader sees: tags out, the few entities React writes decoded. */
function visible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const GOLDEN_HOME = () => golden.html[golden.pages['b']!['/']!]!;
const GRID_BADGE = (rs: string) =>
  `<span class="absolute left-4 top-4 rounded-full bg-cheese px-3 py-1 font-cond text-sm font-extrabold text-ink">${rs}</span>`;
const SLIDE_BADGE = (rs: string) => `<span class="rounded-full bg-cheese px-4 py-1.5 font-cond text-lg font-extrabold text-ink">${rs}</span>`;
/** The grid cards' names, in order (each card's h3). */
const gridNames = (html: string) => [...html.matchAll(/<h3 class="mt-1 font-display text-3xl uppercase tracking-wide">([^<]+)<\/h3>/g)].map((m) => m[1]);
/** The carousel's dots (one per pizza), by name. */
const carouselDots = (html: string) => [...html.matchAll(/aria-label="Show ([^"]+)"/g)].map((m) => m[1]);
/** The deal cards' names, in order. */
const dealNames = (html: string) =>
  [...html.matchAll(/<span class="mt-1 block pr-20 font-display text-4xl uppercase leading-none tracking-wide">([^<]+)<\/span>/g)].map((m) => m[1]);

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = 'postgres://test.invalid/db';
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  await db.pg.query('DELETE FROM site_menu', []);
});

// ---------------------------------------------------------------------------

describe('the home page follows the published menu', () => {
  it('today’s menu: the golden home page, every featured item found (homeMissing [])', async () => {
    expect((await publish(goldenMenu())).homeMissing).toEqual([]);
    expect(await homeHtml()).toBe(GOLDEN_HOME());
  });

  it('a price changed on the till moves only its card and its carousel slide; a deal’s, only that deal’s price and saving', async () => {
    await publish(menuWith({ 'Cheesy Star — Large': { basePriceCents: 234_500 }, 'Big Two': { basePriceCents: 350_000 } }));
    let want = GOLDEN_HOME();
    // The Cheesy Star's card (the first after its photo's alt) and the front slide (the Cheesy Star's).
    const card = want.indexOf(GRID_BADGE('Rs 2,200'), want.indexOf('alt="Cheesy Star from Cheese O&#x27;Clock"'));
    want = want.slice(0, card) + GRID_BADGE('Rs 2,345') + want.slice(card + GRID_BADGE('Rs 2,200').length);
    want = want.replace(SLIDE_BADGE('Rs 2,200'), SLIDE_BADGE('Rs 2,345'));
    // Big Two: Rs 3,500, worth Rs 4,250 one by one → save Rs 750 (Family Feast and Perfect Pair as they were).
    want = want
      .replace('<span class="mt-0.5 block text-lg">Rs 650</span>', '<span class="mt-0.5 block text-lg">Rs 750</span>')
      .replace(
        '<span class="block font-display text-4xl tracking-wide text-cheese">Rs 3,600</span>',
        '<span class="block font-display text-4xl tracking-wide text-cheese">Rs 3,500</span>',
      );
    const html = await homeHtml();
    expect(html).toBe(want);
    expect(html.split(GRID_BADGE('Rs 2,200')).length - 1).toBe(4);
    expect(html).toContain('Value deals from Rs 2,600 →');
  });

  it('an item not on the menu — renamed, deleted, priced at 0 — hides its card, slide or deal, never "Rs 0"; the till is told which', async () => {
    const m = menuWith({
      'Cheetos — Large': { name: 'Cheetos Supreme — Large' },
      'Crown Crust — Large': { basePriceCents: 0 },
      'Family Feast': null,
    });
    expect((await publish(m)).homeMissing).toEqual(['Crown Crust — Large', 'Cheetos — Large', 'Family Feast']);
    const html = await homeHtml();
    expect(gridNames(html)).toEqual(['Cheesy Star', 'Shawarma Pizza', 'Meat Lovers', 'Signature Cheese Dipped']);
    expect(carouselDots(html)).toEqual(['Cheesy Star', 'Shawarma Pizza', 'Meat Lovers']);
    expect(dealNames(html)).toEqual(['Big Two', 'Perfect Pair']);
    expect(visible(html)).toContain('Value deal 02');
    expect(visible(html)).not.toContain('Value deal 03');
    for (const gone of ['Crown Crust', 'Cheetos', 'Family Feast']) expect(visible(html), gone).not.toContain(gone);
    expect(html).not.toMatch(/Rs 0(?![\d,])/);
  });

  it('none of the lineup on the menu: no turntable, no signatures, no deals and no deals chip — the rest of the page as before', async () => {
    const m = goldenMenu();
    const onlyCharges = { ...m, categories: m.categories.filter((c) => /delivery/i.test(c.name)) };
    expect((await publish(onlyCharges)).homeMissing).toEqual([...DEFAULT_WEBSITE_HOME.pizzas, DEFAULT_WEBSITE_HOME.burger!, ...DEFAULT_WEBSITE_HOME.deals].map((e) => e.itemRef.name));
    const html = await homeHtml();
    expect(html).not.toContain('aria-roledescription="carousel"');
    expect(visible(html)).not.toContain('The signatures');
    expect(html).not.toContain('id="deals"');
    expect(visible(html)).not.toContain('Value deals');
    expect(visible(html)).toContain('Questions, answered');
    expect(visible(html)).toContain('Oven to door in three steps');
  });

  it('a deal’s saving and struck-through worth only when it is worth more than it costs; the chip is the cheapest deal shown', async () => {
    // Perfect Pair above its worth (Rs 3,250 one by one): its price only.
    await publish(menuWith({ 'Perfect Pair': { basePriceCents: 330_000 } }));
    let html = await homeHtml();
    expect(html.match(/>Save</g)).toHaveLength(2);
    expect(html.match(/line-through/g)).toHaveLength(2);
    expect(html).toContain('<span class="block font-display text-4xl tracking-wide text-cheese">Rs 3,300</span>');
    expect(html).toContain('Value deals from Rs 3,100 →');
    // No 1 litre drink on the menu: no deal can be priced one by one — prices, no saving.
    await publish(menuWith({ 'Soft Drink — 1 litre': null }));
    html = await homeHtml();
    expect(html).not.toContain('>Save<');
    expect(html).not.toContain('line-through');
    expect(dealNames(html)).toEqual(['Big Two', 'Family Feast', 'Perfect Pair']);
    expect(html).toContain('Value deals from Rs 2,600 →');
  });

  it('the owner’s picks: by the till’s id (renamed since), else the name; his words, never a drink brand; the till’s photo by link, else a plain panel', async () => {
    const photo = `data:image/png;base64,${Buffer.from('made-up photo bytes').toString('base64')}`;
    const m = menuWith({ 'Fajita Pizza — Large': { imageUrl: photo } });
    const lineup: WebsiteHome = {
      v: 1,
      pizzas: [
        { itemRef: { posItemId: 'gi-faj-l', name: 'Old Name — Large' }, headline: 'A made-up line', text: 'Made-up words, with a Pepsi.' },
        { itemRef: { posItemId: 'not-on-the-menu', name: 'classic  supreme – MEDIUM' } },
      ],
      burger: null,
      deals: [{ itemRef: { posItemId: null, name: 'Perfect Pair' } }],
    };
    expect((await publish(m, shopWith(lineup))).homeMissing).toEqual([]);
    const html = await homeHtml();
    expect(gridNames(html)).toEqual(['Fajita Pizza', 'Classic Supreme']);
    expect(carouselDots(html)).toEqual(['Fajita Pizza', 'Classic Supreme']);
    const text = visible(html);
    // Regular pizzas, not signatures: labelled and linked by their own section on /menu.
    expect(text).toContain('Regular Pizzas · Large 12" Fajita Pizza Made-up words, with a soft drink.');
    expect(text).toContain('Regular Pizzas · Medium 9" Classic Supreme More made-up words.');
    expect(text).not.toMatch(/Signature · /);
    expect(html).not.toContain('/menu#signature-pizzas');
    expect(html).toContain('href="/menu#regular-pizzas"');
    // The carousel's front slide says so too, and its "Order this" goes there.
    expect(html).toMatch(/text-cheese">Regular Pizzas · (<!-- -->)?Large 12&quot;<\/p>/);
    expect(text).not.toMatch(/pepsi/i);
    // The front slide's line under its name: the owner's headline.
    expect(text).toContain('Fajita Pizza A made-up line Rs 2,000 Order this →');
    // The till's photo by link (its version: the data URL's md5), never inlined; no photo → the name on a panel.
    const v = createHash('md5').update(photo).digest('hex').slice(0, 12);
    expect(html).toContain(`src="/api/menu-photo/gi-faj-l?v=${v}"`);
    expect(html).not.toContain('data:image');
    expect(html).toContain('<span aria-hidden="true" class="px-6 text-center font-display text-5xl uppercase leading-none tracking-wide text-cheese">Classic Supreme</span>');
    expect(html).toContain(GRID_BADGE('Rs 2,000'));
    expect(html).toContain(GRID_BADGE('Rs 1,500'));
    // No burger card; one deal, with today's words for it.
    expect(text).not.toContain('Signature burger');
    expect(dealNames(html)).toEqual(['Perfect Pair']);
    expect(text).toContain('2 Medium 9" + 1 litre soft drink');
    expect(html).toContain('Value deals from Rs 2,600 →');
    expect((await getMenuFacts())?.photos).toEqual({ 'gi-faj-l': v });
  });
});

describe('the lineup, worked out (lib/home-lineup)', () => {
  const m = goldenMenu();
  it('the menu unknown: today’s lineup and words, no price — not "missing"', () => {
    const view = resolveHome(DEFAULT_WEBSITE_HOME, null);
    expect(view.menuKnown).toBe(false);
    expect(view.pizzas.map((p) => [p.name, p.size, p.priceCents])).toEqual([
      ['Cheesy Star', 'Large 12"', null],
      ['Crown Crust', 'Large 12"', null],
      ['Shawarma Pizza', 'Large 12"', null],
      ['Meat Lovers', 'Large 12"', null],
      ['Cheetos', 'Large 12"', null],
    ]);
    expect(view.burger?.label).toBe('Signature burger');
    expect(view.deals.map((d) => [d.name, d.what, d.priceCents, dealSaveCents(d)])).toEqual([
      ['Big Two', '2 Large 12" + 1 litre soft drink', null, null],
      ['Family Feast', '1 Medium 9" + 1 Large 12" + 1 litre soft drink', null, null],
      ['Perfect Pair', '2 Medium 9" + 1 litre soft drink', null, null],
    ]);
    expect(dealsFromCents(view)).toBeNull();
  });

  it('today’s menu: the menu’s prices and worth (Rs 4,250 / 3,750 / 3,250 one by one)', () => {
    const view = resolveHome(DEFAULT_WEBSITE_HOME, m);
    expect(view.pizzas.map((p) => p.priceCents)).toEqual([220_000, 220_000, 220_000, 220_000, 220_000]);
    expect(view.burger?.priceCents).toBe(90_000);
    expect(view.deals.map((d) => [d.priceCents, d.worthCents, dealSaveCents(d)])).toEqual([
      [360_000, 425_000, 65_000],
      [310_000, 375_000, 65_000],
      [260_000, 325_000, 65_000],
    ]);
    expect(dealsFromCents(view)).toBe(260_000);
  });

  it('a delivery charge is never a featured item, even by name; two picks of one name get their own keys', () => {
    const lineup = {
      pizzas: [
        { itemRef: { posItemId: null, name: 'Delivery Charge (Rs 200)' } },
        { itemRef: { posItemId: null, name: 'Fajita Pizza — Medium' } },
        { itemRef: { posItemId: null, name: 'Fajita Pizza — Large' } },
      ],
      burger: null,
      deals: [],
    };
    const view = resolveHome(lineup, m);
    expect(view.pizzas.map((p) => [p.key, p.label, p.href])).toEqual([
      ['Fajita Pizza', 'Regular Pizzas · Medium 9"', '/menu#regular-pizzas'],
      ['Fajita Pizza · Large 12"', 'Regular Pizzas · Large 12"', '/menu#regular-pizzas'],
    ]);
    // Today's: the signatures section and the Signature Cheese Dipped in Burgers, as always.
    const today = resolveHome(DEFAULT_WEBSITE_HOME, m);
    expect(new Set(today.pizzas.map((p) => [p.label, p.kind, p.href].join('|')))).toEqual(new Set(['Signature · Large 12"|Signature|/menu#signature-pizzas']));
    expect([today.burger?.label, today.burger?.href]).toEqual(['Signature burger', '/menu#burgers']);
    // Another burger featured: not called a signature.
    const plain = resolveHome({ pizzas: DEFAULT_WEBSITE_HOME.pizzas, burger: { itemRef: { posItemId: null, name: 'Classic Crispy Chicken' } }, deals: [] }, m);
    expect([plain.burger?.label, plain.burger?.href]).toEqual(['Burgers', '/menu#burgers']);
  });

  it('one pizza: a turntable with no arrows and no dots; none: nothing', () => {
    const one = resolveHome({ pizzas: [DEFAULT_WEBSITE_HOME.pizzas[0]!], burger: null, deals: [] }, m).pizzas;
    const html = renderToStaticMarkup(React.createElement(PizzaCarousel3DClient, { pizzas: one, shopName: 'Test Kitchen' }));
    expect(html).toContain('Cheesy Star');
    expect(html).toContain('alt="Cheesy Star pizza from Test Kitchen"');
    expect(html).not.toContain('Previous pizza');
    expect(html).not.toContain('aria-label="Show ');
    expect(renderToStaticMarkup(React.createElement(PizzaCarousel3DClient, { pizzas: [], shopName: 'Test Kitchen' }))).toBe('');
  });
});

describe('the landing pages’ prices ({price:…}, lib/menu-prices)', () => {
  const m = goldenMenu();
  it('today’s menu: today’s words', () => {
    const words = Object.fromEntries(Object.keys(PRICE_LINES).map((k) => [k, priceWords(k, m)]));
    expect(words).toEqual({
      deals: 'Rs 2,600',
      burgers: 'Rs 700 – Rs 950',
      sides: 'Rs 300',
      masalaFries: 'Rs 480',
      burgerCheese: 'Rs 100',
      dip: 'Rs 100',
    });
  });

  it('a pick-up-only item is no delivery price: the delivery pages leave it out (the till’s flag, or its description)', () => {
    expect(priceWords('burgers', menuWith({ 'Nashville Authentic (Hot)': { pickupOnly: true } }))).toBe('Rs 700 – Rs 900');
    expect(priceWords('sides', menuWith({ 'Fries — Regular': { description: 'Pick up only.' } }))).toBe('Rs 450');
    expect(priceWords('masalaFries', menuWith({ 'Signature Masala Fries — Large': { pickupOnly: true }, 'Signature Mayo Masala Fries — Large': { pickupOnly: true } }))).toBeNull();
  });

  it('what the menu can’t say has no words — unknown, the items gone, choices at two prices — and a typo throws', () => {
    for (const k of Object.keys(PRICE_LINES)) expect(priceWords(k, null), k).toBeNull();
    const oneBurger = menuWith({ 'Crispy Signature': null, 'Signature Cheese Dipped': null, 'Nashville Authentic (Hot)': null });
    expect(priceWords('burgers', oneBurger)).toBe('Rs 700');
    const noDeals = menuWith({ 'Big Two': null, 'Family Feast': null, 'Perfect Pair': { basePriceCents: 0 } });
    expect(priceWords('deals', noDeals)).toBeNull();
    const dips = menuWith({
      'Cheesy Star — Large': {
        modifierGroups: [
          {
            posGroupId: 'g-x',
            name: 'Dips on the side',
            selectionType: 'multi',
            minSelect: 0,
            maxSelect: 1,
            isRequired: false,
            sortOrder: 0,
            modifiers: [{ posModifierId: 'm-x', name: 'Side of Test Dip C', priceDeltaCents: 15_000, isDefault: false, sortOrder: 0 }],
          },
        ],
      },
    });
    expect(priceWords('dip', dips)).toBeNull();
    expect(() => priceWords('nope', m)).toThrow(/Unknown price/);
    expect(() => fillFees('{price:nope}', { ...DEFAULT_FACTS, menu: m })).toThrow(/Unknown fee token/);
    expect(() => claimHolds({ priced: 'nope' as never }, { ...DEFAULT_FACTS, menu: m })).toThrow(/Unknown price/);
    // A token that can't print takes its copy's other words; never "Rs 0".
    const facts = { ...DEFAULT_FACTS, menu: noDeals };
    expect(copyText({ text: 'From {price:deals}', when: { priced: 'deals' }, otherwise: 'Value deals' }, facts)).toBe('Value deals');
    expect(fillFees('{price:deals}', { ...DEFAULT_FACTS, menu: m })).toBe('Rs 2,600');
  });

  it('the pages print the menu’s prices, and say it without one when the menu can’t', async () => {
    await publish(
      menuWith({
        'Big Two': { basePriceCents: 355_000 },
        'Family Feast': { basePriceCents: 305_000 },
        'Perfect Pair': { basePriceCents: 255_000 },
        'Classic Crispy Chicken': { basePriceCents: 72_500 },
        'Fries — Regular': { basePriceCents: 32_000 },
        'Signature Masala Fries — Large': { basePriceCents: 49_000 },
      }),
    );
    let p = visible(await pageHtml(pizza));
    let b = visible(await pageHtml(burger));
    let n = visible(await pageHtml(lateNight));
    expect(p).toContain('From Rs 2,550 Value deals · 1 litre soft drink');
    expect(p).toContain('dips are Rs 100 each.');
    expect(b).toContain('4 burgers Rs 725 – Rs 950');
    expect(b).toContain('Add cheese to any burger for Rs 100.');
    expect(b).toContain('Fries & sides From Rs 320');
    expect(b).toContain('Add cheese to any of them for Rs 100.');
    expect(n).toContain('Masala fries Large · from Rs 490');
    // The deals, the burgers, the sides, the masala fries and the extras gone from the menu.
    const m2 = goldenMenu();
    await publish({ ...m2, categories: m2.categories.filter((c) => /pizza|delivery|drinks/i.test(c.name)) });
    p = visible(await pageHtml(pizza));
    b = visible(await pageHtml(burger));
    n = visible(await pageHtml(lateNight));
    expect(p).toContain('Value deals 1 litre soft drink Value deals');
    expect(p).toContain('dips are Rs 100 each.'); // the signature pizzas still carry the dips
    expect(b).toContain('4 burgers Mild to Nashville hot');
    expect(b).toContain('Add cheese to any burger.');
    expect(b).toContain('Fries & sides Fries, nuggets & wings');
    expect(b).toContain('Add cheese to any of them.');
    expect(n).toContain('Masala fries Masala · Mayo Masala');
    for (const t of [p, b, n]) expect(t).not.toMatch(/Rs 0(?![\d,])/);
  });
});

describe('the till’s photo of a featured item (GET /api/menu-photo/[id])', () => {
  const get = (id: string, v?: string) =>
    photoRoute.GET(new Request(`https://site.test/api/menu-photo/${id}${v ? `?v=${v}` : ''}`), { params: { id } });

  it('the published photo’s bytes, cached for good under its version and for a minute otherwise; never an SVG or an unknown item', async () => {
    const bytes = Buffer.from('made-up webp bytes');
    const photo = `data:image/webp;base64,${bytes.toString('base64')}`;
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="x()"/>').toString('base64')}`;
    await publish(menuWith({ 'Nuggets': { imageUrl: photo }, 'Baked Wings': { imageUrl: svg } }));
    const v = createHash('md5').update(photo).digest('hex').slice(0, 12);
    let res = await get('gi-s-ng', v);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    res = await get('gi-s-ng', 'an-old-one');
    expect([res.status, res.headers.get('cache-control')]).toEqual([200, 'public, max-age=60, s-maxage=60']);
    for (const id of ['gi-s-bw', 'gi-s-fr', 'not-on-the-menu']) expect((await get(id, v)).status, id).toBe(404);
    const url = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      expect((await get('gi-s-ng', v)).status).toBe(404);
    } finally {
      process.env['DATABASE_URL'] = url;
    }
  });
});
