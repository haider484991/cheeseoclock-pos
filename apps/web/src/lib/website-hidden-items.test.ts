/**
 * Items the website hides (lib/website-hidden-items, owner 2026-10-01: Meat Lovers), on a real Postgres
 * (PGlite, in memory, with db/schema.sql): gone from /api/menu, the /menu page's props (publicMenu), the
 * pages' menu facts (home lineup, price words), and refused by the checkout — while every other item, and
 * a menu without the hidden item, is exactly as before.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PublishedMenu, PublishedMenuItem } from '@cheeseoclock/shared-types';
import { HIDDEN_ON_WEBSITE, withoutHiddenItems } from './website-hidden-items';
import { publicMenu } from './public-menu';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));

// The heartbeat refreshes the kept pages once after a deploy (lib/deploy-refresh): no Next server here.
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const MEAT_LOVERS = '01a0ed81-9cff-7554-a66a-4365c43741ea';
const SECRET = 'test-bridge-secret-0123456789';

function item(id: string, name: string, priceRs: number): PublishedMenuItem {
  return { posItemId: id, name, description: null, basePriceCents: priceRs * 100, taxRateBps: 1500, imageUrl: null, sortOrder: 0, modifierGroups: [] };
}

function shopMenu(): PublishedMenu {
  return {
    categories: [
      {
        posCategoryId: 'c-sig',
        name: 'Signature Pizzas',
        displayOrder: 1,
        items: [item('cheetos-l', 'Cheetos — Large', 2200), item(MEAT_LOVERS, 'Meat Lovers — Large', 2200), item('star-l', 'Cheesy Star — Large', 2200)],
      },
      { posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 2, items: [item('fajita-l', 'Fajita Pizza — Large', 2000)] },
    ],
    publishedAt: new Date().toISOString(),
    store: { name: "Cheese O'Clock", phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}

const names = (m: { categories: Array<{ items: Array<{ name: string }> }> }) => m.categories.flatMap((c) => c.items.map((i) => i.name));

describe('withoutHiddenItems', () => {
  it('hides the shop till’s Meat Lovers (by its item id), and only it', () => {
    expect(HIDDEN_ON_WEBSITE.has(MEAT_LOVERS)).toBe(true);
    const shown = withoutHiddenItems(shopMenu());
    expect(names(shown)).toEqual(['Cheetos — Large', 'Cheesy Star — Large', 'Fajita Pizza — Large']);
    expect(shown.categories.map((c) => c.name)).toEqual(['Signature Pizzas', 'Pizza']);
  });

  it('leaves a menu without a hidden item as the very same object (every page the golden copy pins is unchanged)', () => {
    const m = shopMenu();
    m.categories[0]!.items = m.categories[0]!.items.filter((i) => i.posItemId !== MEAT_LOVERS);
    expect(withoutHiddenItems(m)).toBe(m);
  });

  it('a category left with no items is left out; one that had none stays', () => {
    const m = shopMenu();
    m.categories.push({ posCategoryId: 'c-empty', name: 'Coming soon', displayOrder: 9, items: [] });
    const shown = withoutHiddenItems(m, new Set(['fajita-l']));
    expect(shown.categories.map((c) => c.name)).toEqual(['Signature Pizzas', 'Coming soon']);
  });

  it('an empty list hides nothing', () => {
    const m = shopMenu();
    expect(withoutHiddenItems(m, new Set())).toBe(m);
  });

  it('publicMenu (the /menu page and /api/menu) never carries it', () => {
    expect(names(publicMenu(shopMenu()))).not.toContain('Meat Lovers — Large');
    expect(JSON.stringify(publicMenu(shopMenu()))).not.toContain(MEAT_LOVERS);
  });
});

describe('on the website (PGlite)', () => {
  let menuRoute: typeof import('@/app/api/menu/route');
  let ordersRoute: typeof import('@/app/api/orders/route');
  let statusRoute: typeof import('@/app/api/bridge/status/route');
  let siteFacts: typeof import('./site-facts');
  const before = process.env['DATABASE_URL'];

  beforeAll(async () => {
    process.env['BRIDGE_SECRET'] = SECRET;
    process.env['DATABASE_URL'] = 'postgres://pglite.test/db';
    db.pg = new PGlite() as unknown as typeof db.pg;
    await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
    await db.pg.query(
      `INSERT INTO site_menu (id, menu_json, published_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET menu_json = EXCLUDED.menu_json`,
      [JSON.stringify(shopMenu())],
    );
    menuRoute = await import('@/app/api/menu/route');
    ordersRoute = await import('@/app/api/orders/route');
    statusRoute = await import('@/app/api/bridge/status/route');
    siteFacts = await import('./site-facts');
    // The till's heartbeat: the shop is taking orders.
    const res = await statusRoute.PUT(
      new Request('https://site.test/api/bridge/status', {
        method: 'PUT',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ acceptingOrders: true, deviceId: 'till-1', features: ['pickup'], pickupDiscountPercent: 10 }),
      }),
    );
    expect(res.status).toBe(200);
  });

  afterAll(() => {
    if (before === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = before;
  });

  it('GET /api/menu leaves it out', async () => {
    const res = await menuRoute.GET();
    const body = (await res.json()) as { ok: boolean; data: PublishedMenu };
    expect(body.ok).toBe(true);
    expect(names(body.data)).toEqual(['Cheetos — Large', 'Cheesy Star — Large', 'Fajita Pizza — Large']);
  });

  it('the pages’ menu facts (home lineup, price words) leave it out', async () => {
    const facts = await siteFacts.getMenuFacts();
    expect(facts).not.toBeNull();
    expect(names(facts!)).toEqual(['Cheetos — Large', 'Cheesy Star — Large', 'Fajita Pizza — Large']);
  });

  let n = 0;
  const place = async (posItemId: string) => {
    n += 1;
    const res = await ordersRoute.POST(
      new Request('https://site.test/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${n}` },
        body: JSON.stringify({
          customerName: 'Test Customer',
          customerPhone: `0300 77700${String(n).padStart(2, '0')}`,
          fulfilment: 'pickup',
          items: [{ posItemId, quantity: 1, modifierIds: [] }],
        }),
      }),
    );
    return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string } };
  };

  it('the checkout refuses a basket that still has it', async () => {
    const r = await place(MEAT_LOVERS);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, error: 'item_not_on_menu' });
  });

  it('and still takes every other item', async () => {
    const r = await place('cheetos-l');
    expect(r.json.ok).toBe(true);
    expect(r.status).toBe(200);
  });
});
