import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PublishedMenuCategory, PublishedMenuItem } from '@cheeseoclock/shared-types';
import { BUY_1_GET_1_PHOTO, FALLBACK_PHOTO, GATE_SLIDES_MAX, gatePhotoFor, gateSlides } from './gate-slides';

let n = 0;
function item(name: string, rupees: number, over: Partial<PublishedMenuItem> & { priceIncludesTax?: boolean } = {}): PublishedMenuItem {
  return {
    posItemId: `i${++n}`,
    name,
    description: null,
    basePriceCents: rupees * 100,
    taxRateBps: 1500,
    imageUrl: null,
    sortOrder: n,
    modifierGroups: [],
    ...over,
  };
}
const cat = (name: string, items: PublishedMenuItem[]): PublishedMenuCategory => ({
  posCategoryId: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  displayOrder: 1,
  items,
});

/** The owner's deals as the menu file of 24 Oct 2026 names them, marked tax-included. */
const TAX_IN = { priceIncludesTax: true };
const MENU = {
  categories: [
    cat('Pizza', [item('Chicken Tikka Large', 2000)]),
    cat('Value Deals', [
      item('Cheese Partners', 1300, TAX_IN),
      item('Large & Chilled', 1800, TAX_IN),
      item('Loaded Combo', 2100, TAX_IN),
      item('Double Large', 3400, TAX_IN),
      item('Pizzas & Nuggets', 3500, TAX_IN),
      item('Mega Cheese Box', 4800, TAX_IN),
    ]),
    cat('Burger Deals', [
      item('Burger Duo', 1900, TAX_IN),
      item('Classic Crispy Deal', 850, TAX_IN),
      item('Signature Cripsy Deal', 950, TAX_IN),
      item('Cheese Dipped Deal', 1050, TAX_IN),
    ]),
    cat('Buy 1 Get 1 Free', [item('Large + Free Medium', 2000, TAX_IN), item('Medium + Free Side', 1500, TAX_IN)]),
  ],
};
const ON = { buy1Get1: { on: true, opensMinute: 12 * 60, closesMinute: 19 * 60 } };
const OFF = { buy1Get1: { on: false, opensMinute: 12 * 60, closesMinute: 19 * 60 } };

