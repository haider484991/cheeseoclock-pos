/**
 * The ordering page's client components as the server renders them (static
 * markup: effects do not run, so this is what the page is SERVED): the
 * /menu closed banner with the owner's notice, the /menu header's
 * announcement, a size set "Pick-up only" on the card and in the choices
 * sheet, and the cart's smallest-delivery-order note (v0.7.30, sweep B1 + B5).
 * Every name and amount is made up.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { PublishedMenuItem, PublishedModifierGroup } from '@cheeseoclock/shared-types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
}));

// The components are JSX compiled for React in scope (as Next does it): give the test the same.
const React = await import('react');
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = await import('react-dom/server');
const { OrderingApp } = await import('@/components/OrderingApp');
const { ItemSheet } = await import('@/components/ordering/ItemSheet');
const { MinimumNote } = await import('@/components/ordering/cart-ui');
const { DEFAULT_FACTS, copyText } = await import('@/lib/delivery-facts');
const { DEFAULT_SHOP_FACTS } = await import('@/lib/shop-facts');
const { HOME_HERO_HOURS } = await import('@/lib/page-copy');
const { buildMenuView, cartDeals, sizeOrderable } = await import('@/lib/menu-view');
const { publicMenu } = await import('@/lib/public-menu');
const { cartLineKey, cartPricedLines } = await import('@/lib/cart');
const { priceOrder } = await import('@/lib/pricing');
const { OFFER_FINE_PRINT, OFFER_RULES } = await import('@/lib/offers');

type AppProps = Parameters<typeof OrderingApp>[0];
type CartProps = Parameters<typeof MinimumNote>[0];

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

const STORE = { name: 'Test Shop', phone: null, whatsapp: null, addressLine: null, tagline: null };

/** A pizza in two sizes, the Large set "Pick-up only" on the till, and a side. */
const MENU = publicMenu({
  categories: [
    {
      posCategoryId: 'c-pizza',
      name: 'Test Pizzas',
      displayOrder: 0,
      items: [
        item('pz-m', 'Test Pizza — Medium', 900, { sortOrder: 1 }),
        item('pz-l', 'Test Pizza — Large', 1400, { sortOrder: 2, pickupOnly: true }),
      ],
    },
    { posCategoryId: 'c-side', name: 'Test Sides', displayOrder: 1, items: [item('side', 'Test Fries', 300)] },
  ],
  publishedAt: '2026-09-27T09:00:00.000Z',
  store: STORE,
});

/** The same menu with a value deal a v0.7.34 till marks (no discount comes off it). */
const DEALS_MENU = publicMenu({
  categories: [
    ...MENU.categories,
    { posCategoryId: 'c-deals', name: 'Test Deals', displayOrder: 2, items: [item('deal', 'Test Deal', 3600, { noDiscount: true })] },
  ],
  publishedAt: '2026-09-27T09:00:00.000Z',
  store: STORE,
});

/** Today's closed line on /menu as served (no notice; 24 Oct 2026: one slim line, the hours in it). */
const TODAY_CLOSED = 'Online orders closed (open daily · 1 pm – 1 am)';

function app(over: Partial<AppProps> = {}): string {
  const props: AppProps = {
    menu: MENU,
    acceptingOrders: false,
    pickupAvailable: false,
    pickupDiscountPercent: 10,
    deliveryFacts: DEFAULT_FACTS,
    ...over,
  };
  return renderToStaticMarkup(React.createElement(OrderingApp, props));
}

