/**
 * Selling on the website (v0.7.30, sweep B5 + M2: shared-types web-bridge.ts,
 * SELLING ON THE WEBSITE), the website's side, on a real Postgres (PGlite,
 * in memory, with db/schema.sql) through the route handlers:
 *  - an item the till sets "Pick-up only" arrives with `pickupOnly: true`:
 *    the website keeps the flag, shows the item as pick-up only, and the
 *    SERVER refuses it on a delivery (a pick-up takes it); the old "pick-up
 *    only" description rule still works beside it;
 *  - a menu with no flag (a v0.7.29 till's, or a v0.7.30 till's at the
 *    defaults) is stored exactly as sent — no key added;
 *  - an item the till leaves off the website is simply not published: an
 *    order for it is refused as today's item_not_on_menu, and a saved cart
 *    drops it.
 * All menu items and figures are made up.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedMenu, PublishedMenuItem } from '@cheeseoclock/shared-types';
import { restoreLines } from './cart';
import { problemFromServer } from './checkout-validation';
import { buildMenuView, isPickupOnly, pickupOnlyNote } from './menu-view';
import { validateOrderable } from './order-validation';
import { publicMenu } from './public-menu';
import { menuNode } from './seo';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
}));
vi.mock('@/lib/db', () => ({
  sql: () => async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values)).rows,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const menuRoute = await import('@/app/api/bridge/menu/route');
const bridgeStatus = await import('@/app/api/bridge/status/route');
const orders = await import('@/app/api/orders/route');

const SECRET = 'test-bridge-secret-0123456789';
function bridge(path: string, init?: { method?: string; body?: unknown }) {
  return new Request(`https://site.test${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
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
/** A made-up menu; `wings` as the till sends it (flagged or not). */
function menu(wings: PublishedMenuItem = item('wings', 'Test Wings', 600, { pickupOnly: true })): PublishedMenu {
  return {
    categories: [
      {
        posCategoryId: 'c-food',
        name: 'Test Food',
        displayOrder: 1,
        items: [item('burger', 'Test Burger', 700, { description: 'Made-up burger.' }), wings],
      },
      {
        posCategoryId: 'c-del',
        name: 'Delivery Charges',
        displayOrder: 6,
        items: [item('fee-200', 'Delivery Charge (Rs 200)', 200), item('fee-250', 'Delivery Charge (Rs 250)', 250)],
      },
    ],
    publishedAt: '2026-09-27T09:00:00.000Z',
    store: { name: 'Test Shop', phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}

async function publish(m: PublishedMenu) {
  const res = await menuRoute.PUT(bridge('/api/bridge/menu', { method: 'PUT', body: m }));
  expect(res.status).toBe(200);
}
async function storedMenu(): Promise<PublishedMenu> {
  const rows = (await db.pg.query('SELECT menu_json FROM site_menu WHERE id = 1', [])).rows as Array<{ menu_json: PublishedMenu | string }>;
  const v = rows[0]!.menu_json;
  return typeof v === 'string' ? (JSON.parse(v) as PublishedMenu) : v;
}

let ip = 0;
async function place(body: Record<string, unknown>) {
  ip += 1;
  const res = await orders.POST(
    new Request('https://site.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.4.0.${ip}` },
      body: JSON.stringify({
        customerName: 'Test Customer',
        customerPhone: `0300 4${String(ip).padStart(6, '0')}`,
        addressLine: 'House 1, Street 1',
        zoneId: 'dha-6',
        ...body,
      }),
    }),
  );
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; message?: string; itemId?: string } };
}
const line = (posItemId: string) => ({ posItemId, quantity: 1, modifierIds: [] });

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  await db.pg.query('DELETE FROM site_menu', []);
  // The till is on, listening, and takes pick-ups.
  const res = await bridgeStatus.PUT(
    bridge('/api/bridge/status', { method: 'PUT', body: { acceptingOrders: true, deviceId: 'till-1', features: ['pickup'] } }),
  );
  expect(res.status).toBe(200);
});

