/**
 * Soft drinks by flavour (owner 2026-09-27): the till sells "Pepsi", "Diet
 * Pepsi", "7Up", "Mirinda", "Mountain Dew" — brand names are fine on the till,
 * the kitchen ticket and the receipt, but never where customers look (owner
 * 2026-09-25: "we are not an affiliate of Pepsi"). The website shows generic
 * flavours: Cola, Diet cola, Lemon-lime, Orange, Citrus — on the item sheet,
 * in the cart and checkout, on the order tracker, in /api/menu and the JSON-LD.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PublishedMenu, PublishedMenuItem, PublishedModifierGroup, WebOrderItem } from '@cheeseoclock/shared-types';
import { lineChoices, whatsappOrderText, itemLabel } from './cart';
import {
  buildMenuView,
  dealWorthCents,
  drinkChoiceName,
  drinkFlavourName,
  groupLabel,
  menuWithoutDrinkBrand,
  optionLabel,
  orderItemsWithoutDrinkBrand,
  sheetGroups,
  withoutDrinkBrand,
} from './menu-view';
import { orderItemChoices } from './order-display';
import { menuNode } from './seo';
import { validateModifierSelection } from './order-validation';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));

const BRANDS = /pepsi|mirinda|7\s*-?\s*up|mountain\s*dew/i;
const FLAVOURS = ['Pepsi', 'Diet Pepsi', '7Up', 'Mirinda', 'Mountain Dew'];

function group(
  id: string,
  name: string,
  options: Array<[string, number]>,
  over: Partial<PublishedModifierGroup> = {},
): PublishedModifierGroup {
  return {
    posGroupId: id,
    name,
    selectionType: 'multi',
    minSelect: 0,
    maxSelect: options.length,
    isRequired: false,
    sortOrder: 0,
    modifiers: options.map(([o, cents], i) => ({
      // Real ids are uuids: an id never carries the name (a brand in an id would be a false alarm).
      posModifierId: `${id}:${i}`,
      name: o,
      priceDeltaCents: cents,
      isDefault: false,
      sortOrder: i,
    })),
    ...over,
  };
}
const required = { selectionType: 'single' as const, minSelect: 1, maxSelect: 1, isRequired: true };

/** The id of an item's choice, found by the till's name for it. */
function modId(it: PublishedMenuItem, name: string): string {
  const m = it.modifierGroups.flatMap((g) => g.modifiers).find((x) => x.name === name);
  if (!m) throw new Error(`no choice ${name} on ${it.name}`);
  return m.posModifierId;
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

/** The menu the till publishes after the 2026-09-27 import (menu import cheeseoclock-menu-import.json). */
function tillMenu(): PublishedMenu {
  const addDrink = group(
    'g-add-drink',
    'Add a drink',
    FLAVOURS.flatMap((f): Array<[string, number]> => [
      [`${f} 345 ml`, 12_000],
      [`${f} 1 litre`, 25_000],
    ]),
    { maxSelect: 3, sortOrder: 3 },
  );
  const flavour = (size: string) =>
    group(`g-flavour-${size}`, `Choose a flavour · ${size}`, FLAVOURS.map((f): [string, number] => [f, 0]), required);
  return {
    categories: [
      {
        posCategoryId: 'c-pizza',
        name: 'Pizza',
        displayOrder: 1,
        items: [
          item('fajita-m', 'Fajita Pizza — Medium', 1500),
          item('fajita-l', 'Fajita Pizza — Large', 2000, {
            modifierGroups: [
              group('g-leave', 'Leave out · Fajita Pizza', [['No onion', 0]], { sortOrder: 0 }),
              group('g-extra', 'Extra toppings', [['Extra cheese', 15_000]], { sortOrder: 1 }),
              group('g-dips', 'Dips on the side', [['Side of Ranch', 10_000]], { sortOrder: 2 }),
              addDrink,
            ],
          }),
        ],
      },
      {
        posCategoryId: 'c-deals',
        name: 'Value Deals',
        displayOrder: 5,
        items: [
          item('big-two', 'Big Two', 3600, {
            description: '2 Large 12" regular pizzas + 1 litre soft drink.',
            modifierGroups: [
              group('g-l1', 'Deal: Large pizza', [['Large: Fajita Pizza', 0]], { ...required, sortOrder: 0 }),
              group('g-l2', 'Deal: 2nd Large pizza', [['2nd Large: Fajita Pizza', 0]], { ...required, sortOrder: 1 }),
              group('g-deal-drink', 'Deal: 1 litre drink', FLAVOURS.map((f): [string, number] => [`${f} 1 litre`, 0]), {
                ...required,
                sortOrder: 4,
              }),
            ],
          }),
        ],
      },
      {
        posCategoryId: 'c-drinks',
        name: 'Drinks',
        displayOrder: 6,
        items: [
          item('drink-345', 'Soft Drink — 345 ml', 120, { modifierGroups: [flavour('345 ml')] }),
          item('drink-1l', 'Soft Drink — 1 litre', 250, { modifierGroups: [flavour('1 litre')] }),
        ],
      },
      {
        posCategoryId: 'c-del',
        name: 'Delivery Charges',
        displayOrder: 7,
        items: [item('del-200', 'Delivery Charge (Rs 200)', 200), item('del-250', 'Delivery Charge (Rs 250)', 250)],
      },
    ],
    publishedAt: new Date().toISOString(),
    store: { name: "Cheese O'Clock", phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}

/**
 * The till's menu after someone adds brands to the menu import's DRINK_FLAVOURS
 * ("the list to edit") without giving the website a word for them.
 */
const NEW_BRANDS = /sting|pakola/i;
function tillMenuWithNewBrands(): PublishedMenu {
  const menu = tillMenu();
  const add = (g: PublishedModifierGroup, name: string, cents: number) =>
    g.modifiers.push({
      posModifierId: `${g.posGroupId}:${g.modifiers.length}`,
      name,
      priceDeltaCents: cents,
      isDefault: false,
      sortOrder: g.modifiers.length,
    });
  const pizza = menu.categories[0]!.items[1]!;
  const addDrink = pizza.modifierGroups.find((g) => g.name === 'Add a drink')!;
  add(addDrink, 'Sting 345 ml', 12_000);
  add(addDrink, 'Sting 1 litre', 25_000);
  add(addDrink, 'Pakola 345 ml', 12_000);
  const deal = menu.categories[1]!.items[0]!;
  add(deal.modifierGroups.find((g) => g.name === 'Deal: 1 litre drink')!, 'Sting 1 litre', 0);
  for (const drink of menu.categories[2]!.items) add(drink.modifierGroups[0]!, 'Sting', 0);
  return menu;
}

describe('drinkFlavourName', () => {
  it('names each flavour the till sells generically', () => {
    expect(FLAVOURS.map(drinkFlavourName)).toEqual(['Cola', 'Diet cola', 'Lemon-lime', 'Orange', 'Citrus']);
  });

  it('keeps the size, in any case and spelling', () => {
    expect(drinkFlavourName('Pepsi 345 ml')).toBe('Cola 345 ml');
    expect(drinkFlavourName('Diet Pepsi 1 litre')).toBe('Diet cola 1 litre');
    expect(drinkFlavourName('DIET PEPSI 1 LITRE')).toBe('Diet cola 1 LITRE');
    expect(drinkFlavourName('7 Up 1 Litre')).toBe('Lemon-lime 1 Litre');
    expect(drinkFlavourName('7-UP 345ml')).toBe('Lemon-lime 345ml');
    expect(drinkFlavourName('mirinda 1L')).toBe('Orange 1L');
    expect(drinkFlavourName('Mountain Dew 345 ml')).toBe('Citrus 345 ml');
    // Inside a longer name the flavour reads in lower case.
    expect(drinkFlavourName('Add Pepsi 1 litre')).toBe('Add cola 1 litre');
  });

  it('leaves everything else alone', () => {
    for (const name of ['Soft Drink — 345 ml', 'Side of Ranch', 'Large: Fajita Pizza', 'Cheesalious', 'Add a drink', 'Upsize']) {
      expect(drinkFlavourName(name)).toBe(name);
    }
  });

  it('descriptions: "Pepsi" is a soft drink, the other brands their flavour', () => {
    expect(withoutDrinkBrand('2 Large + 1 litre Pepsi.')).toBe('2 Large + 1 litre soft drink.');
    expect(withoutDrinkBrand('Mirinda or 7Up on the side.')).toBe('Orange or lemon-lime on the side.');
    expect(BRANDS.test(withoutDrinkBrand('Diet Pepsi, Mountain Dew') ?? '')).toBe(false);
  });
});

describe('a flavour the website has no word for fails closed', () => {
  it('drinkChoiceName: a known flavour reads as itself, with the size as the till wrote it', () => {
    expect(drinkChoiceName('Mirinda 345 ml')).toBe('Orange 345 ml');
    expect(drinkChoiceName('Diet Pepsi')).toBe('Diet cola');
    expect(drinkChoiceName('7UP 1L')).toBe('Lemon-lime 1L');
    expect(drinkChoiceName('Cola 1 litre')).toBe('Cola 1 litre');
  });

  it('drinkChoiceName: any other flavour reads "Soft drink", never its name', () => {
    expect(drinkChoiceName('Sting')).toBe('Soft drink');
    expect(drinkChoiceName('Sting 345 ml')).toBe('Soft drink 345 ml');
    expect(drinkChoiceName('Pakola 1 litre')).toBe('Soft drink 1 litre');
    expect(drinkChoiceName('Pakola 1.5L')).toBe('Soft drink 1.5L');
  });

  const raw = tillMenuWithNewBrands();
  const site = menuWithoutDrinkBrand(raw);
  const labels = (it: PublishedMenuItem, group: string) =>
    it.modifierGroups.find((g) => g.name === group)!.modifiers.map((m) => optionLabel(m.name));

  it('in every drink group: a soft drink’s flavour, a deal’s drink, "Add a drink"', () => {
    expect(JSON.stringify(raw)).toMatch(NEW_BRANDS);
    expect(JSON.stringify(site)).not.toMatch(NEW_BRANDS);
    expect(JSON.stringify(site)).not.toMatch(BRANDS);
    expect(labels(site.categories[2]!.items[0]!, 'Choose a flavour · 345 ml')).toEqual([
      'Cola',
      'Diet cola',
      'Lemon-lime',
      'Orange',
      'Citrus',
      'Soft drink',
    ]);
    expect(labels(site.categories[1]!.items[0]!, 'Deal: 1 litre drink').at(-1)).toBe('Soft drink 1 litre');
    // Two that read the same are numbered, so the customer can tell them apart.
    expect(labels(site.categories[0]!.items[1]!, 'Add a drink').slice(-3)).toEqual([
      'Soft drink 345 ml (1)',
      'Soft drink 1 litre',
      'Soft drink 345 ml (2)',
    ]);
  });

  it('leaves every other group, id and price as the till sent them', () => {
    const pizza = site.categories[0]!.items[1]!;
    expect(pizza.modifierGroups.filter((g) => g.name !== 'Add a drink').flatMap((g) => g.modifiers.map((m) => m.name))).toEqual([
      'No onion',
      'Extra cheese',
      'Side of Ranch',
    ]);
    expect(labels(site.categories[1]!.items[0]!, 'Deal: Large pizza')).toEqual(['Fajita Pizza']);
    const ids = (m: PublishedMenu) =>
      m.categories.flatMap((c) =>
        c.items.flatMap((i) => i.modifierGroups.flatMap((g) => g.modifiers.map((x) => `${x.posModifierId}=${x.priceDeltaCents}`))),
      );
    expect(ids(site)).toEqual(ids(raw));
  });
});

describe('the item sheet, cart and checkout', () => {
  const raw = tillMenu();
  const site = menuWithoutDrinkBrand(raw);

  it('ships no brand to the browser, and keeps every id and price', () => {
    expect(JSON.stringify(raw)).toMatch(BRANDS); // the till's menu does name them…
    expect(JSON.stringify(site)).not.toMatch(BRANDS); // …the site's never does
    const ids = (m: PublishedMenu) =>
      m.categories.flatMap((c) =>
        c.items.flatMap((i) => [i.posItemId, i.basePriceCents, ...i.modifierGroups.flatMap((g) => g.modifiers.map((x) => `${x.posModifierId}=${x.priceDeltaCents}`))]),
      );
    expect(ids(site)).toEqual(ids(raw));
  });

  it('a soft drink asks "Choose a flavour" with generic flavours', () => {
    const drinks = buildMenuView(site).find((s) => s.name === 'Drinks')!;
    const card = drinks.cards[0]!;
    expect(card.name).toBe('Soft Drink');
    expect(card.variants.map((v) => v.size)).toEqual(['345 ml', '1 litre']);
    const [g] = sheetGroups(card.variants[0]!.item);
    expect(groupLabel(g!)).toBe('Choose a flavour');
    expect(g!.modifiers.map((m) => optionLabel(m.name))).toEqual(['Cola', 'Diet cola', 'Lemon-lime', 'Orange', 'Citrus']);
  });

  it('a pizza offers "Add a drink" after its extras, before its leave-outs', () => {
    const pizza = site.categories[0]!.items[1]!;
    expect(sheetGroups(pizza).map((g) => groupLabel(g))).toEqual(['Dips on the side', 'Extra toppings', 'Add a drink', 'Leave out']);
    const drinks = sheetGroups(pizza)[2]!;
    expect(drinks.modifiers.slice(0, 4).map((m) => [optionLabel(m.name), m.priceDeltaCents])).toEqual([
      ['Cola 345 ml', 12_000],
      ['Cola 1 litre', 25_000],
      ['Diet cola 345 ml', 12_000],
      ['Diet cola 1 litre', 25_000],
    ]);
  });

  it('a deal asks its drink after its pizzas, and still shows its saving', () => {
    const deal = site.categories[1]!.items[0]!;
    expect(sheetGroups(deal).map((g) => groupLabel(g))).toEqual(['Large pizza', '2nd Large pizza', '1 litre drink']);
    // 2 Large at Rs 2,000 + the 1 litre drink at Rs 250 — the flavour costs nothing more.
    expect(dealWorthCents(site, deal)).toBe(425_000);
    expect(dealWorthCents(raw, raw.categories[1]!.items[0]!)).toBe(425_000);
  });

  it('the cart line and the WhatsApp order say the flavour, even from the till’s own names', () => {
    const pizza = raw.categories[0]!.items[1]!; // unscrubbed: the labels still read generic
    const line = { item: pizza, modifierIds: [modId(pizza, 'Mirinda 345 ml'), modId(pizza, 'No onion')] };
    expect(lineChoices(line)).toEqual({ leaveOuts: ['No onion'], others: ['Orange 345 ml'] });
    const litre = raw.categories[2]!.items[1]!;
    const siteLitre = site.categories[2]!.items[1]!;
    const text = whatsappOrderText(
      [{ key: 'k', item: siteLitre, label: itemLabel(siteLitre), quantity: 2, modifierIds: [modId(litre, '7Up')], notes: null }],
      { fulfilment: 'pickup' },
    );
    expect(text).toContain('2 × Soft Drink · 1 litre (Lemon-lime)');
    expect(text).not.toMatch(BRANDS);
  });

  it('the JSON-LD menu names no brand — the page passes it the site menu, and it checks again', () => {
    expect(JSON.stringify(menuNode(site))).not.toMatch(BRANDS);
    const withBrandItem = tillMenu();
    withBrandItem.categories[2]!.items.push(item('pepsi-can', 'Pepsi — 345 ml', 120, { description: 'Ice cold Pepsi.' }));
    const ld = JSON.stringify(menuNode(withBrandItem));
    expect(ld).toContain('"name":"Cola — 345 ml"');
    expect(ld).not.toMatch(BRANDS);
  });

  it('a missing flavour is asked for without a brand', () => {
    const drink = raw.categories[2]!.items[0]!;
    expect(validateModifierSelection(drink, [])).toBe('"Choose a flavour" is required for "Soft Drink — 345 ml".');
  });
});

describe('the order tracker', () => {
  const placed: WebOrderItem[] = [
    {
      posItemId: 'fajita-l',
      name: 'Fajita Pizza — Large',
      quantity: 1,
      unitPriceCents: 225_000,
      modifiers: [
        { posModifierId: 'a', name: 'Pepsi 1 litre', priceDeltaCents: 25_000 },
        { posModifierId: 'b', name: 'No onion', priceDeltaCents: 0 },
      ],
      notes: null,
    },
    { posItemId: 'x', name: 'Pepsi — 345 ml', quantity: 1, unitPriceCents: 12_000, modifiers: [], notes: null },
  ];

  it('reads an order placed while the menu named brands as the menu does now', () => {
    const out = orderItemsWithoutDrinkBrand(placed) as WebOrderItem[];
    expect(JSON.stringify(out)).not.toMatch(BRANDS);
    expect(out[0]!.modifiers.map((m) => m.name)).toEqual(['Cola 1 litre', 'No onion']);
    expect(out[1]!.name).toBe('Cola — 345 ml');
    // ids, prices and the rest of the line are untouched
    expect(out[0]!.modifiers.map((m) => m.posModifierId)).toEqual(['a', 'b']);
    expect(out[0]!.unitPriceCents).toBe(225_000);
    expect(orderItemChoices(placed[0]!)).toEqual({ leaveOuts: ['No onion'], others: ['Cola 1 litre'] });
  });

  it('passes anything else through', () => {
    expect(orderItemsWithoutDrinkBrand(null)).toBeNull();
    expect(orderItemsWithoutDrinkBrand('[]')).toBe('[]');
    expect(orderItemsWithoutDrinkBrand([null, 3])).toEqual([null, 3]);
  });
});

describe('the routes', () => {
  const SECRET = 'test-bridge-secret-0123456789';

  beforeAll(async () => {
    process.env['BRIDGE_SECRET'] = SECRET;
    db.pg = new PGlite() as unknown as typeof db.pg;
    await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
    await db.pg.query(
      `INSERT INTO site_menu (id, menu_json, published_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET menu_json = EXCLUDED.menu_json`,
      [JSON.stringify(tillMenu())],
    );
    // The till is on and listening.
    const status = await import('@/app/api/bridge/status/route');
    const res = await status.PUT(
      new Request('https://site.test/api/bridge/status', {
        method: 'PUT',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ acceptingOrders: true, deviceId: 'till-1' }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('/api/menu names no brand', async () => {
    const { GET } = await import('@/app/api/menu/route');
    const body = await (await GET()).text();
    expect(body).toContain('Diet cola 1 litre');
    expect(body).not.toMatch(BRANDS);
  });

  it('an order with a drink: stored and tracked by flavour, with the till’s own ids', async () => {
    const orders = await import('@/app/api/orders/route');
    const menu = tillMenu();
    const pizza = menu.categories[0]!.items[1]!;
    const litre = menu.categories[2]!.items[1]!;
    const phone = '0300 1234599';
    const placedRes = await orders.POST(
      new Request('https://site.test/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
        body: JSON.stringify({
          customerName: 'Test Customer',
          customerPhone: phone,
          addressLine: 'House 12, Street 4',
          zoneId: 'dha-6',
          items: [
            { posItemId: 'fajita-l', quantity: 1, modifierIds: [modId(pizza, 'Mountain Dew 345 ml')] },
            { posItemId: 'drink-1l', quantity: 1, modifierIds: [modId(litre, 'Diet Pepsi')] },
          ],
        }),
      }),
    );
    const placed = (await placedRes.json()) as { ok: boolean; data: { orderId: string; subtotalCents: number } };
    expect(placed.ok).toBe(true);
    // Rs 2,000 + Rs 120 drink, Rs 250 drink, Rs 200 delivery (DHA 6)
    expect(placed.data.subtotalCents).toBe(200_000 + 12_000 + 25_000 + 20_000);

    const row = (await db.pg.query(`SELECT items_json FROM web_orders WHERE id = $1`, [placed.data.orderId])).rows[0] as {
      items_json: WebOrderItem[] | string;
    };
    const stored = typeof row.items_json === 'string' ? (JSON.parse(row.items_json) as WebOrderItem[]) : row.items_json;
    expect(stored.map((l) => l.modifiers.map((m) => m.name))).toEqual([['Citrus 345 ml'], ['Diet cola'], []]);
    // The till imports by these ids.
    expect(stored[0]!.modifiers[0]!.posModifierId).toBe(modId(pizza, 'Mountain Dew 345 ml'));

    const track = await import('@/app/api/orders/[id]/route');
    const res = await track.GET(
      new Request(`https://site.test/api/orders/${placed.data.orderId}?phone=${encodeURIComponent(phone)}`),
      { params: { id: placed.data.orderId } },
    );
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('Citrus 345 ml');
    expect(body).not.toMatch(BRANDS);
  });

  it('a brand the site has no word for: /api/menu, the stored order and the tracker say "Soft drink"', async () => {
    const menu = tillMenuWithNewBrands();
    await db.pg.query(`UPDATE site_menu SET menu_json = $1 WHERE id = 1`, [JSON.stringify(menu)]);
    const { GET } = await import('@/app/api/menu/route');
    const menuBody = await (await GET()).text();
    expect(menuBody).toContain('Soft drink 345 ml (1)');
    expect(menuBody).not.toMatch(NEW_BRANDS);

    const orders = await import('@/app/api/orders/route');
    const pizza = menu.categories[0]!.items[1]!;
    const can = menu.categories[2]!.items[0]!;
    const phone = '0300 1234598';
    const placedRes = await orders.POST(
      new Request('https://site.test/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.10' },
        body: JSON.stringify({
          customerName: 'Test Customer',
          customerPhone: phone,
          addressLine: 'House 12, Street 4',
          zoneId: 'dha-6',
          items: [
            { posItemId: 'fajita-l', quantity: 1, modifierIds: [modId(pizza, 'Sting 345 ml')] },
            { posItemId: 'drink-345', quantity: 1, modifierIds: [modId(can, 'Sting')] },
          ],
        }),
      }),
    );
    const placed = (await placedRes.json()) as { ok: boolean; data: { orderId: string } };
    expect(placed.ok).toBe(true);
    const row = (await db.pg.query(`SELECT items_json FROM web_orders WHERE id = $1`, [placed.data.orderId])).rows[0] as {
      items_json: WebOrderItem[] | string;
    };
    const stored = typeof row.items_json === 'string' ? (JSON.parse(row.items_json) as WebOrderItem[]) : row.items_json;
    expect(stored.map((l) => l.modifiers.map((m) => m.name))).toEqual([['Soft drink 345 ml (1)'], ['Soft drink'], []]);
    // The till still gets its own ids, so the kitchen ticket names the flavour.
    expect(stored[1]!.modifiers[0]!.posModifierId).toBe(modId(can, 'Sting'));

    const track = await import('@/app/api/orders/[id]/route');
    const res = await track.GET(
      new Request(`https://site.test/api/orders/${placed.data.orderId}?phone=${encodeURIComponent(phone)}`),
      { params: { id: placed.data.orderId } },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(NEW_BRANDS);
  });
});