describe('/menu as served', () => {
  it('closed with the owner’s notice: the line says the notice instead of the shop’s words; WhatsApp stays', () => {
    const html = app({ closedNotice: 'Test closed for a holiday until Monday' });
    expect(html).toContain('Test closed for a holiday until Monday');
    expect(html).not.toContain(TODAY_CLOSED);
    expect(html).toMatch(/aria-label="WhatsApp 0300 9367865"[^>]*>/);
  });

  it('closed with no notice: today’s words', () => {
    expect(app()).toContain(TODAY_CLOSED);
  });

  it('the announcement shows in the header only when the facts carry it', () => {
    expect(app({ deliveryFacts: { ...DEFAULT_FACTS, announcement: 'Test new wrap this week' } })).toContain('Test new wrap this week');
    expect(app()).not.toContain('★');
  });

  it('the header’s hours chip names the days when the shop is not open every day, as the home page’s chip does; every day, the hours alone as before', () => {
    // The header's line of facts (20 Oct 2026: the cleaner menu) starts with the hours, after their icon.
    const chip = (html: string) => /<ul aria-label="Hours and payment"[^>]*><li[^>]*><svg[^]*?<\/svg><span>([^<]*)<\/span><\/li>/.exec(html)?.[1];
    // Today's (open every day): the hours alone, exactly as v0.7.30 printed them.
    expect(chip(app())).toBe('1 pm – 1 am');
    // The owner's made-up hours, closed on Mondays: the days follow, in the home chip's words.
    const tueToSun = { ...DEFAULT_SHOP_FACTS, source: 'settings' as const, hours: { opens: '11:00', closes: '23:00', days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } };
    expect(chip(app({ shop: tueToSun }))).toBe('11 am – 11 pm · Tue–Sun');
    expect(chip(app({ shop: tueToSun }))).toBe(copyText(HOME_HERO_HOURS, { ...DEFAULT_FACTS, shop: tueToSun }));
    const weekends = { ...tueToSun, hours: { ...tueToSun.hours, days: ['sat', 'sun'] as ['sat', 'sun'] } };
    expect(chip(app({ shop: weekends }))).toBe('11 am – 11 pm · Sat, Sun');
    // The same hours every day: no days, and never "daily" (the chip reads as it always has).
    const everyDay = { ...tueToSun, hours: { ...DEFAULT_SHOP_FACTS.hours, opens: '11:00', closes: '23:00' } };
    expect(chip(app({ shop: everyDay }))).toBe('11 am – 11 pm');
  });

  it('the pick-up chip says value deals are left out only while the menu marks one (v0.7.34); with pick-up off, no chip as before', () => {
    // The header's first gold chip (20 Oct 2026: the money off has a list of its own).
    const chip = (html: string) => /<ul aria-label="Money off online"[^>]*><li class="rounded-full bg-cheese px-3 py-1 text-ink">([^<]*)<\/li>/.exec(html)?.[1];
    expect(chip(app({ acceptingOrders: true, pickupAvailable: true }))).toBe('10% off when you order online &amp; pick up');
    expect(chip(app({ acceptingOrders: true, pickupAvailable: true, menu: DEALS_MENU }))).toBe('10% off online pick-up · not on value deals');
    expect(chip(app({ acceptingOrders: true, pickupAvailable: true, menu: DEALS_MENU, pickupDiscountPercent: 15 }))).toBe(
      '15% off online pick-up · not on value deals',
    );
    expect(chip(app({ acceptingOrders: true, pickupAvailable: false, menu: DEALS_MENU }))).toBeUndefined();
  });

  it('one size pick-up only, pick-up off: the Large is a dashed "Pick-up only" chip, the Medium stays a button', () => {
    const html = app({ acceptingOrders: true, pickupAvailable: false });
    const card = html.slice(html.indexOf('Test Pizza'), html.indexOf('Test Fries'));
    expect(card).toContain('border-dashed');
    expect(card.match(/<button/g) ?? []).toHaveLength(1);
    expect(card).toMatch(/Medium/);
  });
});

/** A menu set like the shop's: Buy 1 Get 1 deals, a burger, a regular pizza in two sizes, and nine dips (one with words). */
const SHOP_MENU = publicMenu({
  categories: [
    { posCategoryId: 'c-b1g1', name: 'Buy 1 Get 1 Deals', displayOrder: 0, items: [item('b1g1', 'Test Large + Free Side', 2000)] },
    { posCategoryId: 'c-burger', name: 'Burgers', displayOrder: 1, items: [item('burger', 'Test Crispy Burger', 700)] },
    {
      posCategoryId: 'c-pizza',
      name: 'Pizza',
      displayOrder: 2,
      items: [
        item('fj-m', 'Test Fajita — Medium', 1500, { sortOrder: 1 }),
        item('fj-l', 'Test Fajita — Large', 2000, { sortOrder: 2 }),
      ],
    },
    {
      posCategoryId: 'c-dips',
      name: 'Dips',
      displayOrder: 3,
      items: [
        item('dip-0', 'Test House Dip', 100, { description: 'Test words about the house dip.' }),
        ...Array.from({ length: 8 }, (_, i) => item(`dip-${i + 1}`, `Test Dip ${i + 1}`, 100, { sortOrder: i + 1 })),
      ],
    },
  ],
  publishedAt: '2026-10-20T09:00:00.000Z',
  store: STORE,
});

