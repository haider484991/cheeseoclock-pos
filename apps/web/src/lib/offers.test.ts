import { describe, expect, it } from 'vitest';
import type { MenuCard } from './menu-view';
import {
  OFFER_FINE_PRINT,
  OFFER_RULES,
  OFFER_WINDOW,
  cardOffer,
  offerSectionOf,
  regularPizzaPrices,
  tagUsHint,
} from './offers';

/** A card as the menu view builds it: variants cheapest first, each its own till item. */
function card(name: string, variants: Array<[size: string | null, rupees: number, noDiscount?: boolean]>): MenuCard {
  return {
    key: name,
    name,
    description: null,
    image: null,
    pickupOnly: false,
    variants: variants.map(([size, rs, noDiscount]) => ({
      size,
      pickupOnly: false,
      item: {
        posItemId: `${name}-${size ?? 'one'}`,
        name: size ? `${name} — ${size}` : name,
        description: null,
        basePriceCents: rs * 100,
        taxRateBps: 1500,
        imageUrl: null,
        sortOrder: 0,
        modifierGroups: [],
        ...(noDiscount ? { noDiscount: true } : {}),
      },
    })),
  };
}

const PICKUP_10 = { pickupPct: 10, deliveryPct: 0, canPickup: true };

describe('the poster’s words', () => {
  it('1–7 PM, the two Buy 1 Get 1 rules, the tag-us hint and the delivery-and-tax warning', () => {
    expect(OFFER_WINDOW).toBe('1–7 PM');
    expect(OFFER_FINE_PRINT).toBe('Delivery charges & tax may apply');
    expect(OFFER_RULES).toHaveLength(2);
    expect(OFFER_RULES[0]).toMatch(/Large pizza.*burger.*side.*Nashville.*Medium pizza FREE/);
    expect(OFFER_RULES[1]).toMatch(/Medium pizza.*side.*Loaded Fries/);
  });
});

describe('tagUsHint: the shop’s own profiles, else its name', () => {
  it('names each profile the owner lists, as the poster does', () => {
    expect(tagUsHint('Test Shop', ['https://www.instagram.com/testshop_/', 'https://www.facebook.com/testshop.karachi'])).toBe(
      'Post your meal, tag us (Instagram @testshop_ · Facebook /testshop.karachi) and show us the post: your Buy 1 Get 1 item is free (1–7 PM).',
    );
  });

  it('with no profiles, the shop’s name', () => {
    expect(tagUsHint('Test Shop', [])).toBe(
      'Post your meal, tag Test Shop on Instagram or Facebook and show us the post: your Buy 1 Get 1 item is free (1–7 PM).',
    );
  });

  it('a profile with no path, or a host it does not know, is named by its label alone or its host', () => {
    expect(tagUsHint('Test Shop', ['https://www.tiktok.com/@testshop'])).toContain('TikTok @testshop');
    expect(tagUsHint('Test Shop', ['https://www.instagram.com/'])).toContain('(Instagram)');
  });
});

describe('offerSectionOf: the till’s own category names', () => {
  it('reads the shop’s sections', () => {
    expect(offerSectionOf('Pizza')).toBe('pizza');
    expect(offerSectionOf('Signature Pizzas')).toBe('signature');
    expect(offerSectionOf('Burgers')).toBe('burger');
    expect(offerSectionOf('Fries & Sides')).toBe('side');
    expect(offerSectionOf('Value Deals')).toBe('deal');
    expect(offerSectionOf('Dips')).toBe('other');
    expect(offerSectionOf('Drinks')).toBe('other');
  });
});

