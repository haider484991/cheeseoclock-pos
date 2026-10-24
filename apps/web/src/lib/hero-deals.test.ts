/**
 * The home hero's deals and offers (the user, 14 Oct 2026): each burger deal
 * with its own photo, each category's own website % with every size's price
 * before and after, the pizza deals, Buy 1 Get 1 (while on) and the website's
 * % off the rest — from the published menu and the owner's stored offer —
 * and the markup it draws (lib/hero-deals, components/HeroDealsClient).
 * Every id and description here is made up; the names and prices are today's.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUY_1_GET_1_RULES,
  type PublishedMenuCategory,
  type PublishedMenuItem,
  type PublishedPickup,
} from '@cheeseoclock/shared-types';
import { HERO_PHOTOS, HERO_ROWS_MAX, heroSlides, type HeroSlide } from './hero-deals';

const React = await import('react');
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = await import('react-dom/server');
const { HeroDealsClient } = await import('@/components/HeroDealsClient');

let n = 0;
function item(
  name: string,
  rs: number,
  description: string | null = null,
  over: Partial<PublishedMenuItem> = {},
): PublishedMenuItem {
  n += 1;
  return {
    posItemId: `test-item-${n}`,
    name,
    description,
    basePriceCents: rs * 100,
    taxRateBps: 1500,
    imageUrl: null,
    sortOrder: n,
    modifierGroups: [],
    ...over,
  };
}
const category = (name: string, items: PublishedMenuItem[]): PublishedMenuCategory => ({
  posCategoryId: `test-cat-${name.toLowerCase().replace(/\W+/g, '-')}`,
  name,
  displayOrder: 0,
  items,
});
const PIZZA = 'test-cat-pizza';

/** Today's menu as far as the slider reads it (the till's own order; its typo kept). */
function todaysMenu(): { categories: PublishedMenuCategory[] } {
  return {
    categories: [
      category('Value Deals', [
        item('Classic Crispy Deal', 850, '1 Classic Crispy Deal+ 1 Regular Fries+ 345ml Drink', {
          noDiscount: true,
        }),
        item('Signature Cripsy Deal', 950, '1 Signature Crispy+ Regular Fries+ 345ml Drink', {
          noDiscount: true,
        }),
        item('Cheese Dipped Deal', 1050, '1 Signature Cheese Dip+ 1 Regular Fries+ 345ml drink', {
          noDiscount: true,
        }),
        item('Big Two', 3600, '2 Large 12" regular pizzas + 1 litre soft drink.', {
          noDiscount: true,
        }),
        item(
          'Family Feast',
          3100,
          '1 Medium 9" + 1 Large 12" regular pizza + 1 litre soft drink.',
          { noDiscount: true },
        ),
        item('Perfect Pair', 2600, '2 Medium 9" regular pizzas + 1 litre soft drink.', {
          noDiscount: true,
        }),
      ]),
      category('Burgers', [
        item(
          'Classic Crispy Chicken',
          700,
          'Crispy fillet, mayonnaise and lettuce in a brioche bun.',
        ),
        item(
          'Crispy Signature',
          800,
          'Crispy fillet, signature sauce and lettuce in a brioche bun.',
        ),
        item('Signature Cheese Dipped', 900, 'Fillet dunked in molten cheese in a brioche bun.'),
        item(
          'Nashville Authentic (Hot)',
          950,
          'Nashville hot fillet, coleslaw and pickle in a brioche bun.',
        ),
      ]),
      category('Buy 1 Get 1 Deals', [
        item(
          'Large + Free Burger or Side',
          2000,
          'Any Large 12" regular pizza + any burger or any side FREE.',
          { noDiscount: true },
        ),
        item(
          'Large + Free Medium',
          2000,
          'Any Large 12" regular pizza + any Medium 9" regular pizza FREE.',
          { noDiscount: true },
        ),
        item('Medium + Free Side', 1500, 'Any Medium 9" regular pizza + any side FREE.', {
          noDiscount: true,
        }),
      ]),
      category('Signature Pizzas', [
        item('Cheesy Star — Large', 2200),
        item('Crown Crust — Large', 2200),
      ]),
      category('Pizza', [
        item('Fajita Pizza — Medium', 1500),
        item('Fajita Pizza — Large', 2000),
        item('Classic Pepperoni — Medium', 1500),
        item('Classic Pepperoni — Large', 2000),
      ]),
      category('Delivery Charges', [item('Delivery Charge (Rs 200)', 200)]),
      category('Fries & Sides', [
        item('Fries — Regular', 300),
        item('Fries — Large', 450),
        item('Nuggets', 670),
      ]),
      category('Dips', [item('Garlic Mayo Dip', 100)]),
    ],
  };
}