describe('the cleaner menu (20 Oct 2026: "too much information" in the header)', () => {
  const open = (over: Partial<AppProps> = {}) => app({ menu: SHOP_MENU, acceptingOrders: true, pickupAvailable: true, ...over });
  /** The page above the category pills: the header. */
  const header = (html: string) => html.slice(0, html.indexOf('aria-label="Menu sections"'));
  /** One card's markup, from its name to the next card. */
  const cardOf = (html: string, name: string) => {
    const at = html.indexOf(`>${name}`);
    expect(at, name).toBeGreaterThan(-1);
    const end = html.indexOf('</article>', at);
    return html.slice(html.lastIndexOf('<article', at), end);
  };
  const ALLERGY = DEFAULT_SHOP_FACTS.website.allergyNotice;

  it('the header: the title, one line of facts, the money off as chips — no tagline, no "Order online" line, no allergy words', () => {
    const top = header(open({ deliveryDiscountPercent: 10 }));
    expect(top).toContain('The Menu</h1>');
    expect(top).toMatch(/<ul aria-label="Hours and payment"[^]*1 pm – 1 am[^]*Cash on delivery/);
    // No delivery fee or area list in the header (user, 24 Oct 2026: "taking space"): the cart bar and the checkout
    // say the fee for the area chosen or found.
    expect(top).not.toContain('Delivery Rs 200–250');
    expect(top).toContain('>10% off every online order</li>');
    expect(DEFAULT_SHOP_FACTS.profile.tagline).not.toBe('');
    expect(top).not.toContain(DEFAULT_SHOP_FACTS.profile.tagline);
    expect(top).not.toContain('Order online · ');
    expect(top).not.toContain(ALLERGY);
  });

  it('the allergy words close the menu, once, after the last section (each item’s sheet and the checkout say them too)', () => {
    const html = open();
    expect(html.split(ALLERGY).length - 1).toBe(1);
    expect(html.indexOf(ALLERGY)).toBeGreaterThan(html.lastIndexOf('</section>'));
  });

  it('Buy 1 Get 1 in the header is one line: it jumps to the deals when the menu has them; else it opens to the rules', () => {
    const withDeals = header(open());
    expect(withDeals).toContain('href="#buy-1-get-1-deals"');
    expect(withDeals).toContain('Buy 1 Get 1 FREE, 12–7 PM: see the deals');
    expect(withDeals).not.toContain('<details');
    for (const rule of OFFER_RULES) expect(withDeals).not.toContain(rule.split(' → ')[1]!);
    // The deals' own section says "Delivery charges & tax may apply", in gold under its title.
    expect(open()).toContain(`>${OFFER_FINE_PRINT.replace('&', '&amp;')}</span></p></div>`);
    // A menu with no Buy 1 Get 1 deals yet: the line opens to both rules, the tag-us words and the fine print.
    const noDeals = header(app({ acceptingOrders: true, pickupAvailable: true }));
    expect(noDeals).toContain('<details class="group');
    for (const rule of OFFER_RULES) expect(noDeals).toContain(rule.split(' → ')[1]!);
    expect(noDeals).toContain(OFFER_FINE_PRINT.replace('&', '&amp;'));
    // Switched off by the owner: no line at all.
    const off = header(open({ deliveryFacts: { ...DEFAULT_FACTS, buy1Get1: { ...DEFAULT_FACTS.buy1Get1, on: false } } }));
    expect(off).not.toContain('Buy 1 Get 1');
  });

  it('every online order takes the %: the price buttons show the price after it, the menu price struck out', () => {
    const html = open({ deliveryDiscountPercent: 10 });
    const burger = cardOf(html, 'Test Crispy Burger');
    expect(burger).toContain('aria-label="Add Test Crispy Burger, Rs 630 (was Rs 700)"');
    expect(burger).toMatch(/<s class="[^"]*">Rs 700<\/s>/);
    expect(burger).toContain('>10% off</span>');
    const pizza = cardOf(html, 'Test Fajita');
    expect(pizza).toContain('aria-label="Add Test Fajita · Medium 9&quot;, Rs 1,350 (was Rs 1,500)"');
    expect(pizza).toContain('aria-label="Add Test Fajita · Large 12&quot;, Rs 1,800 (was Rs 2,000)"');
  });

  it('a % only pick-up takes: the buttons keep the menu prices, the card says the % and the pick-up price in words', () => {
    const burger = cardOf(open({ deliveryDiscountPercent: 0 }), 'Test Crispy Burger');
    expect(burger).toContain('aria-label="Add Test Crispy Burger, Rs 700"');
    expect(burger).not.toContain('<s ');
    expect(burger).toContain('>10% off with pick-up</span>');
    expect(burger).toContain('>Rs 630</span>');
  });

  it('a size the till marked "no discount" keeps its menu price on its button', () => {
    const menu = publicMenu({
      categories: SHOP_MENU.categories.map((c) =>
        c.name === 'Pizza' ? { ...c, items: c.items.map((i) => (i.posItemId === 'fj-m' ? { ...i, noDiscount: true } : i)) } : c,
      ),
      publishedAt: SHOP_MENU.publishedAt,
      store: STORE,
    });
    const pizza = cardOf(open({ menu, deliveryDiscountPercent: 10 }), 'Test Fajita');
    expect(pizza).toContain('aria-label="Add Test Fajita · Medium 9&quot;, Rs 1,500"');
    expect(pizza).toContain('aria-label="Add Test Fajita · Large 12&quot;, Rs 1,800 (was Rs 2,000)"');
  });

  it('Buy 1 Get 1 on a card is one tag that jumps to the deals; a regular pizza leaves the rule to them, a burger keeps its line', () => {
    const html = open();
    const pizza = cardOf(html, 'Test Fajita');
    expect(pizza).toContain('aria-label="BUY 1 GET 1 FREE · 12–7 PM: see the Buy 1 Get 1 deals"');
    expect(pizza).not.toContain('In a Buy 1 Get 1 deal');
    const burger = cardOf(html, 'Test Crispy Burger');
    expect(burger).toContain('href="#buy-1-get-1-deals"');
    expect(burger).toContain('With any Large pizza in a Buy 1 Get 1 deal');
  });

  it('the dips: two to a row on a phone; the one with words takes the whole row', () => {
    const html = open();
    const dips = html.slice(html.indexOf('id="dips"'));
    expect(dips).toContain('class="mt-4 grid gap-3 grid-cols-2 sm:grid-cols-3"');
    expect(cardOf(html, 'Test House Dip')).toContain('col-span-2 sm:col-span-3');
    expect(cardOf(html, 'Test Dip 1')).not.toContain('col-span-2');
    // Any other section as before: one to a row on a phone.
    expect(html.slice(html.indexOf('id="burgers"'), html.indexOf('id="dips"'))).toContain('class="mt-4 grid gap-3 sm:grid-cols-2"');
  });
});