describe('gateSlides', () => {
  it('leads with the most emotional deals, at the menu’s prices, Buy 1 Get 1 third with its hours', () => {
    const slides = gateSlides(MENU, ON);
    expect(slides.map((s) => [s.name, s.priceCents / 100])).toEqual([
      ['Mega Cheese Box', 4800],
      ['Cheese Partners', 1300],
      ['Buy 1 Get 1 FREE', 1500],
      ['Large & Chilled', 1800],
      ['Double Large', 3400],
      ['Pizzas & Nuggets', 3500],
      ['Loaded Combo', 2100],
      ['Burger Duo', 1900],
    ]);
    expect(slides).toHaveLength(GATE_SLIDES_MAX);
    const b1g1 = slides.find((s) => s.key === 'buy-1-get-1')!;
    expect(b1g1.when).toEqual({ en: '12–7 PM only', ur: 'Sirf 12–7 PM' });
    expect(b1g1.from).toBe(true);
  });

  it('every slide opens on a hook in both languages, never a drink brand', () => {
    for (const s of gateSlides(MENU, ON)) {
      expect(s.hook.en.length, s.name).toBeGreaterThan(8);
      expect(s.hook.ur.length, s.name).toBeGreaterThan(8);
      expect(JSON.stringify(s)).not.toMatch(/pepsi|coke|coca/i);
    }
  });

  it('the burger meals are one slide, "from" the cheapest', () => {
    const slides = gateSlides({ categories: [MENU.categories[2]!] }, OFF);
    expect(slides.map((s) => [s.name, s.priceCents / 100, s.from])).toEqual([
      ['Burger Duo', 1900, false],
      ['Classic Crispy Deal', 850, true],
    ]);
  });

  it('says "the price you see is the price you pay" only of a tax-included deal, with its own numbers', () => {
    const marked = gateSlides(MENU, OFF).find((s) => s.name === 'Large & Chilled')!;
    expect(marked.hook).toEqual({ en: 'Menu says 1,800. Bill says 2,070?', ur: 'Menu pe 1,800… bill pe 2,070?' });
    expect(marked.taxIncluded).toBe(true);
    const plain = gateSlides({ categories: [cat('Value Deals', [item('Large & Chilled', 1800)])] }, OFF)[0]!;
    expect(plain.taxIncluded).toBe(false);
    expect(plain.hook.en).not.toMatch(/bill/i);
  });

  it('no Buy 1 Get 1 while the owner has it off; a deal it doesn’t name gets a plain hook, last', () => {
    const slides = gateSlides({ categories: [cat('Value Deals', [item('Midnight Feast', 2500), item('Cheese Partners', 1300)])] }, OFF);
    expect(slides.map((s) => s.name)).toEqual(['Cheese Partners', 'Midnight Feast']);
    expect(slides[1]!.hook.en).toBe('Hungry? This one’s for you.');
    expect(slides[1]!.line.en).toBe('One of our value deals');
    const described = gateSlides({ categories: [cat('Value Deals', [item('Big Two', 3600, { description: 'Two medium pizzas and a 1.5 litre Pepsi. Dips extra.' })])] }, OFF)[0]!;
    expect(described.line.en).toBe('Two medium pizzas and a 1.5 litre soft drink.');
    expect(gateSlides(MENU, OFF).some((s) => s.key === 'buy-1-get-1')).toBe(false);
  });

  it('nothing without a menu, or without deals', () => {
    expect(gateSlides(null, ON)).toEqual([]);
    expect(gateSlides({ categories: [MENU.categories[0]!] }, ON)).toEqual([]);
  });
});

describe('every slide shows its own deal’s picture, and the picture is there', () => {
  /** A picture's file in public/ (the site serves public/x as /x). */
  const fileOf = (src: string) => new URL(`../../public${src}`, import.meta.url);

  it('each deal on the 24 Oct menu has its own picture: the small one the deal cards use', () => {
    const slides = gateSlides(MENU, ON);
    expect(Object.fromEntries(slides.map((s) => [s.name, s.photo]))).toMatchObject({
      'Mega Cheese Box': '/images/deals/sm/mega-cheese-box.webp',
      'Double Large': '/images/deals/sm/double-large.webp',
      'Pizzas & Nuggets': '/images/deals/sm/pizzas-and-nuggets.webp',
      'Cheese Partners': '/images/deals/sm/cheese-partners.webp',
      'Burger Duo': '/images/deals/sm/burger-duo.webp',
      'Buy 1 Get 1 FREE': BUY_1_GET_1_PHOTO,
    });
  });

  it('the deals sold before 24 Oct show their two pizzas, not one', () => {
    for (const [name, file] of [['Big Two', 'big-two'], ['Family Feast', 'family-feast'], ['Perfect Pair', 'perfect-pair']] as const) {
      expect(gatePhotoFor(name), name).toBe(`/images/gate/deals/${file}.webp`);
    }
    expect(gatePhotoFor('Midnight Feast')).toBe(FALLBACK_PHOTO);
  });

  it('no slide points at a file the site does not have (a 404 is a broken slide)', () => {
    const old = { categories: [cat('Value Deals', [item('Big Two', 3600), item('Family Feast', 3100), item('Perfect Pair', 2600), item('Midnight Feast', 2500)])] };
    const photos = new Set([...gateSlides(MENU, ON), ...gateSlides(old, ON)].map((s) => s.photo));
    photos.add(FALLBACK_PHOTO);
    photos.add(BUY_1_GET_1_PHOTO);
    for (const src of photos) expect(existsSync(fileOf(src)), src).toBe(true);
  });
});