/** The owner's offer as a v0.7.50 till stores it: 10% off, delivery too, regular pizzas 20%. */
const OFFER: PublishedPickup = {
  offered: true,
  percent: 10,
  alsoDelivery: true,
  categoryPercents: [{ categoryId: PIZZA, percent: 20 }],
};
const ON = { buy1Get1: DEFAULT_BUY_1_GET_1_RULES };
const rowsOf = (s: HeroSlide) =>
  s.rows.map((r) => [
    r.name,
    r.wasCents === null ? null : r.wasCents / 100,
    r.priceCents / 100,
    r.from,
  ]);

describe('the slides, worked out from the published menu and the owner’s offer (lib/hero-deals)', () => {
  it('today: each burger deal, 20% off regular pizzas, the pizza deals, Buy 1 Get 1, 10% off the rest — in that order', () => {
    const slides = heroSlides(todaysMenu(), { ...ON, pickup: OFFER });
    expect(slides.map((s) => [s.kind, s.group, s.tab, s.title])).toEqual([
      ['burger-deal', 'burger-deals', 'Burger deals', 'Classic Crispy Deal'],
      ['burger-deal', 'burger-deals', 'Burger deals', 'Signature Cripsy Deal'],
      ['burger-deal', 'burger-deals', 'Burger deals', 'Cheese Dipped Deal'],
      ['category-offer', `category-offer-${PIZZA}`, '20% off pizzas', '20% off regular pizzas'],
      ['pizza-deals', 'pizza-deals', 'Pizza deals', 'Pizza deals'],
      ['buy-1-get-1', 'buy-1-get-1', 'Buy 1 Get 1', 'Buy 1 Get 1 free'],
      ['online-offer', 'online-offer', '10% off online', '10% off online orders'],
    ]);
    const [classic, signature, cheese, pizza20, pizzaDeals, buy1Get1, online] =
      slides as HeroSlide[];
    // Each burger deal: its own meal photo (the foodpanda chat's), its price big, no rows.
    expect(
      [classic, signature, cheese].map((s) => [
        s!.price,
        s!.photo,
        s!.line,
        s!.rows.length,
        s!.href,
      ]),
    ).toEqual([
      [
        { cents: 85_000, pickupOnly: false },
        HERO_PHOTOS.classicCrispyMeal,
        'Burger, regular fries and a 345 ml drink',
        0,
        '/menu#value-deals',
      ],
      [
        { cents: 95_000, pickupOnly: false },
        HERO_PHOTOS.signatureCrispyMeal,
        'Burger, regular fries and a 345 ml drink',
        0,
        '/menu#value-deals',
      ],
      [
        { cents: 105_000, pickupOnly: false },
        HERO_PHOTOS.cheeseDippedMeal,
        'Burger, regular fries and a 345 ml drink',
        0,
        '/menu#value-deals',
      ],
    ]);
    // 20% off regular pizzas: every size's price before and after (the user: "the prices should be mention").
    expect(rowsOf(pizza20!)).toEqual([
      ['Medium 9"', 1500, 1200, false],
      ['Large 12"', 2000, 1600, false],
    ]);
    expect([pizza20!.line, pizza20!.href, pizza20!.photo, pizza20!.cta]).toEqual([
      'Online, on pick-up and delivery',
      '/menu#regular-pizzas',
      HERO_PHOTOS.regularPizzas,
      'Order a pizza',
    ]);
    // The pizza deals: cheapest first, what is in each, never its drink; their own price (deals take no %).
    expect(pizzaDeals!.rows.map((r) => [r.name, r.what, r.priceCents / 100, r.wasCents])).toEqual([
      ['Perfect Pair', '2 Medium 9"', 2600, null],
      ['Family Feast', '1 Medium 9" + 1 Large 12"', 3100, null],
      ['Big Two', '2 Large 12"', 3600, null],
    ]);
    expect(pizzaDeals!.line).toBe('Your choice of regular pizzas, with a 1 litre soft drink');
    expect([buy1Get1!.line, buy1Get1!.href, rowsOf(buy1Get1!)]).toEqual([
      '1–7 PM only',
      '/menu#buy-1-get-1-deals',
      [
        ['Medium + Free Side', null, 1500, false],
        ['Large + Free Burger or Side', null, 2000, false],
        ['Large + Free Medium', null, 2000, false],
      ],
    ]);
    // 10% off the rest: each section's lowest price before and after — never the deals, the charge or the pizzas
    // that have their own %; three sections.
    expect(rowsOf(online!)).toEqual([
      ['Burgers', 700, 630, true],
      ['Signature Pizzas', 2200, 1980, false],
      ['Fries & Sides', 300, 270, true],
    ]);
    expect([online!.line, online!.href, online!.photo]).toEqual([
      'On the rest of the menu. Not on value deals.',
      '/menu',
      HERO_PHOTOS.onlineOffer,
    ]);
  });

  it('no block stored: no % slide at all (the till’s heartbeat alone decides then); the deals as they are', () => {
    for (const pickup of [undefined, null]) {
      expect(heroSlides(todaysMenu(), { ...ON, pickup }).map((s) => s.kind)).toEqual([
        'burger-deal',
        'burger-deal',
        'burger-deal',
        'pizza-deals',
        'buy-1-get-1',
      ]);
    }
  });

  it('the % slides say where the % comes off, and only while it comes off somewhere', () => {
    const at = (pickup: PublishedPickup) =>
      heroSlides(todaysMenu(), { ...ON, pickup }).filter(
        (s) => s.kind === 'category-offer' || s.kind === 'online-offer',
      );
    // Pick-up only, no category: "10% off pick-up orders", the regular pizzas among its sections.
    const pickupOnly = at({ offered: true, percent: 10 });
    expect(pickupOnly.map((s) => [s.title, s.line])).toEqual([
      ['10% off pick-up orders', 'On the menu. Not on value deals.'],
    ]);
    expect(pickupOnly[0]!.rows.map((r) => r.name)).toEqual([
      'Burgers',
      'Signature Pizzas',
      'Regular Pizzas',
    ]);
    // Delivery only (pick-up switched off, "also on delivery orders" ticked).
    expect(
      at({
        offered: false,
        percent: 10,
        alsoDelivery: true,
        categoryPercents: OFFER.categoryPercents,
      }).map((s) => [s.title, s.line]),
    ).toEqual([
      ['20% off regular pizzas', 'Online, on delivery'],
      ['10% off delivery orders', 'On the rest of the menu. Not on value deals.'],
    ]);
    // Nowhere (pick-up off, deliveries at full price): none; a 0% main %: the category's own only.
    expect(at({ offered: false, percent: 10, categoryPercents: OFFER.categoryPercents })).toEqual(
      [],
    );
    expect(
      at({ offered: true, percent: 0, categoryPercents: OFFER.categoryPercents }).map(
        (s) => s.title,
      ),
    ).toEqual(['20% off regular pizzas']);
  });

  it('a pizza size at two prices reads "from" the lowest; a category with no sizes lists its items', () => {
    const m = todaysMenu();
    const pizza = m.categories.find((c) => c.posCategoryId === PIZZA)!;
    pizza.items.push(item('Malai Supreme — Large', 2200));
    const slide = heroSlides(m, { ...ON, pickup: OFFER }).find((s) => s.kind === 'category-offer')!;
    expect(rowsOf(slide)).toEqual([
      ['Medium 9"', 1500, 1200, false],
      ['Large 12"', 2000, 1600, true],
    ]);
    const burgers = m.categories.find((c) => c.name === 'Burgers')!;
    const own = heroSlides(m, {
      ...ON,
      pickup: {
        offered: true,
        percent: 10,
        categoryPercents: [{ categoryId: burgers.posCategoryId, percent: 15 }],
      },
    }).find((s) => s.kind === 'category-offer')!;
    expect([own.title, own.tab, own.photo, own.cta]).toEqual([
      '15% off burgers',
      '15% off burgers',
      HERO_PHOTOS.buy1Get1,
      'Order now',
    ]);
    // Rounded once per price, as the till rounds a % (Rs 950 less 15% = Rs 807.50 → Rs 808 to pay).
    expect(rowsOf(own)).toEqual([
      ['Classic Crispy Chicken', 700, 595, false],
      ['Crispy Signature', 800, 680, false],
      ['Signature Cheese Dipped', 900, 765, false],
      ['Nashville Authentic (Hot)', 950, 807.5, false],
    ]);
  });

  it('Buy 1 Get 1 switched off on the till: no slide for it, as /menu sells none; its hours are the owner’s', () => {
    expect(
      heroSlides(todaysMenu(), { buy1Get1: { ...DEFAULT_BUY_1_GET_1_RULES, on: false } }).some(
        (s) => s.kind === 'buy-1-get-1',
      ),
    ).toBe(false);
    const at = (opensMinute: number, closesMinute: number) =>
      heroSlides(todaysMenu(), { buy1Get1: { on: true, opensMinute, closesMinute } }).find(
        (s) => s.kind === 'buy-1-get-1',
      )!.line;
    expect(at(12 * 60, 16 * 60)).toBe('12–4 PM only');
    expect(at(22 * 60, 25 * 60)).toBe('10 PM–1 AM only');
    expect(at(0, 1440)).toBe('All day');
  });

  it('the menu unknown, or nothing to show: no slides; a burger deal with no photo of its own: the crispy burger', () => {
    expect(heroSlides(null, { ...ON, pickup: OFFER })).toEqual([]);
    expect(
      heroSlides({ categories: [category('Dips', [item('Garlic Mayo Dip', 100)])] }, ON),
    ).toEqual([]);
    const other = heroSlides(
      {
        categories: [
          category('Value Deals', [
            item('Zinger Deal', 900, 'Zinger burger + fries + 345 ml drink'),
          ]),
        ],
      },
      ON,
    );
    expect(other.map((s) => [s.title, s.photo, s.line])).toEqual([
      ['Zinger Deal', HERO_PHOTOS.burgerMeal, 'Burger, fries and a 345 ml drink'],
    ]);
  });

  it('never a zero price; at most four rows, the rest counted; pick-up only said; never a drink brand', () => {
    const slides = heroSlides(
      {
        categories: [
          category('Deals', [
            item('Test Pizza Deal A', 2000, '2 Medium 9" regular pizzas + 1 litre Pepsi.'),
            item('Test Pizza Deal B', 2100, '2 Medium 9" regular pizzas + 1 litre soft drink', {
              pickupOnly: true,
            }),
            item('Test Pizza Deal C', 0, 'A pizza'),
            item('Test Pizza Deal D', 2200, 'A pizza'),
            item('Test Pizza Deal E', 2300, 'A pizza'),
            item('Test Pizza Deal F', 2400, 'A pizza'),
          ]),
          category('Value Deals', [item('Test Burger Deal', 0, 'Burger + fries + drink')]),
        ],
      },
      ON,
    );
    expect(slides.map((s) => s.kind)).toEqual(['pizza-deals']);
    const deals = slides[0]!;
    expect(deals.rows).toHaveLength(HERO_ROWS_MAX);
    expect(deals.rows.map((r) => [r.name, r.priceCents / 100, r.pickupOnly])).toEqual([
      ['Test Pizza Deal A', 2000, false],
      ['Test Pizza Deal B', 2100, true],
      ['Test Pizza Deal D', 2200, false],
      ['Test Pizza Deal E', 2300, false],
    ]);
    expect(deals.more).toBe(1);
    expect(deals.rows[0]!.what).toBe('2 Medium 9" regular pizzas');
    expect(JSON.stringify(slides)).not.toMatch(/pepsi/i);
  });
});