describe('the cart’s smallest-delivery-order note', () => {
  function note(over: Partial<CartProps>): string {
    const props: CartProps = {
      cart: [{ key: 'k', item: item('side', 'Test Fries', 300), label: 'Test Fries', quantity: 1, modifierIds: [], notes: null }],
      subtotal: 30_000,
      deliveryFee: 0,
      discount: 0,
      zone: undefined,
      tax: 0,
      total: 30_000,
      setQty: () => {},
      onClear: () => {},
      fulfilment: 'delivery',
      canPickup: true,
      pickupPct: 10,
      onFulfilment: () => {},
      pickupOnlyInCart: [],
      feeRange: 'Rs 200–250',
      deliveryNote: '',
      minDeliveryOrderCents: 100_000,
      ...over,
    };
    return renderToStaticMarkup(React.createElement(MinimumNote, props));
  }

  it('a delivery under the minimum says how much more; a pick-up, or no minimum, says nothing', () => {
    expect(note({})).toContain('Rs 700');
    expect(note({ fulfilment: 'pickup' })).toBe('');
    expect(note({ minDeliveryOrderCents: 0 })).toBe('');
  });
});

describe('the cart’s totals: a value deal takes no share of the pick-up % (v0.7.34), as on the server', () => {
  const line = (i: PublishedMenuItem, quantity = 1, modifierIds: string[] = []) => ({
    key: cartLineKey(i.posItemId, modifierIds, null),
    item: i,
    label: i.name,
    quantity,
    modifierIds,
    notes: null,
  });
  const bigTwo = item('big-two', 'Test Big Two', 3600, { noDiscount: true });
  const veggie = item('veggie-l', 'Test Veggie — Large', 2000);
  const nuggets = item('nuggets', 'Test Nuggets', 670);

  it('the priced lines carry the flag on a value deal’s line only (no key on any other, so they price as before)', () => {
    const priced = cartPricedLines([line(bigTwo), line(veggie, 2), line(nuggets)]);
    expect(priced).toEqual([
      { lineTotalCents: 360_000, taxRateBps: 1500, noDiscount: true },
      { lineTotalCents: 400_000, taxRateBps: 1500 },
      { lineTotalCents: 67_000, taxRateBps: 1500 },
    ]);
    expect(priced.slice(1).some((p) => 'noDiscount' in p)).toBe(false);
  });

  it('the worked example at 15% tax, 10% off: Big Two 360,000 (a deal) + 200,000 + 67,000 → discount 26,700, tax 90,045, total 690,345', () => {
    const cart = [line(bigTwo), line(veggie), line(nuggets)];
    expect(priceOrder(cartPricedLines(cart), 10)).toEqual({ subtotalCents: 627_000, discountCents: 26_700, taxCents: 90_045, totalCents: 690_345 });
    expect(cartDeals(cart)).toEqual({ dealInCart: true, onlyDeals: false });
    // Deals only: nothing off, every line taxed in full.
    expect(priceOrder(cartPricedLines([line(bigTwo)]), 10)).toEqual({ subtotalCents: 360_000, discountCents: 0, taxCents: 54_000, totalCents: 414_000 });
    expect(cartDeals([line(bigTwo)])).toEqual({ dealInCart: true, onlyDeals: true });
    // Nothing marked: 10% of every line, as before; an empty cart is neither.
    const unmarked = [line(item('big-two', 'Test Big Two', 3600)), line(veggie), line(nuggets)];
    expect(priceOrder(cartPricedLines(unmarked), 10).discountCents).toBe(62_700);
    expect(cartDeals(unmarked)).toEqual({ dealInCart: false, onlyDeals: false });
    expect(cartDeals([])).toEqual({ dealInCart: false, onlyDeals: false });
  });

  it('the page prices its cart with them and hands the deal words their flags (read from the source)', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/OrderingApp.tsx', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    // v0.7.50: each line carries its category, so a category with its own % prices it so.
    expect(src).toContain(
      'const priced: PricedLine[] = cartPricedLines(cart).map((l, i) => ({ ...l, categoryId: categoryOfItem.get(cart[i]!.item.posItemId) ?? null }));',
    );
    // v0.7.37: a delivery prices with the owner's % off its food (0 = none); its fee line takes no share.
    expect(src).toContain('const discountPct = pickup ? pickupPct : deliveryPct;');
    // v0.7.50: and the categories with their own %, for the same way of getting the food.
    expect(src).toContain('const ownPercents = pickup ? pickupCats : deliveryCats;');
    expect(src).toContain('const totals = priceOrder(priced, discountPct, ownPercents);');
    expect(src).toContain('priced.push({ lineTotalCents: deliveryFee, taxRateBps: feeItem?.taxRateBps ?? 0, noDiscount: true });');
    expect(src).toContain('const notOnDeals = useMemo(() => menuHasNoDiscountItems(menu), [menu]);');
    expect(src).toContain('const { dealInCart, onlyDeals } = cartDeals(cart);');
    // (v0.7.39: the Buy 1 Get 1 flags follow them.)
    expect(src).toMatch(
      /minDeliveryOrderCents: deliveryFacts\.minDeliveryOrderCents,\n\s+notOnDeals,\n\s+dealInCart,\n\s+onlyDeals,\n\s+buy1Get1InCart,\n\s+buy1Get1Open,\n\s+\};/,
    );
    expect(src).toMatch(/<MenuHeader\n\s+canPickup=\{canPickup\}\n\s+pickupPct=\{pickupPct\}\n\s+deliveryPct=\{deliveryPct\}\n\s+notOnDeals=\{notOnDeals\}/);
  });
});