describe('"Pick-up only" from the till (pickupOnly: true)', () => {
  it('the website keeps the flag the till sends (the bridge used to strip it)', async () => {
    const m = menu();
    await publish(m);
    const stored = await storedMenu();
    expect(stored).toEqual(m);
    expect(stored.categories[0]!.items.find((i) => i.posItemId === 'wings')?.pickupOnly).toBe(true);
  });

  it('the menu page shows it as pick-up only, and the public menu carries the flag to the browser', async () => {
    await publish(menu());
    const shown = publicMenu(await storedMenu());
    const card = buildMenuView(shown)
      .flatMap((s) => s.cards)
      .find((c) => c.name === 'Test Wings')!;
    expect(card.pickupOnly).toBe(true);
    expect(isPickupOnly(card.variants[0]!.item)).toBe(true);
    expect(buildMenuView(shown).flatMap((s) => s.cards).find((c) => c.name === 'Test Burger')!.pickupOnly).toBe(false);
    // Never into the JSON-LD (named fields only).
    expect(JSON.stringify(menuNode(shown))).not.toContain('pickupOnly');
  });

  it('the SERVER refuses it on a delivery; a pick-up takes it', async () => {
    await publish(menu());
    const r = await place({ items: [line('burger'), line('wings')] });
    expect([r.status, r.json.error, r.json.message]).toEqual([
      409,
      'not_deliverable',
      "Test Wings is pick-up only, so we can't deliver it. Switch to pick-up, or remove it to order delivery.",
    ]);
    const pickup = await place({ fulfilment: 'pickup', addressLine: undefined, zoneId: undefined, items: [line('wings')] });
    expect(pickup.status).toBe(200);
    // The rest of the menu delivers as before.
    expect((await place({ items: [line('burger')] })).status).toBe(200);
  });

  it('the description rule stays as the fallback: "Pick up only." with no flag, or with the flag false', async () => {
    for (const wings of [
      item('wings', 'Test Wings', 600, { description: 'Pick up only.' }),
      item('wings', 'Test Wings', 600, { description: 'Pick up only.', pickupOnly: false }),
    ]) {
      await publish(menu(wings));
      const r = await place({ items: [line('wings')] });
      expect([r.status, r.json.error]).toEqual([409, 'not_deliverable']);
    }
    expect(isPickupOnly({ description: null, pickupOnly: true })).toBe(true);
    expect(isPickupOnly({ description: null })).toBe(false);
    expect(isPickupOnly({ description: 'Made-up.', pickupOnly: false })).toBe(false);
    expect(validateOrderable(item('x', 'Test Wings', 600, { pickupOnly: true }), 'pickup')).toBeNull();
  });

  it('a menu with no flag (a v0.7.29 till, or every item on the website) is stored exactly as sent, no key added, and delivers as before', async () => {
    const m = menu(item('wings', 'Test Wings', 600));
    await publish(m);
    const stored = await storedMenu();
    expect(stored).toEqual(m);
    expect(JSON.stringify(stored)).not.toContain('pickupOnly');
    expect((await place({ items: [line('wings')] })).status).toBe(200);
  });

  it('a later publish without the flag (a v0.7.29 till) sells it for delivery again — why both tills update the same day', async () => {
    await publish(menu());
    await publish(menu(item('wings', 'Test Wings', 600)));
    expect((await place({ items: [line('wings')] })).status).toBe(200);
  });
});

