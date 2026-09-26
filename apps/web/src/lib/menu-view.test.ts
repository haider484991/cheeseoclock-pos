import { describe, expect, it } from 'vitest';
import type { PublishedMenu, PublishedMenuItem } from '@cheeseoclock/shared-types';
import {
  buildMenuView,
  dealWorthCents,
  groupLabel,
  isDealSection,
  isPickupOnly,
  menuWithoutDrinkBrand,
  optionLabel,
  shopPhotoFor,
  sizeLabel,
  splitSizedName,
  withoutDrinkBrand,
} from './menu-view';
import { validateOrderable } from './order-validation';

function item(name: string, priceRs: number, over: Partial<PublishedMenuItem> = {}): PublishedMenuItem {
  return {
    posItemId: `id:${name}`,
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

function menu(categories: Array<[string, PublishedMenuItem[]]>): PublishedMenu {
  return {
    categories: categories.map(([name, items], i) => ({
      posCategoryId: `cat:${name}`,
      name,
      displayOrder: i,
      items,
    })),
    publishedAt: '2026-09-25T00:00:00.000Z',
    store: { name: "Cheese O'Clock", phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}

describe('splitSizedName', () => {
  it('splits the import’s "Name — Size" sibling convention', () => {
    expect(splitSizedName('Fajita Pizza — Medium')).toEqual({ base: 'Fajita Pizza', size: 'Medium' });
    expect(splitSizedName('Soft Drink — 250 ml')).toEqual({ base: 'Soft Drink', size: '250 ml' });
    expect(splitSizedName('Fries – Large')).toEqual({ base: 'Fries', size: 'Large' });
  });

  it('leaves unsized names alone, hyphens and brackets included', () => {
    expect(splitSizedName('Nashville Authentic (Hot)')).toEqual({ base: 'Nashville Authentic (Hot)', size: null });
    expect(splitSizedName('Tikka-Malai Pizza')).toEqual({ base: 'Tikka-Malai Pizza', size: null });
  });
});

describe('buildMenuView', () => {
  const view = buildMenuView(
    menu([
      [
        'Pizza',
        [
          item('Fajita Pizza — Large', 2000, { sortOrder: 1 }),
          item('Fajita Pizza — Medium', 1500, { sortOrder: 0, description: 'Smoky fajita chicken.' }),
          item('Classic Pepperoni — Medium', 1500, { sortOrder: 2 }),
        ],
      ],
      ['Signature Pizzas', [item('Cheesy Star — Large', 2200)]],
      [
        'Fries & Sides',
        [item('Signature Loaded Fries', 700, { description: 'Pick up only.' }), item('Nuggets', 670)],
      ],
      ['Delivery Charges', [item('Delivery Charge (Rs 200)', 200), item('Delivery Charge (Rs 250)', 250)]],
    ]),
  );

  it('folds size siblings into one card, cheapest size first', () => {
    const pizza = view.find((s) => s.name === 'Regular Pizzas')!;
    expect(pizza.cards.map((c) => c.name)).toEqual(['Fajita Pizza', 'Classic Pepperoni']);
    const fajita = pizza.cards[0]!;
    expect(fajita.variants.map((v) => [v.size, v.item.basePriceCents])).toEqual([
      ['Medium', 150_000],
      ['Large', 200_000],
    ]);
    // Each size keeps its exact till item — the order carries that id.
    expect(fajita.variants[1]!.item.posItemId).toBe('id:Fajita Pizza — Large');
    expect(fajita.description).toBe('Smoky fajita chicken.');
  });

  it('never shows the delivery-charge items as food', () => {
    expect(view.find((s) => /delivery/i.test(s.name))).toBeUndefined();
  });

  it('uses the shop’s own photo only for items that were photographed', () => {
    const sig = view.find((s) => s.name === 'Signature Pizzas')!;
    expect(sig.cards[0]!.image).toBe('/images/menu/cheesy-star.webp');
    const pizza = view.find((s) => s.name === 'Regular Pizzas')!;
    expect(pizza.cards.every((c) => c.image === null)).toBe(true);
  });

  it('marks pick-up-only items', () => {
    const sides = view.find((s) => s.name === 'Fries & Sides')!;
    expect(sides.cards.find((c) => c.name === 'Signature Loaded Fries')!.pickupOnly).toBe(true);
    expect(sides.cards.find((c) => c.name === 'Nuggets')!.pickupOnly).toBe(false);
  });

  it('gives each section a rail anchor', () => {
    expect(view.map((s) => s.anchor)).toEqual(['regular-pizzas', 'signature-pizzas', 'fries-and-sides']);
  });

  it('prefers a photo the till published over the static one', () => {
    const v = buildMenuView(
      menu([['Signature Pizzas', [item('Cheesy Star — Large', 2200, { imageUrl: 'data:image/png;base64,AA' })]]]),
    );
    expect(v[0]!.cards[0]!.image).toBe('data:image/png;base64,AA');
  });
});

describe('value deals', () => {
  function slot(name: string, options: string[]) {
    return {
      posGroupId: `g:${name}`,
      name,
      selectionType: 'single' as const,
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      sortOrder: 0,
      modifiers: options.map((o, i) => ({
        posModifierId: `m:${name}:${o}`,
        name: o,
        priceDeltaCents: 0,
        isDefault: false,
        sortOrder: i,
      })),
    };
  }
  const bigTwo = item('Big Two', 3600, {
    description: '2 Large 12" regular pizzas + 1 litre soft drink.',
    modifierGroups: [
      slot('Deal: Large pizza', ['Large: Fajita Pizza', 'Large: Cheesalious']),
      slot('Deal: 2nd Large pizza', ['2nd Large: Fajita Pizza', '2nd Large: Cheesalious']),
    ],
  });
  const familyFeast = item('Family Feast', 3100, {
    description: '1 Medium 9" + 1 Large 12" regular pizza + 1 litre soft drink.',
    modifierGroups: [
      slot('Deal: Medium pizza', ['Medium: Fajita Pizza']),
      slot('Deal: Large pizza', ['Large: Fajita Pizza']),
    ],
  });
  const m = menu([
    [
      'Pizza',
      [
        item('Fajita Pizza — Medium', 1500),
        item('Fajita Pizza — Large', 2000),
        item('Cheesalious — Large', 2000),
      ],
    ],
    ['Value Deals', [bigTwo, familyFeast]],
    ['Drinks', [item('Soft Drink — 345 ml', 120), item('Soft Drink — 1 litre', 250)]],
  ]);

  it('puts the deals first, the rest in the till’s order', () => {
    expect(buildMenuView(m).map((s) => s.name)).toEqual(['Value Deals', 'Regular Pizzas', 'Drinks']);
    expect(isDealSection('Value Deals')).toBe(true);
    expect(isDealSection('Regular Pizzas')).toBe(false);
  });

  it('prices a deal’s contents bought separately, from the live menu', () => {
    // 2 Large at Rs 2,000 + the 1 litre drink at Rs 250 = Rs 4,250 (the deal is Rs 3,600).
    expect(dealWorthCents(m, bigTwo)).toBe(425_000);
    // Medium Rs 1,500 + Large Rs 2,000 + drink Rs 250.
    expect(dealWorthCents(m, familyFeast)).toBe(375_000);
  });

  it('never names a drink brand, even in a description the till published', () => {
    expect(withoutDrinkBrand('2 Large 12" regular pizzas + 1 litre Pepsi.')).toBe(
      '2 Large 12" regular pizzas + 1 litre soft drink.',
    );
    const old = menu([
      ['Value Deals', [item('Big Two', 3600, { description: '2 Large 12" + 1 litre PEPSI.' })]],
    ]);
    expect(buildMenuView(old)[0]!.cards[0]!.description).toBe('2 Large 12" + 1 litre soft drink.');
    expect(withoutDrinkBrand(null)).toBeNull();
    // …and not in the menu data the page ships to the browser either.
    expect(JSON.stringify(menuWithoutDrinkBrand(old))).not.toMatch(/pepsi/i);
  });

  it('still prices a deal that carries optional add-on groups (dips on the side)', () => {
    const withDips = {
      ...bigTwo,
      modifierGroups: [
        ...bigTwo.modifierGroups,
        {
          ...slot('Dips on the side', ['Side of Ranch', 'Side of Garlic Mayo']),
          selectionType: 'multi' as const,
          minSelect: 0,
          maxSelect: 9,
          isRequired: false,
        },
      ],
    };
    expect(dealWorthCents(m, withDips)).toBe(425_000);
  });

  it('claims no saving it cannot price', () => {
    expect(dealWorthCents(m, item('Nuggets', 670))).toBeNull();
    const noDrink = menu([['Pizza', [item('Fajita Pizza — Large', 2000)]]]);
    expect(dealWorthCents(noDrink, bigTwo)).toBeNull();
  });
});

describe('labels', () => {
  it('prints inches only for the shop’s two pizza sizes', () => {
    expect(sizeLabel('Medium')).toBe('Medium 9"');
    expect(sizeLabel('Large')).toBe('Large 12"');
    expect(sizeLabel('Regular')).toBe('Regular');
    expect(sizeLabel(null)).toBe('');
  });

  it('drops the deal-slot prefix inside a slot group', () => {
    expect(optionLabel('Large: Fajita Pizza')).toBe('Fajita Pizza');
    expect(optionLabel('2nd Medium: Cheesalious')).toBe('Cheesalious');
    expect(optionLabel('Garlic Mayo')).toBe('Garlic Mayo');
    expect(groupLabel({ name: 'Deal: 2nd Large pizza' })).toBe('2nd Large pizza');
    expect(groupLabel({ name: 'Veggie Lovers — Choose 5 veggies' })).toBe('Choose 5 veggies');
    expect(groupLabel({ name: 'Choose your dip' })).toBe('Choose your dip');
    // each item's own leave-outs: the till needs unique names, customers see the heading
    expect(groupLabel({ name: 'Leave out · Fajita Pizza' })).toBe('Leave out');
    expect(groupLabel({ name: 'Extras · Burgers' })).toBe('Extras');
  });

  it('finds photos case-insensitively', () => {
    expect(shopPhotoFor('Signature Cheese Dipped')).toBe('/images/menu/signature-cheese-dipped.webp');
    expect(shopPhotoFor('Fajita Pizza')).toBeNull();
  });
});

describe('validateOrderable', () => {
  it('refuses a delivery charge sent by the client', () => {
    expect(validateOrderable(item('Delivery Charge (Rs 200)', 200))).toMatch(/delivery area/);
  });

  it('refuses pick-up-only items on a delivery order', () => {
    expect(isPickupOnly({ description: 'Pick up only.' })).toBe(true);
    expect(isPickupOnly({ description: 'Pickup only' })).toBe(true);
    expect(validateOrderable(item('Signature Loaded Fries', 700, { description: 'Pick up only.' }))).toMatch(
      /Signature Loaded Fries is pick-up only/,
    );
  });

  it('lets normal food through', () => {
    expect(validateOrderable(item('Fajita Pizza — Large', 2000))).toBeNull();
  });
});