describe('the choices sheet of a pizza whose Large is set "Pick-up only"', () => {
  const crust = (id: string, modifierId: string): PublishedModifierGroup => ({
    posGroupId: id,
    name: 'Crust',
    selectionType: 'single',
    minSelect: 0,
    maxSelect: 1,
    isRequired: false,
    sortOrder: 0,
    modifiers: [{ posModifierId: modifierId, name: 'Thin', priceDeltaCents: 0, isDefault: false, sortOrder: 0 }],
  });
  function pizzaCard(largePickupOnly: boolean) {
    const menu = publicMenu({
      categories: [
        {
          posCategoryId: 'c-pizza',
          name: 'Test Pizzas',
          displayOrder: 0,
          items: [
            item('pz-m', 'Test Pizza — Medium', 900, { sortOrder: 1, modifierGroups: [crust('g-m', 'm-thin-m')] }),
            item('pz-l', 'Test Pizza — Large', 1400, {
              sortOrder: 2,
              modifierGroups: [crust('g-l', 'm-thin-l')],
              ...(largePickupOnly ? { pickupOnly: true } : {}),
            }),
          ],
        },
      ],
      publishedAt: '2026-09-27T09:00:00.000Z',
      store: STORE,
    });
    const card = buildMenuView(menu)
      .flatMap((s) => s.cards)
      .find((c) => c.name === 'Test Pizza');
    if (!card) throw new Error('no pizza card');
    return card;
  }
  function sheet(canPickup: boolean, initialVariant = 0, largePickupOnly = true): string {
    return renderToStaticMarkup(
      React.createElement(ItemSheet, {
        card: pizzaCard(largePickupOnly),
        initialVariant,
        canPickup,
        onClose: () => {},
        onConfirm: () => {},
      }),
    );
  }
  /** The sheet's Size block. */
  function sizes(html: string): string {
    const start = html.indexOf('>Size</legend>');
    return html.slice(start, html.indexOf('</fieldset>', start));
  }
  /** The sheet's Add button. */
  function addButton(html: string): string {
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    return buttons[buttons.length - 1] ?? '';
  }

  it('is one size only: the Large is pick-up only, the Medium is not, and the card is not', () => {
    const card = pizzaCard(true);
    expect(card.pickupOnly).toBe(false);
    expect(card.variants.map((v) => v.pickupOnly)).toEqual([false, true]);
  });

  it('online pick-up off: the Large shows "Pick-up only" and is no button (it can’t be chosen); the Medium adds as before', () => {
    const html = sheet(false);
    const block = sizes(html);
    expect(block.match(/<button/g) ?? []).toHaveLength(1);
    expect(block).toMatch(/<button[^>]*aria-pressed="true"[^>]*>.*Medium/);
    expect(block).toMatch(/border-dashed[^>]*>.*Large.*Pick-up only/);
    expect(addButton(html)).toContain('Add · Rs 900');
    expect(addButton(html)).toContain('aria-disabled="false"');
  });

  it('online pick-up on: the Large can be chosen and says it is pick-up only; the Medium says nothing of it', () => {
    const block = sizes(sheet(true));
    const buttons = block.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatch(/Medium/);
    expect(buttons[0]).not.toMatch(/pick-?up only/i);
    expect(buttons[1]).toMatch(/Large.*Pick-up only/);
    expect(block).not.toContain('border-dashed');
  });

  it('opened on the Large while pick-up was on, then pick-up went off: the Add says pick-up only and adds nothing', () => {
    const add = addButton(sheet(false, 1));
    expect(add).toContain('aria-disabled="true"');
    expect(add).toMatch(/Large.*pick-up only/);
    expect(add).not.toContain('Add');
    // Pick-up on: the same Large adds.
    expect(addButton(sheet(true, 1))).toContain('Add · Rs 1,400');
  });

  it('with no size set pick-up only (the default) the sheet is the same with pick-up on or off, and says nothing of it', () => {
    const on = sheet(true, 0, false);
    expect(sheet(false, 0, false)).toBe(on);
    expect(on).not.toMatch(/pick-?up only/i);
    expect(sizes(on).match(/<button/g) ?? []).toHaveLength(2);
  });

  it('the one rule the card, the sheet and the add to the cart follow', () => {
    expect(sizeOrderable({ pickupOnly: true }, false)).toBe(false);
    expect(sizeOrderable({ pickupOnly: true }, true)).toBe(true);
    expect(sizeOrderable({ pickupOnly: false }, false)).toBe(true);
    expect(sizeOrderable({ pickupOnly: false }, true)).toBe(true);
  });
});

