import { describe, expect, it } from 'vitest';
import type { PublishedMenu, PublishedMenuItem, PublishedModifierGroup } from '@cheeseoclock/shared-types';
import {
  MAX_LINE_QTY,
  addLine,
  cartCount,
  cartLineKey,
  cartSubtotalCents,
  itemLabel,
  lineChoices,
  lineUnitPriceCents,
  linesSummary,
  parseSavedLines,
  restoreLines,
  setLineQty,
  toSavedLines,
  whatsappOrderText,
  type CartLine,
} from './cart';

function mod(id: string, name: string, priceRs = 0) {
  return { posModifierId: id, name, priceDeltaCents: priceRs * 100, isDefault: false, sortOrder: 0 };
}

function group(over: Partial<PublishedModifierGroup> & { posGroupId: string }): PublishedModifierGroup {
  return {
    name: over.posGroupId,
    selectionType: 'multi',
    minSelect: 0,
    maxSelect: 0,
    isRequired: false,
    sortOrder: 0,
    modifiers: [],
    ...over,
  };
}

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

const fajitaL = item('fajita-l', 'Fajita Pizza — Large', 2000, {
  modifierGroups: [
    group({ posGroupId: 'leave', name: 'Leave out · Fajita Pizza', modifiers: [mod('no-onion', 'No onion')] }),
    group({ posGroupId: 'extra', name: 'Extra toppings', modifiers: [mod('x-cheese', 'Extra cheese', 150)] }),
  ],
});
const nuggets = item('nuggets', 'Nuggets', 670, {
  modifierGroups: [
    group({
      posGroupId: 'dip',
      name: 'Choose your dip',
      selectionType: 'single',
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      modifiers: [mod('ranch', 'Ranch'), mod('bbq', 'BBQ Sauce')],
    }),
  ],
});
const drink = item('drink-1l', 'Soft Drink — 1 litre', 250);
const fee = item('del-200', 'Delivery Charge (Rs 200)', 200);

const MENU: PublishedMenu = {
  categories: [
    { posCategoryId: 'p', name: 'Pizza', displayOrder: 1, items: [fajitaL] },
    { posCategoryId: 's', name: 'Sides', displayOrder: 2, items: [nuggets, drink] },
    { posCategoryId: 'd', name: 'Delivery Charges', displayOrder: 3, items: [fee] },
  ],
  publishedAt: '2026-09-26T00:00:00.000Z',
  store: { name: "Cheese O'Clock", phone: null, whatsapp: null, addressLine: null, tagline: null },
};

function line(it: PublishedMenuItem, quantity = 1, modifierIds: string[] = [], notes: string | null = null) {
  return { item: it, label: itemLabel(it), quantity, modifierIds, notes };
}

describe('itemLabel', () => {
  it('reads a sized till item the way the card shows it', () => {
    expect(itemLabel(fajitaL)).toBe('Fajita Pizza · Large 12"');
    expect(itemLabel(nuggets)).toBe('Nuggets');
    expect(itemLabel(drink)).toBe('Soft Drink · 1 litre');
  });
});

describe('addLine / setLineQty', () => {
  it('merges the same item, choices and note into one line whatever the choice order', () => {
    let cart: CartLine[] = [];
    cart = addLine(cart, line(fajitaL, 1, ['x-cheese', 'no-onion']));
    cart = addLine(cart, line(fajitaL, 2, ['no-onion', 'x-cheese']));
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(3);
    expect(cart[0]!.key).toBe(cartLineKey('fajita-l', ['no-onion', 'x-cheese'], null));
  });

  it('keeps a different kitchen note as its own line, and trims blank notes to none', () => {
    let cart: CartLine[] = [];
    cart = addLine(cart, line(fajitaL, 1, [], 'well done'));
    cart = addLine(cart, line(fajitaL, 1, [], '   '));
    cart = addLine(cart, line(fajitaL, 1, [], null));
    expect(cart).toHaveLength(2);
    expect(cart.map((l) => l.notes)).toEqual(['well done', null]);
    expect(cart[1]!.quantity).toBe(2);
  });

  it('never lets a merged line pass the server’s quantity cap', () => {
    let cart = addLine([], line(drink, 45));
    cart = addLine(cart, line(drink, 10));
    expect(cart[0]!.quantity).toBe(MAX_LINE_QTY);
  });

  it('sets, caps and removes by quantity', () => {
    const cart = addLine([], line(drink, 1));
    const key = cart[0]!.key;
    expect(setLineQty(cart, key, 4)[0]!.quantity).toBe(4);
    expect(setLineQty(cart, key, 99)[0]!.quantity).toBe(MAX_LINE_QTY);
    expect(setLineQty(cart, key, 0)).toEqual([]);
  });
});

