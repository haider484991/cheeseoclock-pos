/**
 * The published menu the page goldens are taken with (pages-golden.test.ts):
 * the shop's item NAMES and today's PRICES exactly as the website's own
 * code printed them at v0.7.30 (the home cards, the deals, the landing
 * pages' "from Rs …" lines — all public on the website already), every id
 * and every description made up, one tax rate on every item (1500). The
 * delivery charges are today's two. No photo (the till's data URLs are left
 * out of the page reads anyway).
 *
 * Kept here (under __fixtures__, outside the source scans of
 * site-copy.test.ts) because once the home page and the landing pages read
 * their prices from the published menu (sweep B2), these prices live only in
 * the menu the till publishes — and in this fixture.
 */
import type { PublishedMenu, PublishedMenuItem, PublishedModifierGroup } from '@cheeseoclock/shared-types';

const TAX_BPS = 1500;

function item(id: string, name: string, cents: number, sortOrder: number, over: Partial<PublishedMenuItem> = {}): PublishedMenuItem {
  return {
    posItemId: id,
    name,
    description: null,
    basePriceCents: cents,
    taxRateBps: TAX_BPS,
    imageUrl: null,
    sortOrder,
    modifierGroups: [],
    ...over,
  };
}

function group(id: string, name: string, modifiers: Array<[string, string, number]>, over: Partial<PublishedModifierGroup> = {}): PublishedModifierGroup {
  return {
    posGroupId: id,
    name,
    selectionType: 'multi',
    minSelect: 0,
    maxSelect: modifiers.length,
    isRequired: false,
    sortOrder: 0,
    modifiers: modifiers.map(([mid, mname, delta], i) => ({
      posModifierId: mid,
      name: mname,
      priceDeltaCents: delta,
      isDefault: false,
      sortOrder: i,
    })),
    ...over,
  };
}

/** "Dips on the side": every option at Rs 100 (the pizza page says so). */
const DIPS = (n: string) =>
  group(`g-dips-${n}`, 'Dips on the side', [
    [`m-dip-a-${n}`, 'Side of Test Dip A', 10_000],
    [`m-dip-b-${n}`, 'Side of Test Dip B', 10_000],
  ], { sortOrder: 5 });

/** "Extras · Burgers": Add cheese at Rs 100 (the burger page says so). */
const CHEESE = (n: string) =>
  group(`g-xb-${n}`, 'Extras · Burgers', [[`m-cheese-${n}`, 'Add cheese', 10_000]], { maxSelect: 1, sortOrder: 4 });

/** A deal's pizza slot: required, one regular pizza of that size. */
const SLOT = (id: string, name: string, prefix: string) =>
  group(id, name, [
    [`${id}-a`, `${prefix}: Fajita Pizza`, 0],
    [`${id}-b`, `${prefix}: Classic Supreme`, 0],
  ], { selectionType: 'single', minSelect: 1, maxSelect: 1, isRequired: true });

const SIGNATURE = ['Shawarma Pizza', 'Crown Crust', 'Cheesy Star', 'Meat Lovers', 'Cheetos'];

export function goldenMenu(): PublishedMenu {
  return {
    categories: [
      {
        posCategoryId: 'gc-signature',
        name: 'Signature Pizzas',
        displayOrder: 0,
        items: SIGNATURE.map((base, i) =>
          item(`gi-sig-${i}`, `${base} — Large`, 220_000, 16 + i, {
            description: `A made-up description of the ${base} for the test.`,
            modifierGroups: [DIPS(`sig-${i}`)],
          }),
        ),
      },
      {
        posCategoryId: 'gc-pizza',
        name: 'Pizza',
        displayOrder: 1,
        items: [
          item('gi-faj-m', 'Fajita Pizza — Medium', 150_000, 0, { description: 'Made-up words about a regular pizza.' }),
          item('gi-faj-l', 'Fajita Pizza — Large', 200_000, 1, { description: 'Made-up words about a regular pizza.' }),
          item('gi-sup-m', 'Classic Supreme — Medium', 150_000, 2, { description: 'More made-up words.' }),
          item('gi-sup-l', 'Classic Supreme — Large', 200_000, 3, { description: 'More made-up words.' }),
        ],
      },
      {
        posCategoryId: 'gc-burgers',
        name: 'Burgers',
        displayOrder: 2,
        items: [
          item('gi-b-classic', 'Classic Crispy Chicken', 70_000, 21, { description: 'A made-up burger line.', modifierGroups: [CHEESE('1')] }),
          item('gi-b-sig', 'Crispy Signature', 80_000, 22, { description: 'A made-up burger line.', modifierGroups: [CHEESE('2')] }),
          item('gi-b-dipped', 'Signature Cheese Dipped', 90_000, 23, {
            description: 'A made-up description of the dipped burger.',
            modifierGroups: [CHEESE('3'), DIPS('b3')],
          }),
          item('gi-b-hot', 'Nashville Authentic (Hot)', 95_000, 24, { description: 'A made-up burger line.', modifierGroups: [CHEESE('4')] }),
        ],
      },
      {
        posCategoryId: 'gc-sides',
        name: 'Fries & Sides',
        displayOrder: 3,
        items: [
          item('gi-s-fr', 'Fries — Regular', 30_000, 25),
          item('gi-s-fl', 'Fries — Large', 45_000, 26),
          item('gi-s-mf', 'Signature Masala Fries — Large', 48_000, 27),
          item('gi-s-mmf', 'Signature Mayo Masala Fries — Large', 55_000, 28),
          item('gi-s-lf', 'Signature Loaded Fries', 70_000, 29, { pickupOnly: true }),
          item('gi-s-ng', 'Nuggets', 67_000, 30),
          item('gi-s-bw', 'Baked Wings', 70_000, 31),
        ],
      },
      {
        posCategoryId: 'gc-deals',
        name: 'Value Deals',
        displayOrder: 5,
        items: [
          item('gi-d-two', 'Big Two', 360_000, 43, {
            description: 'Two made-up Large regular pizzas + 1 litre soft drink.',
            modifierGroups: [SLOT('g-two-1', 'Deal: Large pizza', 'Large'), SLOT('g-two-2', 'Deal: 2nd Large pizza', '2nd Large')],
          }),
          item('gi-d-feast', 'Family Feast', 310_000, 44, {
            description: 'A made-up Medium and a Large regular pizza + 1 litre soft drink.',
            modifierGroups: [SLOT('g-feast-1', 'Deal: Medium pizza', 'Medium'), SLOT('g-feast-2', 'Deal: Large pizza', 'Large')],
          }),
          item('gi-d-pair', 'Perfect Pair', 260_000, 45, {
            description: 'Two made-up Medium regular pizzas + 1 litre soft drink.',
            modifierGroups: [SLOT('g-pair-1', 'Deal: Medium pizza', 'Medium'), SLOT('g-pair-2', 'Deal: 2nd Medium pizza', '2nd Medium')],
          }),
        ],
      },
      {
        posCategoryId: 'gc-drinks',
        name: 'Drinks',
        displayOrder: 6,
        items: [item('gi-dr-s', 'Soft Drink — 345 ml', 12_000, 32), item('gi-dr-l', 'Soft Drink — 1 litre', 25_000, 33)],
      },
      {
        posCategoryId: 'gc-del',
        name: 'Delivery Charges',
        displayOrder: 7,
        items: [item('gi-fee-200', 'Delivery Charge (Rs 200)', 20_000, 46), item('gi-fee-250', 'Delivery Charge (Rs 250)', 25_000, 47)],
      },
    ],
    publishedAt: '2026-09-29T09:00:00.000Z',
    store: { name: 'Test Shop', phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}