/**
 * Where a size is chosen and added, each asks the one rule (sizeOrderable)
 * with whether online pick-up is on NOW. Static rendering runs no click, and
 * the card and the sheet never offer such a size as a button (tested above),
 * so these guards are what stops it when pick-up goes off between the render
 * and the tap (the status poll): read from the source, as the till's
 * DiscountDialog and delivery-charge row are.
 */
describe('the pick-up-only size rule where a size is tapped, switched and added (read from the source)', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const APP = read('../components/OrderingApp.tsx');
  const SHEET = read('../components/ordering/ItemSheet.tsx');

  /** From `start` to the brace closing the first `{` at or after it: a function's body, a handler. */
  function braced(src: string, start: string, from = 0): string {
    const at = src.indexOf(start, from);
    expect(at, start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`not closed: ${start}`);
  }
  /** A self-closing JSX element, `<Tag … />`, its props whole. */
  function element(src: string, tag: string): string {
    const at = src.indexOf(`<${tag}`);
    expect(at, tag).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = at; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      else if (depth === 0 && src.startsWith('/>', i)) return src.slice(at, i + 2);
    }
    throw new Error(`not closed: <${tag}`);
  }
  /** `guard` is in `code`, and every `after` comes after it. */
  function guardsFirst(code: string, guard: string, ...after: string[]) {
    const g = code.indexOf(guard);
    expect(g, guard).toBeGreaterThan(-1);
    for (const a of after) expect({ a, after: code.indexOf(a) > g }).toEqual({ a, after: true });
  }

  it('a size tapped on a card (pickVariant): one not orderable now is neither added nor opened in the sheet — and pick-up going on or off reaches it', () => {
    const pick = braced(APP, 'const pickVariant: PickFn = useCallback(');
    guardsFirst(pick, 'if (!v || !sizeOrderable(v, canPickup)) return;', 'setSheet(', 'addToCart(');
    const at = APP.indexOf(pick) + pick.length;
    expect(APP.slice(at, APP.indexOf(');', at))).toMatch(/\[[^\]]*\bcanPickup\b[^\]]*\]/);
  });

  it('the sheet opened from the menu is told whether pick-up is on now, and what its Add hands back reaches the cart only if orderable now', () => {
    expect(APP.match(/<ItemSheet\b/g) ?? []).toHaveLength(1);
    const sheet = element(APP, 'ItemSheet');
    expect(sheet).toMatch(/\scanPickup=\{canPickup\}\s/);
    guardsFirst(braced(sheet, 'onConfirm={'), 'if (!sizeOrderable(v, canPickup)) return;', 'addToCart(', 'setSheet(null)');
  });

  it('in the sheet, switching to a size not orderable now does nothing; the Add of one (pick-up went off since) adds nothing', () => {
    guardsFirst(braced(SHEET, 'function switchVariant('), 'if (!next || !sizeOrderable(next, canPickup)) return;', 'setVariantIndex(i)', 'setSelected(');
    expect(SHEET).toContain('const unavailable = !sizeOrderable(variant, canPickup);');
    const add = braced(SHEET, 'onClick={', SHEET.indexOf('aria-disabled={unavailable || unmet.length > 0}'));
    guardsFirst(add, 'if (unavailable) return;', 'onConfirm(');
    expect(SHEET.match(/onConfirm\(/g) ?? []).toHaveLength(1);
  });
});