describe('prices and counts', () => {
  it('prices a line with its paid choices, like the server does', () => {
    const cart = addLine(addLine([], line(fajitaL, 2, ['x-cheese'])), line(drink, 1));
    expect(lineUnitPriceCents(cart[0]!)).toBe(215_000);
    expect(cartSubtotalCents(cart)).toBe(2 * 215_000 + 25_000);
    expect(cartCount(cart)).toBe(3);
  });

  it('splits leave-outs from the other choices', () => {
    expect(lineChoices(line(fajitaL, 1, ['no-onion', 'x-cheese']))).toEqual({
      leaveOuts: ['No onion'],
      others: ['Extra cheese'],
    });
  });
});

describe('saved lines', () => {
  it('round-trips a cart through the device and back against the menu', () => {
    const cart = addLine(addLine([], line(fajitaL, 2, ['no-onion'], 'cut in 8')), line(nuggets, 1, ['bbq']));
    const { lines, dropped } = restoreLines(MENU, parseSavedLines(JSON.parse(JSON.stringify(toSavedLines(cart)))));
    expect(dropped).toBe(0);
    expect(lines.map((l) => [l.item.posItemId, l.quantity, l.modifierIds, l.notes, l.label])).toEqual([
      ['fajita-l', 2, ['no-onion'], 'cut in 8', 'Fajita Pizza · Large 12"'],
      ['nuggets', 1, ['bbq'], null, 'Nuggets'],
    ]);
  });

  it('drops lines whose item or choices left the menu, or that miss a required choice now', () => {
    const { lines, dropped } = restoreLines(MENU, [
      { posItemId: 'gone', quantity: 1, modifierIds: [], notes: null },
      { posItemId: 'fajita-l', quantity: 1, modifierIds: ['no-such-mod'], notes: null },
      { posItemId: 'nuggets', quantity: 1, modifierIds: [], notes: null },
      { posItemId: 'nuggets', quantity: 1, modifierIds: ['ranch', 'bbq'], notes: null },
      { posItemId: 'drink-1l', quantity: 2, modifierIds: [], notes: null },
    ]);
    expect(dropped).toBe(4);
    expect(lines.map((l) => l.item.posItemId)).toEqual(['drink-1l']);
  });

  it('never restores a delivery charge — the server adds it from the area', () => {
    const { lines, dropped } = restoreLines(MENU, [{ posItemId: 'del-200', quantity: 1, modifierIds: [], notes: null }]);
    expect(lines).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('reads untrusted storage defensively', () => {
    expect(parseSavedLines(null)).toEqual([]);
    expect(parseSavedLines('nope')).toEqual([]);
    expect(
      parseSavedLines([
        { posItemId: 'a', quantity: 2, modifierIds: ['m'], notes: ' hi ' },
        { posItemId: 'b', quantity: 0, modifierIds: [] },
        { posItemId: 'c', quantity: 1, modifierIds: [1, 2] },
        { quantity: 1 },
        { posItemId: 'd', quantity: 500 },
        7,
      ]),
    ).toEqual([
      { posItemId: 'a', quantity: 2, modifierIds: ['m'], notes: 'hi' },
      { posItemId: 'd', quantity: MAX_LINE_QTY, modifierIds: [], notes: null },
    ]);
  });

  it('summarises a saved order in a line', () => {
    const saved = [
      { posItemId: 'fajita-l', quantity: 2, modifierIds: [], notes: null },
      { posItemId: 'drink-1l', quantity: 1, modifierIds: [], notes: null },
      { posItemId: 'nuggets', quantity: 1, modifierIds: ['ranch'], notes: null },
    ];
    expect(linesSummary(MENU, saved)).toBe('2 × Fajita Pizza · Large 12", Soft Drink · 1 litre +1 more');
    expect(linesSummary(MENU, saved.slice(0, 1))).toBe('2 × Fajita Pizza · Large 12"');
  });
});

describe('whatsappOrderText', () => {
  const cart = addLine(addLine([], line(fajitaL, 2, ['x-cheese', 'no-onion'], 'well done')), line(drink, 1));

  it('spells out the cart for a delivery', () => {
    expect(
      whatsappOrderText(cart, { fulfilment: 'delivery', areaName: 'DHA Phase 6', name: 'Ahmed', address: 'House 12' }),
    ).toBe(
      [
        "Hi Cheese O'Clock! I'd like to order:",
        '• 2 × Fajita Pizza · Large 12" (Extra cheese, No onion) — note: well done',
        '• 1 × Soft Drink · 1 litre',
        'Items: Rs 4,550 (before tax and delivery)',
        'Delivery to: DHA Phase 6',
        'Name: Ahmed',
        'Address: House 12',
      ].join('\n'),
    );
  });

  it('says pick-up, and leaves the address out of it', () => {
    const text = whatsappOrderText(cart, { fulfilment: 'pickup', address: 'House 12' });
    expect(text).toContain('I will pick it up from the shop.');
    expect(text).toContain('(before tax)');
    expect(text).not.toContain('Address');
  });
});