describe('cardOffer', () => {
  const fajita = card('Fajita Pizza', [
    ['Medium', 1500],
    ['Large', 2000],
  ]);

  it('a regular pizza in both sizes: the strip says what each size earns; the pick-up prices are worked per size', () => {
    expect(cardOffer('Pizza', fajita, PICKUP_10)).toEqual({
      bogo: { title: 'BUY 1 GET 1 FREE · 1–7 PM', detail: 'Large: any burger, side or Medium FREE · Medium: any side FREE' },
      discount: {
        label: '10% off with pick-up',
        prices: [
          { size: 'Medium 9"', wasCents: 150_000, nowCents: 135_000 },
          { size: 'Large 12"', wasCents: 200_000, nowCents: 180_000 },
        ],
      },
    });
  });

  it('one size of a regular pizza earns only its own reward', () => {
    expect(cardOffer('Pizza', card('Fajita Pizza', [['Large', 2000]]), PICKUP_10).bogo?.detail).toBe('Any burger, side or Medium pizza FREE');
    expect(cardOffer('Pizza', card('Fajita Pizza', [['Medium', 1500]]), PICKUP_10).bogo?.detail).toBe('Any side FREE');
    expect(cardOffer('Pizza', card('Odd Pizza', [['Party', 3000]]), PICKUP_10).bogo).toBeNull();
  });

  it('a signature pizza has the % off but no Buy 1 Get 1 strip (the poster’s prices are the regular pizzas’)', () => {
    expect(cardOffer('Signature Pizzas', card('Cheesy Star', [['Large', 2200]]), PICKUP_10)).toEqual({
      bogo: null,
      discount: { label: '10% off with pick-up', prices: [{ size: 'Large 12"', wasCents: 220_000, nowCents: 198_000 }] },
    });
  });

  it('burgers: free with any Large pizza — never the Nashville Burger', () => {
    expect(cardOffer('Burgers', card('Classic Crispy Chicken', [[null, 700]]), PICKUP_10)).toEqual({
      bogo: { title: 'FREE · 1–7 PM', detail: 'With any Large pizza' },
      discount: { label: '10% off with pick-up', prices: [{ size: '', wasCents: 70_000, nowCents: 63_000 }] },
    });
    expect(cardOffer('Burgers', card('Nashville Authentic (Hot)', [[null, 950]]), PICKUP_10).bogo).toBeNull();
    expect(cardOffer('Burgers', card('Nashville Authentic (Hot)', [[null, 950]]), PICKUP_10).discount?.prices).toEqual([
      { size: '', wasCents: 95_000, nowCents: 85_500 },
    ]);
  });

  it('sides: free with a Large or a Medium — Loaded Fries only with a Large', () => {
    const fries = cardOffer('Fries & Sides', card('Fries', [['Regular', 300], ['Large', 450]]), PICKUP_10);
    expect(fries.bogo).toEqual({ title: 'FREE · 1–7 PM', detail: 'With any Large or Medium pizza' });
    expect(fries.discount?.prices).toEqual([
      { size: 'Regular', wasCents: 30_000, nowCents: 27_000 },
      { size: 'Large', wasCents: 45_000, nowCents: 40_500 },
    ]);
    expect(cardOffer('Fries & Sides', card('Signature Loaded Fries', [[null, 700]]), PICKUP_10).bogo?.detail).toBe('With any Large pizza');
    expect(cardOffer('Fries & Sides', card('Nuggets', [[null, 670]]), PICKUP_10).bogo?.detail).toBe('With any Large or Medium pizza');
  });

  it('dips and drinks: the % off only', () => {
    const dip = cardOffer('Dips', card('Ranch Dip', [[null, 100]]), PICKUP_10);
    expect(dip.bogo).toBeNull();
    expect(dip.discount).toEqual({ label: '10% off with pick-up', prices: [{ size: '', wasCents: 10_000, nowCents: 9_000 }] });
    expect(cardOffer('Drinks', card('Soft Drink', [['345 ml', 120], ['1 litre', 250]]), PICKUP_10).discount?.prices).toEqual([
      { size: '345 ml', wasCents: 12_000, nowCents: 10_800 },
      { size: '1 litre', wasCents: 25_000, nowCents: 22_500 },
    ]);
  });

  it('a value deal shows nothing: no % off, no strip (its own “Save Rs …” badge is its offer)', () => {
    expect(cardOffer('Value Deals', card('Big Two', [[null, 3600, true]]), PICKUP_10)).toEqual({ bogo: null, discount: null });
  });

  it('a card whose every item the till marked “no discount” shows no % even outside the deals section', () => {
    const out = cardOffer('Pizza', card('Marked Pizza', [['Medium', 1500, true], ['Large', 2000, true]]), PICKUP_10);
    expect(out.discount).toBeNull();
    expect(out.bogo).not.toBeNull();
  });

  it('the % line follows what is on offer: none → no line; pick-up off the till → no pick-up line; a delivery % alone; both', () => {
    expect(cardOffer('Pizza', fajita, { pickupPct: 0, deliveryPct: 0, canPickup: true }).discount).toBeNull();
    expect(cardOffer('Pizza', fajita, { pickupPct: 10, deliveryPct: 0, canPickup: false }).discount).toBeNull();
    expect(cardOffer('Pizza', fajita, { pickupPct: 10, deliveryPct: 10, canPickup: false }).discount).toEqual({
      label: '10% off delivery',
      prices: [
        { size: 'Medium 9"', wasCents: 150_000, nowCents: 135_000 },
        { size: 'Large 12"', wasCents: 200_000, nowCents: 180_000 },
      ],
    });
    expect(cardOffer('Pizza', fajita, { pickupPct: 10, deliveryPct: 10, canPickup: true }).discount?.label).toBe('10% off online orders');
    // Two different percents: both said, no price (it would be one of two).
    expect(cardOffer('Pizza', fajita, { pickupPct: 10, deliveryPct: 5, canPickup: true }).discount).toEqual({
      label: '10% off pick-up · 5% off delivery',
      prices: null,
    });
  });
});