describe('the value deals’ price promise (24 Oct 2026)', () => {
  const deals = (taxIncluded: boolean) =>
    publicMenu({
      categories: [
        ...MENU.categories,
        {
          posCategoryId: 'c-deals',
          name: 'Test Deals',
          displayOrder: 2,
          items: [
            item('deal-1', 'Test Deal', 1800, { noDiscount: true, ...(taxIncluded ? { taxIncluded: true } : {}) }),
            item('deal-2', 'Test Burger Deal', 850, { noDiscount: true, ...(taxIncluded ? { taxIncluded: true } : {}) }),
          ],
        },
      ],
      publishedAt: '2026-10-24T09:00:00.000Z',
      store: STORE,
    });

  it('says "the price you see is the price you pay" once every deal includes its tax, and each card says so', () => {
    const html = app({ menu: deals(true), acceptingOrders: true });
    expect(html.split('The price you see is the price you pay · tax included · delivery extra').length - 1).toBe(1);
    expect(html.split('>Tax included</p>').length - 1).toBe(2);
  });

  it('never while a deal still adds its tax on the bill', () => {
    const html = app({ menu: deals(false), acceptingOrders: true });
    expect(html).not.toContain('The price you see is the price you pay');
    expect(html).not.toContain('>Tax included</p>');
  });
});