describe('one size of a pizza set "Pick-up only": only that size is (each size is its own till item)', () => {
  /** A made-up pizza in two sizes, each a till item of its own, as the till publishes them; `large` as sent. */
  const sized = (large: Partial<PublishedMenuItem> = { pickupOnly: true }, medium: Partial<PublishedMenuItem> = {}): PublishedMenu => {
    const m = menu(item('wings', 'Test Wings', 600));
    return {
      ...m,
      categories: [
        {
          posCategoryId: 'c-pizza',
          name: 'Test Pizzas',
          displayOrder: 0,
          items: [
            item('pz-m', 'Test Pizza — Medium', 900, { sortOrder: 1, ...medium }),
            item('pz-l', 'Test Pizza — Large', 1400, { sortOrder: 2, ...large }),
          ],
        },
        ...m.categories,
      ],
    };
  };
  const card = (m: PublishedMenu) =>
    buildMenuView(publicMenu(m))
      .flatMap((s) => s.cards)
      .find((c) => c.name === 'Test Pizza')!;

  it('the card: the Medium orders as ever, the Large alone is pick-up only — never the whole card', async () => {
    await publish(sized());
    const c = card(await storedMenu());
    expect(c.pickupOnly).toBe(false);
    expect(c.variants.map((v) => [v.size, v.pickupOnly])).toEqual([
      ['Medium', false],
      ['Large', true],
    ]);
    expect(pickupOnlyNote(c)).toBe('Large 12" pick-up only');
  });

  it('the SERVER refuses only the Large on a delivery, naming its size; the Medium delivers; a pick-up takes the Large', async () => {
    await publish(sized());
    expect((await place({ items: [line('pz-m')] })).status).toBe(200);
    const r = await place({ items: [line('pz-m'), line('pz-l')] });
    expect([r.status, r.json.error, r.json.message]).toEqual([
      409,
      'not_deliverable',
      "Test Pizza (Large) is pick-up only, so we can't deliver it. Switch to pick-up, or remove it to order delivery.",
    ]);
    expect((await place({ fulfilment: 'pickup', addressLine: undefined, zoneId: undefined, items: [line('pz-l')] })).status).toBe(200);
  });

  it('every size set pick-up only: the whole card is, as before', async () => {
    await publish(sized({ pickupOnly: true }, { pickupOnly: true }));
    const c = card(await storedMenu());
    expect(c.pickupOnly).toBe(true);
    expect(pickupOnlyNote(c)).toBe('Pick-up only');
  });

  it('the printed menu’s words on one size still cover the whole card, as before (no flag anywhere)', async () => {
    await publish(sized({ description: 'Pick up only.' }));
    const c = card(await storedMenu());
    expect(c.pickupOnly).toBe(true);
    expect(c.variants.every((v) => v.pickupOnly)).toBe(true);
    expect(pickupOnlyNote(c)).toBe('Pick-up only');
    // …and the server's words for it are today's, with no size.
    const r = await place({ items: [line('pz-l')] });
    expect(r.json.message).toBe("Test Pizza is pick-up only, so we can't deliver it. Switch to pick-up, or remove it to order delivery.");
  });

  it('no flag and no words: nothing pick-up only (the website as before)', async () => {
    await publish(sized({}));
    const c = card(await storedMenu());
    expect([c.pickupOnly, ...c.variants.map((v) => v.pickupOnly)]).toEqual([false, false, false]);
    expect(pickupOnlyNote(c)).toBeNull();
  });
});

describe('an item the till leaves off the website', () => {
  /** The till's publish with the wings "Not on the website" (or their category off): simply not in it. */
  const withoutWings = (): PublishedMenu => {
    const m = menu();
    return { ...m, categories: m.categories.map((c) => ({ ...c, items: c.items.filter((i) => i.posItemId !== 'wings') })) };
  };

  it('an order for it is refused as today’s item_not_on_menu, and the checkout says to refresh', async () => {
    await publish(withoutWings());
    const r = await place({ items: [line('burger'), line('wings')] });
    expect([r.status, r.json.error, r.json.itemId]).toEqual([409, 'item_not_on_menu', 'wings']);
    expect(problemFromServer(r.json).message).toBe('The menu was just updated — please refresh the page and try again.');
    expect((await place({ fulfilment: 'pickup', addressLine: undefined, zoneId: undefined, items: [line('wings')] })).json.error).toBe(
      'item_not_on_menu',
    );
  });

  it('a cart saved on the phone drops it on the next visit', async () => {
    await publish(withoutWings());
    const { lines, dropped } = restoreLines(publicMenu(await storedMenu()), [
      { posItemId: 'burger', quantity: 1, modifierIds: [], notes: null },
      { posItemId: 'wings', quantity: 2, modifierIds: [], notes: null },
    ]);
    expect(lines.map((l) => l.item.posItemId)).toEqual(['burger']);
    expect(dropped).toBe(1);
  });
});