describe('regularPizzaPrices', () => {
  it('the cheapest Medium and Large across the regular pizzas — the signature section is not counted', () => {
    const sections = [
      { name: 'Signature Pizzas', cards: [card('Cheesy Star', [['Large', 2200]])] },
      {
        name: 'Pizza',
        cards: [
          card('Fajita Pizza', [['Medium', 1500], ['Large', 2000]]),
          card('Veggie Lovers', [['Medium', 1600], ['Large', 2100]]),
        ],
      },
      { name: 'Burgers', cards: [card('Classic Crispy Chicken', [[null, 700]])] },
    ];
    expect(regularPizzaPrices(sections)).toEqual({ mediumCents: 150_000, largeCents: 200_000 });
    expect(regularPizzaPrices([])).toEqual({ mediumCents: null, largeCents: null });
  });
});

describe('the % off is worked out as the till rounds it', () => {
  it('an odd price: 10% of Rs 333 is Rs 33.30, so Rs 299.70 (whole paisa, as lib/pricing)', () => {
    const odd = cardOffer('Dips', card('Odd Dip', [[null, 333]]), PICKUP_10);
    expect(odd.discount?.prices).toEqual([{ size: '', wasCents: 33_300, nowCents: 29_970 }]);
  });
});

describe('cardOffer with Buy 1 Get 1 deals on the menu (7 Oct 2026)', () => {
  const ON = { dealsOnMenu: true };

  it('the strips say the free item comes in a deal', () => {
    const both = card('Fajita Pizza', [
      ['Medium', 1500],
      ['Large', 2000],
    ]);
    expect(cardOffer('Pizza', both, PICKUP_10, ON).bogo).toEqual({
      title: 'BUY 1 GET 1 FREE · 1–7 PM',
      detail: 'In a Buy 1 Get 1 deal: Large + free burger, side or Medium · Medium + free side',
    });
    expect(cardOffer('Pizza', card('Fajita Pizza', [['Large', 2000]]), PICKUP_10, ON).bogo?.detail).toBe(
      'In a Buy 1 Get 1 deal: + a free burger, side or Medium pizza',
    );
    expect(cardOffer('Pizza', card('Fajita Pizza', [['Medium', 1500]]), PICKUP_10, ON).bogo?.detail).toBe('In a Buy 1 Get 1 deal: + a free side');
    expect(cardOffer('Burgers', card('Classic Crispy Chicken', [[null, 700]]), PICKUP_10, ON).bogo?.detail).toBe(
      'With any Large pizza in a Buy 1 Get 1 deal',
    );
    expect(cardOffer('Burgers', card('Nashville Authentic (Hot)', [[null, 950]]), PICKUP_10, ON).bogo).toBeNull();
    expect(cardOffer('Fries & Sides', card('Nuggets', [[null, 670]]), PICKUP_10, ON).bogo?.detail).toBe(
      'With any Large or Medium pizza in a Buy 1 Get 1 deal',
    );
    expect(cardOffer('Fries & Sides', card('Signature Loaded Fries', [[null, 700]]), PICKUP_10, ON).bogo?.detail).toBe(
      'With any Large pizza in a Buy 1 Get 1 deal',
    );
    // The % off is unchanged.
    expect(cardOffer('Pizza', both, PICKUP_10, ON).discount).toEqual(cardOffer('Pizza', both, PICKUP_10).discount);
  });

  it('the deals themselves show no strip and no % off (deals are never discounted)', () => {
    expect(cardOffer('Buy 1 Get 1 Deals', card('Large + Free Medium', [[null, 2000]]), PICKUP_10, ON)).toEqual({ bogo: null, discount: null });
  });
});