describe('the slider’s markup (components/HeroDealsClient), as the server renders it', () => {
  const html = renderToStaticMarkup(
    React.createElement(HeroDealsClient, {
      slides: heroSlides(todaysMenu(), { ...ON, pickup: OFFER }),
    }),
  );

  it('a carousel of slides; a tab per kind (the burger deals: one tab, a line each); the first picked; the pause button first', () => {
    expect(html).toContain(
      'role="region" aria-roledescription="carousel" aria-label="Deals and offers"',
    );
    expect(html.indexOf('aria-label="Pause the deals"')).toBeLessThan(
      html.indexOf('role="tabpanel"'),
    );
    expect(
      [...html.matchAll(/role="tabpanel" aria-roledescription="slide" aria-label="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    ).toEqual([
      '1 of 7: Classic Crispy Deal',
      '2 of 7: Signature Cripsy Deal',
      '3 of 7: Cheese Dipped Deal',
      '4 of 7: 20% off regular pizzas',
      '5 of 7: Pizza deals',
      '6 of 7: Buy 1 Get 1 free',
      '7 of 7: 10% off online orders',
    ]);
    const tabs = [
      ...html.matchAll(
        /<button type="button" role="tab" id="hero-deal-tab-([a-z0-9-]+)" aria-controls="([^"]+)" aria-selected="(true|false)" tabindex="(0|-1)"/g,
      ),
    ];
    expect(tabs.map((m) => [m[1], m[2]!.split(' ').length, m[3], m[4]])).toEqual([
      ['burger-deals', 3, 'true', '0'],
      [`category-offer-${PIZZA}`, 1, 'false', '-1'],
      ['pizza-deals', 1, 'false', '-1'],
      ['buy-1-get-1', 1, 'false', '-1'],
      ['online-offer', 1, 'false', '-1'],
    ]);
    // The server's HTML never animates (the timer starts once the page is live): every line empty.
    expect(html).not.toContain('hero-deal-fill');
    expect(html.split('transform:scaleX(0)').length - 1).toBe(7);
  });

  it('a burger deal’s own photo and price; an offer’s price before (struck) and after; the first photo loads first', () => {
    const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(imgs).toHaveLength(7);
    expect(imgs[0]).toContain('src="/images/hero/deal-classic-crispy-cola.webp"');
    expect(imgs.map((i) => /loading="(eager|lazy)"/.exec(i)![1])).toEqual([
      'eager',
      'eager',
      'lazy',
      'lazy',
      'lazy',
      'lazy',
      'lazy',
    ]);
    expect(imgs.map((i) => i.includes('fetchPriority="high"'))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(html).toContain('>Rs 850</span>');
    expect(html).toContain('<s class="mr-1.5 text-base font-semibold text-cream/45">Rs 1,500</s>');
    expect(html).toContain('>Rs 1,200</span>');
    expect(html).toContain('>Rs 1,600</span>');
    expect(html).not.toMatch(/Rs 0(?![\d,])/);
  });

  it('one slide: no tabs and no pause button — a plain group; none: nothing', () => {
    const one = heroSlides({ categories: [todaysMenu().categories[2]!] }, ON);
    const single = renderToStaticMarkup(React.createElement(HeroDealsClient, { slides: one }));
    expect(single).toContain(
      'role="group" aria-roledescription="slide" aria-label="1 of 1: Buy 1 Get 1 free"',
    );
    expect(single).not.toContain('role="tab"');
    expect(single).not.toContain('Pause the deals');
    expect(renderToStaticMarkup(React.createElement(HeroDealsClient, { slides: [] }))).toBe('');
  });
});
