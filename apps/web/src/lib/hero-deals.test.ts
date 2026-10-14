/**
 * The home hero's deals slider (the user, 14 Oct 2026): one slide per kind of
 * deal on the published menu — burger deals, pizza deals, Buy 1 Get 1 (while
 * on) and the burgers — with the menu's names and prices, cheapest first, and
 * the markup it draws (lib/hero-deals, components/HeroDealsClient). Every id
 * and description here is made up; the names and prices are today's.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUY_1_GET_1_RULES,
  type PublishedMenuCategory,
  type PublishedMenuItem,
} from '@cheeseoclock/shared-types';
import { HERO_PHOTOS, HERO_ROWS_MAX, heroSlides } from './hero-deals';

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
const category = (
  name: string,
  items: PublishedMenuItem[],
  id = name.toLowerCase().replace(/\W+/g, '-'),
): PublishedMenuCategory => ({
  posCategoryId: `test-cat-${id}`,
  name,
  displayOrder: 0,
  items,
});

/** Today's menu as far as the slider reads it (the till's order: the pizza deals dearest first). */
function todaysMenu(): { categories: PublishedMenuCategory[] } {
  return {
    categories: [
      category('Value Deals', [
        item('Classic Crispy Deal', 850, '1 Classic Crispy+ 1 Regular Fries+ 345ml Drink', {
          noDiscount: true,
        }),
        item('Signature Crispy Deal', 950, '1 Signature Crispy+ Regular Fries+ 345ml Drink', {
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
          'Thigh-marinated crispy fillet, mayonnaise and lettuce in a buttered brioche bun.',
        ),
        item(
          'Crispy Signature',
          800,
          'Thigh-marinated crispy fillet, signature sauce and lettuce in a buttered brioche bun.',
        ),
        item(
          'Signature Cheese Dipped',
          900,
          'Fillet dunked in molten cheese, with signature sauce in a brioche bun.',
        ),
        item(
          'Nashville Authentic (Hot)',
          950,
          'Nashville hot fillet and Nashville sauce, cooled by coleslaw and pickle in a brioche bun.',
        ),
      ]),
      category('Buy 1 Get 1 Deals', [
        item(
          'Large + Free Burger or Side',
          2000,
          'Any Large 12" regular pizza + any burger (not the Nashville) or any side FREE.',
        ),
        item(
          'Large + Free Medium',
          2000,
          'Any Large 12" regular pizza + any Medium 9" regular pizza FREE.',
        ),
        item(
          'Medium + Free Side',
          1500,
          'Any Medium 9" regular pizza + any side FREE (not Loaded Fries).',
        ),
      ]),
      category('Signature Pizzas', [item('Cheesy Star — Large', 2200)]),
      category('Delivery Charges', [item('Delivery Charge (Rs 200)', 200)]),
    ],
  };
}

const ON = { buy1Get1: DEFAULT_BUY_1_GET_1_RULES };
const rowsOf = (slide: { rows: Array<{ name: string; priceCents: number }> }) =>
  slide.rows.map((r) => [r.name, r.priceCents / 100]);

describe('the slides, worked out from the published menu (lib/hero-deals)', () => {
  it('today’s menu: burger deals, pizza deals, Buy 1 Get 1, burgers — the menu’s names and prices, cheapest first', () => {
    const slides = heroSlides(todaysMenu(), ON);
    expect(slides.map((s) => [s.kind, s.title, s.tab, s.tone, s.href])).toEqual([
      ['burger-deals', 'Burger deals', 'Burger deals', 'ink', '/menu#value-deals'],
      ['pizza-deals', 'Pizza deals', 'Pizza deals', 'cheese', '/menu#value-deals'],
      ['buy-1-get-1', 'Buy 1 Get 1 free', 'Buy 1 Get 1', 'ink', '/menu#buy-1-get-1-deals'],
      ['burgers', 'Burgers', 'Burgers', 'ink', '/menu#burgers'],
    ]);
    const [burgerDeals, pizzaDeals, buy1Get1, burgers] = slides;
    // A deal's trailing "Deal" dropped under "Burger deals".
    expect(rowsOf(burgerDeals!)).toEqual([
      ['Classic Crispy', 850],
      ['Signature Crispy', 950],
      ['Cheese Dipped', 1050],
    ]);
    expect(burgerDeals!.line).toBe('Burger, regular fries and a 345 ml drink');
    // Cheapest first (the till lists them dearest first), each with what is in it, never its drink.
    expect(pizzaDeals!.rows.map((r) => [r.name, r.what, r.priceCents / 100])).toEqual([
      ['Perfect Pair', '2 Medium 9"', 2600],
      ['Family Feast', '1 Medium 9" + 1 Large 12"', 3100],
      ['Big Two', '2 Large 12"', 3600],
    ]);
    expect(pizzaDeals!.line).toBe('Your choice of regular pizzas, with a 1 litre soft drink');
    expect(rowsOf(buy1Get1!)).toEqual([
      ['Medium + Free Side', 1500],
      ['Large + Free Burger or Side', 2000],
      ['Large + Free Medium', 2000],
    ]);
    expect(buy1Get1!.line).toBe('1–7 PM only');
    expect(rowsOf(burgers!)).toEqual([
      ['Classic Crispy Chicken', 700],
      ['Crispy Signature', 800],
      ['Signature Cheese Dipped', 900],
      ['Nashville Authentic (Hot)', 950],
    ]);
    expect(burgers!.line).toBe('Crispy chicken fillet in a brioche bun');
    // The user's four photos, one per kind; every slide's words are clickable to its own section.
    expect(slides.map((s) => s.photo)).toEqual([
      HERO_PHOTOS['burger-deals'],
      HERO_PHOTOS['pizza-deals'],
      HERO_PHOTOS['buy-1-get-1'],
      HERO_PHOTOS.burgers,
    ]);
    expect(slides.map((s) => s.cta)).toEqual([
      'Order a burger deal',
      'Order a pizza deal',
      'Order Buy 1 Get 1',
      'Order a burger',
    ]);
    expect(slides.every((s) => s.more === 0 && s.rows.every((r) => !r.pickupOnly))).toBe(true);
  });

  it('Buy 1 Get 1 switched off on the till: no slide for it, as /menu sells none; its hours are the owner’s', () => {
    expect(
      heroSlides(todaysMenu(), { buy1Get1: { ...DEFAULT_BUY_1_GET_1_RULES, on: false } }).map(
        (s) => s.kind,
      ),
    ).toEqual(['burger-deals', 'pizza-deals', 'burgers']);
    const at = (opensMinute: number, closesMinute: number) =>
      heroSlides(todaysMenu(), { buy1Get1: { on: true, opensMinute, closesMinute } }).find(
        (s) => s.kind === 'buy-1-get-1',
      )!.line;
    expect(at(12 * 60, 16 * 60)).toBe('12–4 PM only');
    expect(at(22 * 60, 25 * 60)).toBe('10 PM–1 AM only');
    expect(at(0, 1440)).toBe('All day');
  });

  it('the menu unknown, or nothing of these kinds on it: no slides; a kind the menu lacks has no slide', () => {
    expect(heroSlides(null, ON)).toEqual([]);
    expect(
      heroSlides(
        { categories: [category('Signature Pizzas', [item('Cheesy Star — Large', 2200)])] },
        ON,
      ),
    ).toEqual([]);
    const m = todaysMenu();
    const noBurgerDeals = {
      categories: m.categories.map((c) =>
        c.name === 'Value Deals' ? { ...c, items: c.items.slice(3) } : c,
      ),
    };
    expect(heroSlides(noBurgerDeals, ON).map((s) => s.kind)).toEqual([
      'pizza-deals',
      'buy-1-get-1',
      'burgers',
    ]);
  });

  it('never a zero price; at most four rows, the rest counted; pick-up only said; never a drink brand', () => {
    const slides = heroSlides(
      {
        categories: [
          category('Burgers', [
            item('Test Burger A', 700),
            item('Test Burger B', 800, null, { pickupOnly: true }),
            item('Test Burger C', 0),
            item('Test Burger D', 900),
            item('Test Burger E', 950),
            item('Test Burger F', 990),
            item('Test Burger G', 1000),
          ]),
          category('Deals', [
            item('Test Pizza Deal', 2000, '2 Medium 9" regular pizzas + 1 litre Pepsi.'),
          ]),
        ],
      },
      ON,
    );
    const burgers = slides.find((s) => s.kind === 'burgers')!;
    expect(burgers.rows).toHaveLength(HERO_ROWS_MAX);
    expect(rowsOf(burgers)).toEqual([
      ['Test Burger A', 700],
      ['Test Burger B', 800],
      ['Test Burger D', 900],
      ['Test Burger E', 950],
    ]);
    expect(burgers.more).toBe(2);
    expect(burgers.rows.map((r) => r.pickupOnly)).toEqual([false, true, false, false]);
    // A description with no brioche: no line under the heading.
    expect(burgers.line).toBeNull();
    const deal = slides.find((s) => s.kind === 'pizza-deals')!;
    expect(deal.rows[0]!.what).toBe('2 Medium 9" regular pizzas');
    expect(JSON.stringify(slides)).not.toMatch(/pepsi/i);
  });

  it('the line under a heading only when every row bears it out; a deal naming no pizza makes them "Value deals"', () => {
    const slides = heroSlides(
      {
        categories: [
          category('Value Deals', [
            item('Test Crispy Deal', 850, 'Test Crispy burger + Regular Fries + 345 ml drink'),
            item('Test Zinger Deal', 900, 'Test Zinger burger + fries + 1 litre drink'),
            item('Test Pizza Deal', 2600, '2 Medium 9" regular pizzas + 1 litre soft drink'),
            item('Test Wings Bucket', 1800, '12 wings + 1 litre soft drink'),
          ]),
        ],
      },
      ON,
    );
    expect(slides.map((s) => [s.kind, s.title, s.line, s.cta])).toEqual([
      ['burger-deals', 'Burger deals', 'Burger, fries and a drink', 'Order a burger deal'],
      ['pizza-deals', 'Value deals', null, 'Order a value deal'],
    ]);
    // (Its trailing "Deal" dropped under the "Value deals" heading too.)
    expect(rowsOf(slides[1]!)).toEqual([
      ['Test Wings Bucket', 1800],
      ['Test Pizza', 2600],
    ]);
  });
});

describe('the slider’s markup (components/HeroDealsClient), as the server renders it', () => {
  const html = renderToStaticMarkup(
    React.createElement(HeroDealsClient, { slides: heroSlides(todaysMenu(), ON) }),
  );

  it('a carousel of slides, a tab per slide, the first one picked; the pause button first; nothing turning before the page is live', () => {
    expect(html).toContain('role="region" aria-roledescription="carousel" aria-label="Deals"');
    expect(html.indexOf('aria-label="Pause the deals"')).toBeLessThan(
      html.indexOf('role="tabpanel"'),
    );
    expect(
      [...html.matchAll(/role="tabpanel" aria-roledescription="slide" aria-label="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    ).toEqual([
      '1 of 4: Burger deals',
      '2 of 4: Pizza deals',
      '3 of 4: Buy 1 Get 1 free',
      '4 of 4: Burgers',
    ]);
    const tabs = [
      ...html.matchAll(
        /<button type="button" role="tab" id="hero-deal-tab-([a-z0-9-]+)" aria-controls="hero-deal-\1" aria-selected="(true|false)" tabindex="(0|-1)"/g,
      ),
    ];
    expect(tabs.map((m) => [m[1], m[2], m[3]])).toEqual([
      ['burger-deals', 'true', '0'],
      ['pizza-deals', 'false', '-1'],
      ['buy-1-get-1', 'false', '-1'],
      ['burgers', 'false', '-1'],
    ]);
    // The server's HTML never animates (the timer starts once the page is live): every line empty.
    expect(html).not.toContain('hero-deal-fill');
    expect(html.split('transform:scaleX(0)').length - 1).toBe(4);
  });

  it('the first photo loads at once and first; the next one too; the rest when the slider nears them', () => {
    const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(imgs).toHaveLength(4);
    expect(imgs.map((i) => /loading="(eager|lazy)"/.exec(i)![1])).toEqual([
      'eager',
      'eager',
      'lazy',
      'lazy',
    ]);
    expect(imgs.map((i) => i.includes('fetchPriority="high"'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(imgs[0]).toContain(
      'srcSet="/images/hero/sm/crispy-burger.webp 640w, /images/hero/crispy-burger.webp 843w"',
    );
    expect(imgs.every((i) => /alt="[^"]{12,}"/.test(i))).toBe(true);
  });

  it('the menu’s prices as the site prints them, each slide’s button to its section; never a zero price', () => {
    for (const price of ['Rs 850', 'Rs 1,050', 'Rs 2,600', 'Rs 3,600', 'Rs 1,500', 'Rs 950'])
      expect(html).toContain(`>${price}</span>`);
    expect(html).toContain('href="/menu#value-deals"');
    expect(html).toContain('href="/menu#buy-1-get-1-deals"');
    expect(html).toContain('href="/menu#burgers"');
    expect(html).not.toMatch(/Rs 0(?![\d,])/);
  });

  it('one slide: no tabs and no pause button — a plain group; none: nothing', () => {
    const one = heroSlides({ categories: [todaysMenu().categories[1]!] }, ON);
    const single = renderToStaticMarkup(React.createElement(HeroDealsClient, { slides: one }));
    expect(single).toContain(
      'role="group" aria-roledescription="slide" aria-label="1 of 1: Burgers"',
    );
    expect(single).not.toContain('role="tab"');
    expect(single).not.toContain('Pause the deals');
    expect(renderToStaticMarkup(React.createElement(HeroDealsClient, { slides: [] }))).toBe('');
  });
});
