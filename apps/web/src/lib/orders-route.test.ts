/**
 * POST /api/orders on a real Postgres (PGlite, in memory, with db/schema.sql):
 * delivery zones are enforced, the zone's fee reaches the till as its
 * "Delivery Charge (Rs N)" item, and pick-up-only food is refused.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedMenu, PublishedMenuItem, WebOrderItem } from '@cheeseoclock/shared-types';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));

const orders = await import('@/app/api/orders/route');

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

function menu(withCharges: boolean): PublishedMenu {
  return {
    categories: [
      {
        posCategoryId: 'c-pizza',
        name: 'Pizza',
        displayOrder: 1,
        items: [item('fajita-l', 'Fajita Pizza — Large', 2000)],
      },
      {
        posCategoryId: 'c-sides',
        name: 'Fries & Sides',
        displayOrder: 3,
        items: [item('loaded', 'Signature Loaded Fries', 700, { description: 'Pick up only.' })],
      },
      ...(withCharges
        ? [
            {
              posCategoryId: 'c-del',
              name: 'Delivery Charges',
              displayOrder: 6,
              items: [
                item('del-200', 'Delivery Charge (Rs 200)', 200),
                item('del-250', 'Delivery Charge (Rs 250)', 250),
              ],
            },
          ]
        : []),
    ],
    publishedAt: new Date().toISOString(),
    store: { name: "Cheese O'Clock", phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}

async function publish(m: PublishedMenu) {
  await db.pg.query(
    `INSERT INTO site_menu (id, menu_json, published_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET menu_json = EXCLUDED.menu_json`,
    [JSON.stringify(m)],
  );
}

let ip = 0;
async function place(body: Record<string, unknown>) {
  const req = new Request('https://site.test/api/orders', {
    method: 'POST',
    // A fresh phone and client address per call keep the flood limiter out of the way.
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++ip}` },
    body: JSON.stringify({
      customerName: 'Test Customer',
      customerPhone: `0300 12345${String(ip).padStart(2, '0')}`,
      addressLine: 'House 12, Street 4',
      items: [{ posItemId: 'fajita-l', quantity: 1, modifierIds: [] }],
      ...body,
    }),
  });
  const res = await orders.POST(req);
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; message?: string; data?: { orderId: string; subtotalCents: number; taxCents: number; totalCents: number } } };
}

async function stored(id: string) {
  const rows = (await db.pg.query(`SELECT area, notes, items_json, subtotal_cents, tax_cents, total_cents FROM web_orders WHERE id = $1`, [id])).rows as Array<{
    area: string;
    notes: string | null;
    items_json: WebOrderItem[] | string;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
  }>;
  const row = rows[0]!;
  const items = typeof row.items_json === 'string' ? (JSON.parse(row.items_json) as WebOrderItem[]) : row.items_json;
  return { ...row, items };
}

beforeAll(async () => {
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  // The till is on and listening.
  await db.pg.query(
    `INSERT INTO store_status (id, accepting_orders, updated_at) VALUES (1, true, now())
     ON CONFLICT (id) DO UPDATE SET accepting_orders = true, updated_at = now()`,
    [],
  );
  await publish(menu(true));
});

describe('POST /api/orders — delivery zones', () => {
  it('adds the zone’s delivery charge as the till’s own item', async () => {
    const r = await place({ zoneId: 'dha-6' });
    expect(r.status).toBe(200);
    const row = await stored(r.json.data!.orderId);
    expect(row.area).toBe('DHA Phase 6');
    expect(row.items.map((i) => [i.posItemId, i.unitPriceCents])).toEqual([
      ['fajita-l', 200_000],
      ['del-200', 20_000],
    ]);
    expect(row.subtotal_cents).toBe(220_000);
    expect(row.tax_cents).toBe(33_000); // 15% of pizza + fee, as the till taxes both
    expect(row.total_cents).toBe(253_000);
    expect(row.notes).toBeNull();
  });

  it('charges Rs 250 in Clifton Block 1', async () => {
    const r = await place({ zoneId: 'clifton-1' });
    const row = await stored(r.json.data!.orderId);
    expect(row.items.at(-1)?.posItemId).toBe('del-250');
    expect(row.area).toBe('Clifton Block 1');
  });

  it('refuses anywhere outside DHA and Clifton, and no zone at all', async () => {
    expect((await place({ zoneId: 'saddar' })).json.error).toBe('outside_zone');
    const none = await place({});
    expect(none.status).toBe(400);
    expect(none.json.error).toBe('validation');
  });

  it('still takes the order when the till has no charge items yet, and tells the cashier', async () => {
    await publish(menu(false));
    const r = await place({ zoneId: 'emaar', notes: 'Ring twice' });
    expect(r.status).toBe(200);
    const row = await stored(r.json.data!.orderId);
    expect(row.items.map((i) => i.posItemId)).toEqual(['fajita-l']);
    expect(row.subtotal_cents).toBe(225_000);
    expect(row.notes).toBe('Delivery Emaar Crescent Bay (DHA) Rs 250 — add the delivery charge by hand. Ring twice');
  });

  it('refuses pick-up-only food and a client-chosen delivery charge', async () => {
    const pickup = await place({
      zoneId: 'dha-6',
      items: [{ posItemId: 'loaded', quantity: 1, modifierIds: [] }],
    });
    expect(pickup.status).toBe(409);
    expect(pickup.json.error).toBe('not_deliverable');
    const sneaky = await place({
      zoneId: 'clifton-1',
      items: [
        { posItemId: 'fajita-l', quantity: 1, modifierIds: [] },
        { posItemId: 'del-200', quantity: 1, modifierIds: [] },
      ],
    });
    expect(sneaky.status).toBe(409);
  });

  it('keeps the till’s notes under its 500-character cap', async () => {
    await publish(menu(false));
    const r = await place({ zoneId: 'dha-1', notes: 'x'.repeat(500) });
    const row = await stored(r.json.data!.orderId);
    expect(row.notes!.length).toBeLessThanOrEqual(490);
  });
});
