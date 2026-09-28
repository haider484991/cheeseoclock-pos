/**
 * The owner's settings block (Settings step 3) on a real Postgres (PGlite, in
 * memory, with db/schema.sql), end to end through the route handlers:
 *  - PUT /api/bridge/menu stores the menu and the block together or not at
 *    all, keeps the stored block when an older till publishes without one,
 *    ignores an older stamp, and says what it did (the till's contract,
 *    shared-types web-bridge.ts); the block is the one the till's own code
 *    builds (pos-domain buildSettingsBlock);
 *  - the pages read it (getSiteFacts), and fall back to the built-in areas
 *    with no block or a database error;
 *  - POST /api/orders takes only an area that is on, charges its fee by its
 *    own fee item, and falls back by name and price, then to the note;
 *  - pick-up is offered and priced from the block.
 * All menu items and figures are made up.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  type DeliveryZoneSetting,
  type PublishedMenu,
  type PublishedMenuItem,
  type PublishedSettings,
  type WebOrderItem,
} from '@cheeseoclock/shared-types';
import { buildSettingsBlock } from '../../../../packages/pos-domain/src/delivery-charge';
import { getArea, renderArea } from './areas';
import { DEFAULT_FACTS } from './delivery-facts';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  /** Make the next queries fail, as a database outage would. */
  fail: null as Error | null,
  /** Runs once after the next query whose text matches (a till's publish landing in between two reads). */
  after: null as { match: RegExp; run: () => Promise<void> } | null,
}));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (db.fail) throw db.fail;
    const text = strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, '');
    const rows = (await db.pg.query(text, values)).rows;
    const hook = db.after;
    if (hook && hook.match.test(text)) {
      db.after = null;
      await hook.run();
    }
    return rows;
  },
}));
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => {
    revalidated.push(`${path} ${type ?? ''}`.trim());
  },
}));

const menuRoute = await import('@/app/api/bridge/menu/route');
const bridgeStatus = await import('@/app/api/bridge/status/route');
const orders = await import('@/app/api/orders/route');
const storeStatus = await import('@/app/api/store-status/route');
const { getSiteFacts } = await import('@/lib/site-facts');

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

/** A made-up menu: one pizza and the given delivery charge items. */
function menu(charges: PublishedMenuItem[], extra: PublishedMenuItem[] = []): PublishedMenu {
  return {
    categories: [
      { posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 1, items: [item('test-pizza', 'Test Pizza — Large', 2000), ...extra] },
      { posCategoryId: 'c-del', name: 'Delivery Charges', displayOrder: 6, items: charges },
    ],
    publishedAt: '2026-09-27T09:00:00.000Z',
    store: { name: 'Test Shop', phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}
const RS200 = item('fee-200', 'Delivery Charge (Rs 200)', 200);
const RS250 = item('fee-250', 'Delivery Charge (Rs 250)', 250);
const RS300 = item('fee-300', 'Delivery Charge (Rs 300)', 300);
const RS350 = item('fee-350', 'Delivery Charge (Rs 350)', 350);

type ZoneEdit = (zones: DeliveryZoneSetting[]) => void;

/**
 * The block the till sends for this menu: its own code (buildSettingsBlock),
 * from today's areas with `edit` applied, stamped as saved `rev` times.
 */
function tillBlock(
  m: PublishedMenu,
  opts: {
    edit?: ZoneEdit;
    rev?: number;
    at?: string;
    /** The pick-up offer's row (a second carried key), when saved. */
    pickupAt?: string;
    pickup?: { offered: boolean; percent: number };
    device?: string;
  } = {},
): PublishedSettings {
  const zones = DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] }));
  opts.edit?.(zones);
  return buildSettingsBlock({
    zones,
    pickup: opts.pickup ?? { offered: true, percent: 10 },
    stamps: [
      { version: opts.rev ?? 1, updatedAt: opts.at ?? '2026-09-27T10:00:00.000Z' },
      opts.pickupAt ? { version: 1, updatedAt: opts.pickupAt } : null,
    ],
    menuItems: m.categories.flatMap((c) => c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents }))),
    deviceId: opts.device ?? 'till-1',
  });
}
const zone = (zs: DeliveryZoneSetting[], id: string) => zs.find((z) => z.id === id)!;
/** Phase 8 at Rs 300 on its own fee item. */
const phase8At300: ZoneEdit = (zs) => {
  zone(zs, 'dha-8').feeCents = 30_000;
  zone(zs, 'dha-8').feeItemId = 'fee-300';
};

async function publish(m: PublishedMenu, settings?: PublishedSettings) {
  const res = await menuRoute.PUT(bridge('/api/bridge/menu', { method: 'PUT', body: settings ? { ...m, settings } : m }));
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; message?: string; data?: Record<string, unknown> } };
}

async function storedRow(): Promise<PublishedMenu | null> {
  const rows = (await db.pg.query('SELECT menu_json FROM site_menu WHERE id = 1', [])).rows as Array<{ menu_json: PublishedMenu | string }>;
  const v = rows[0]?.menu_json;
  if (!v) return null;
  return typeof v === 'string' ? (JSON.parse(v) as PublishedMenu) : v;
}

async function heartbeat(features?: string[], pickupDiscountPercent?: number) {
  const res = await bridgeStatus.PUT(
    bridge('/api/bridge/status', {
      method: 'PUT',
      body: { acceptingOrders: true, deviceId: 'till-1', features, pickupDiscountPercent },
    }),
  );
  expect(res.status).toBe(200);
}

let ip = 0;
async function place(body: Record<string, unknown>) {
  const res = await orders.POST(
    new Request('https://site.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${++ip}` },
      body: JSON.stringify({
        customerName: 'Test Customer',
        customerPhone: `0300 22345${String(ip).padStart(2, '0')}`,
        addressLine: 'House 1, Street 1',
        items: [{ posItemId: 'test-pizza', quantity: 1, modifierIds: [] }],
        ...body,
      }),
    }),
  );
  return {
    status: res.status,
    json: (await res.json()) as {
      ok: boolean;
      error?: string;
      message?: string;
      data?: { orderId: string; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number };
    },
  };
}

async function storedOrder(id: string) {
  const rows = (await db.pg.query('SELECT area, notes, items_json, subtotal_cents, tax_cents, total_cents FROM web_orders WHERE id = $1', [id]))
    .rows as Array<{ area: string; notes: string | null; items_json: WebOrderItem[] | string; subtotal_cents: number; tax_cents: number; total_cents: number }>;
  const row = rows[0]!;
  return { ...row, items: typeof row.items_json === 'string' ? (JSON.parse(row.items_json) as WebOrderItem[]) : row.items_json };
}

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  // getSiteFacts reads only when a database is configured; the mock above is it.
  process.env['DATABASE_URL'] = 'postgres://test.invalid/db';
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  db.fail = null;
  revalidated.length = 0;
  await db.pg.query('DELETE FROM site_menu', []);
  await heartbeat();
});

describe('PUT /api/bridge/menu with the settings block', () => {
  it('without a block (a till older than the block) stores the menu exactly as before', async () => {
    const m = menu([RS200, RS250]);
    const r = await publish(m);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({
      categories: 2,
      items: 3,
      settings: 'none',
      settingsAt: null,
      settingsRev: null,
      settingsTie: null,
      settingsDeviceId: null,
      settingsProblem: null,
    });
    expect(await storedRow()).toEqual(m);
    expect(await getSiteFacts()).toBe(DEFAULT_FACTS);
    expect(revalidated).toEqual(['/ layout']);
  });

  it('stores the till’s block with the menu and says so', async () => {
    const m = menu([RS200, RS250]);
    const block = tillBlock(m, { rev: 2, at: '2026-09-27T10:00:00.000Z' });
    // The till's own block names today's items by name and price.
    expect(block.zones.find((z) => z.id === 'dha-8')?.feeItemId).toBe('fee-250');
    const r = await publish(m, block);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ settings: 'stored', settingsRev: 2, settingsAt: '2026-09-27T10:00:00.000Z' });
    expect((await storedRow())?.settings).toEqual(block);
    const facts = await getSiteFacts();
    expect(facts.source).toBe('settings');
    expect(facts.zones.map((z) => z.id)).toEqual(DEFAULT_DELIVERY_ZONES.zones.map((z) => z.id));
    expect(revalidated).toEqual(['/ layout']);
    // The bridge can read back which block the website holds.
    const st = (await (await bridgeStatus.GET(bridge('/api/bridge/status'))).json()) as { data: { settings: unknown } };
    expect(st.data.settings).toEqual({
      settingsRev: 2,
      settingsAt: '2026-09-27T10:00:00.000Z',
      settingsTie: Date.parse('2026-09-27T10:00:00.000Z'),
      settingsDeviceId: 'till-1',
      settingsProblem: null,
    });
  });

  it('keeps the stored block when a till publishes without one', async () => {
    const m = menu([RS200, RS250, RS300]);
    const block = tillBlock(m, { edit: phase8At300, rev: 2 });
    await publish(m, block);
    const older = menu([RS200, RS250, RS300], [item('new-item', 'New Test Item', 500)]);
    const r = await publish(older);
    expect(r.json.data).toMatchObject({ settings: 'kept', settingsRev: 2, settingsAt: block.settingsAt, items: 5 });
    const row = await storedRow();
    expect(row?.categories[0]?.items.map((i) => i.posItemId)).toContain('new-item');
    expect(row?.settings).toEqual(block);
  });

  it('ignores a block with an older stamp, and still stores the menu', async () => {
    const m = menu([RS200, RS250, RS300]);
    const newer = tillBlock(m, { edit: phase8At300, rev: 3, at: '2026-09-27T11:00:00.000Z' });
    await publish(m, newer);
    const stale = tillBlock(m, { rev: 2, at: '2026-09-27T12:00:00.000Z', device: 'till-2' }); // the other till: later clock, fewer saves: older
    const m2 = menu([RS200, RS250, RS300], [item('new-item', 'New Test Item', 500)]);
    const r = await publish(m2, stale);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ settings: 'ignored_older', settingsRev: 3, settingsAt: '2026-09-27T11:00:00.000Z' });
    const row = await storedRow();
    expect(row?.settings).toEqual(newer);
    expect(row?.categories[0]?.items.map((i) => i.posItemId)).toContain('new-item');
  });

  it('orders stamps by revision first, then time; an equal stamp replaces', async () => {
    const m = menu([RS200, RS250, RS300]);
    await publish(m, tillBlock(m, { rev: 4, at: '2026-09-27T12:00:00.000Z' }));
    // A till that saved twice offline: more saves, older clock — it wins.
    const r = await publish(m, tillBlock(m, { edit: phase8At300, rev: 5, at: '2026-09-27T09:00:00.000Z' }));
    expect(r.json.data).toMatchObject({ settings: 'stored', settingsRev: 5 });
    const same = tillBlock(m, { edit: (zs) => (zone(zs, 'emaar').active = false), rev: 5, at: '2026-09-27T09:00:00.000Z' });
    expect((await publish(m, same)).json.data).toMatchObject({ settings: 'stored' });
    expect((await storedRow())?.settings?.zones.find((z) => z.id === 'emaar')?.active).toBe(false);
  });

  it('the same versions and newest time but another area list (two tills saved offline): the settled list, whose times sum higher, replaces the published one — never the other way', async () => {
    const m = menu([RS200, RS250, RS300]);
    // Till A: areas at 10:00, pick-up at 10:05.
    const published = tillBlock(m, { rev: 1, at: '2026-09-27T10:00:00.000Z', pickupAt: '2026-09-27T10:05:00.000Z' });
    expect((await publish(m, published)).json.data).toMatchObject({ settings: 'stored', settingsRev: 2, settingsAt: '2026-09-27T10:05:00.000Z' });
    // What the tills settle on: the other till's areas saved at 10:02 (same version), the same pick-up.
    const settled = tillBlock(m, { edit: phase8At300, rev: 1, at: '2026-09-27T10:02:00.000Z', pickupAt: '2026-09-27T10:05:00.000Z', device: 'till-2' });
    expect([settled.settingsRev, settled.settingsAt]).toEqual([published.settingsRev, published.settingsAt]);
    expect((await publish(m, settled)).json.data).toMatchObject({ settings: 'stored', settingsTie: settled.settingsTie });
    // Till A, not caught up yet, publishing again: its list is the older one now.
    expect((await publish(m, published)).json.data).toMatchObject({ settings: 'ignored_older', settingsTie: settled.settingsTie });
    expect((await storedRow())?.settings?.zones.find((z) => z.id === 'dha-8')).toMatchObject({ feeCents: 30_000 });
  });

  it('a till may replace its OWN block with a later Save (restored from an older backup), never another till’s', async () => {
    const m = menu([RS200, RS250, RS300]);
    await publish(m, tillBlock(m, { rev: 5, at: '2026-09-01T00:00:00.000Z', device: 'till-1' }));
    // The other till with fewer saves: older, kept out.
    expect((await publish(m, tillBlock(m, { rev: 3, at: '2026-09-15T00:00:00.000Z', device: 'till-2' }))).json.data).toMatchObject({
      settings: 'ignored_older',
      settingsRev: 5,
    });
    // The same till, restored (its row back in August): not a later Save — kept out.
    expect((await publish(m, tillBlock(m, { rev: 3, at: '2026-08-01T00:00:00.000Z', device: 'till-1' }))).json.data).toMatchObject({
      settings: 'ignored_older',
    });
    // The same till's Save after the restore: taken.
    const after = tillBlock(m, { edit: phase8At300, rev: 4, at: '2026-09-20T00:00:00.000Z', device: 'till-1' });
    expect((await publish(m, after)).json.data).toMatchObject({ settings: 'stored', settingsRev: 4, settingsDeviceId: 'till-1' });
    expect((await storedRow())?.settings).toEqual(after);
  });

  it('a kept block that names a fee item the new menu lacks (a till behind on the link published): stored as asked, and the answer — and the status read — say so', async () => {
    const m = menu([RS200, RS250, RS300]);
    await publish(m, tillBlock(m, { edit: phase8At300, rev: 2 }));
    // A till that has not received the Rs 300 item yet publishes its menu (no block, or an older one).
    const behind = await publish(menu([RS200, RS250]));
    expect(behind.json.data).toMatchObject({ settings: 'kept', settingsRev: 2 });
    expect(behind.json.data?.['settingsProblem']).toMatch(/DHA Phase 8: its "Delivery Charge \(Rs 300\)" item is not on the menu/);
    const olderBlock = await publish(menu([RS200, RS250]), tillBlock(menu([RS200, RS250]), { rev: 1, device: 'till-2' }));
    expect(olderBlock.json.data).toMatchObject({ settings: 'ignored_older' });
    expect(olderBlock.json.data?.['settingsProblem']).toMatch(/DHA Phase 8/);
    const st = (await (await bridgeStatus.GET(bridge('/api/bridge/status'))).json()) as { data: { settings: { settingsProblem: string | null } } };
    expect(st.data.settings.settingsProblem).toMatch(/DHA Phase 8/);
    // The till that has the item sends its menu again: fits.
    const fixed = await publish(m, tillBlock(m, { edit: phase8At300, rev: 2 }));
    expect(fixed.json.data).toMatchObject({ settings: 'stored', settingsProblem: null });
  });

  it('refuses a block whose fee item is missing or at the wrong price — and stores nothing', async () => {
    const m = menu([RS200, RS250, RS300]);
    const good = tillBlock(m, { edit: phase8At300, rev: 1 });
    await publish(m, good);
    const before = await storedRow();

    // The Rs 300 item hidden on the till (not in this menu).
    const hidden = menu([RS200, RS250], [item('new-item', 'New Test Item', 500)]);
    const missing = await publish(hidden, { ...good, settingsRev: 2 });
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({ ok: false, error: 'settings_invalid' });
    expect(missing.json.message).toMatch(/DHA Phase 8: its "Delivery Charge \(Rs 300\)" item is not on the menu/);

    // Re-priced by an older till.
    const repriced = menu([RS200, RS250, { ...RS300, basePriceCents: 32_000 }]);
    const wrong = await publish(repriced, { ...good, settingsRev: 2 });
    expect(wrong.status).toBe(400);
    expect(wrong.json.message).toMatch(/costs Rs 320, not Rs 300/);

    expect(await storedRow()).toEqual(before);
    expect(revalidated.filter((x) => x === '/ layout')).toHaveLength(1); // only the good publish
  });

  it('refuses a malformed block, a clock far ahead and a missing area — and stores nothing', async () => {
    const m = menu([RS200, RS250]);
    await publish(m);
    const before = await storedRow();
    const block = tillBlock(m);

    const odd = { ...block, zones: block.zones.map((z) => (z.id === 'dha-6' ? { ...z, feeCents: 20_050 } : z)) };
    const r1 = await publish(m, odd);
    expect(r1.status).toBe(400);
    expect(r1.json.error).toBe('validation');

    const ahead = { ...block, settingsAt: new Date(Date.now() + 60 * 60_000).toISOString() };
    const r2 = await publish(m, ahead);
    expect(r2.json).toMatchObject({ error: 'settings_invalid' });
    expect(r2.json.message).toMatch(/clock is ahead/);

    const dropped = { ...block, zones: block.zones.filter((z) => z.id !== 'clifton-1') };
    const r3 = await publish(m, dropped);
    expect(r3.json).toMatchObject({ error: 'settings_invalid' });
    expect(r3.json.message).toMatch(/Clifton Block 1 is missing/);

    expect(await storedRow()).toEqual(before);
  });

  it('two tills publishing at once: the newer block wins whichever lands first', async () => {
    const m = menu([RS200, RS250, RS300]);
    const older = tillBlock(m, { rev: 1, at: '2026-09-27T10:00:00.000Z' });
    const newer = tillBlock(m, { edit: phase8At300, rev: 2, at: '2026-09-27T10:05:00.000Z' });
    await Promise.all([publish(m, newer), publish(m, older)]);
    expect((await storedRow())?.settings).toEqual(newer);
    await db.pg.query('DELETE FROM site_menu', []);
    await Promise.all([publish(m, older), publish(m, newer)]);
    expect((await storedRow())?.settings).toEqual(newer);
  });
});

describe('the pages read the stored block', () => {
  it('a changed fee reaches the page text and chips', async () => {
    const m = menu([RS200, RS250, RS300]);
    await publish(m, tillBlock(m, { edit: phase8At300 }));
    const p8 = renderArea(getArea('dha-phase-8')!, await getSiteFacts());
    expect(p8.fee).toBe('Rs 250–300 delivery');
    expect(p8.description).toContain('Rs 250–300 delivery');
    expect(p8.faqs.map((f) => f.a)).toContain('Yes — the Do Darya side is covered at the Phase 8 fee of Rs 300.');
  });

  it('render from the built-in areas on a database error, but let Next’s own signals through', async () => {
    const m = menu([RS200, RS250, RS300]);
    await publish(m, tillBlock(m, { edit: phase8At300 }));
    db.fail = new Error('connection refused');
    expect(await getSiteFacts()).toBe(DEFAULT_FACTS);
    db.fail = Object.assign(new Error('Dynamic server usage: no-store fetch'), { digest: 'DYNAMIC_SERVER_USAGE' });
    await expect(getSiteFacts()).rejects.toThrow(/Dynamic server usage/);
  });

  it('render from the built-in areas with no database configured', async () => {
    const url = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      expect(await getSiteFacts()).toBe(DEFAULT_FACTS);
    } finally {
      process.env['DATABASE_URL'] = url;
    }
  });
});

describe('POST /api/orders with the settings block', () => {
  it('charges the area’s fee by its own fee item', async () => {
    const m = menu([RS200, RS250, RS300]);
    await publish(m, tillBlock(m, { edit: phase8At300 }));
    const r = await place({ zoneId: 'dha-8' });
    expect(r.status).toBe(200);
    const row = await storedOrder(r.json.data!.orderId);
    expect(row.area).toBe('DHA Phase 8');
    expect(row.items.map((i) => [i.posItemId, i.unitPriceCents])).toEqual([
      ['test-pizza', 200_000],
      ['fee-300', 30_000],
    ]);
    // The till's maths: 15% on the pizza and on the fee item.
    expect(r.json.data).toMatchObject({ subtotalCents: 230_000, discountCents: 0, taxCents: 34_500, totalCents: 264_500 });
    expect(row.notes).toBeNull();
    // Other areas keep their fee.
    const c3 = await storedOrder((await place({ zoneId: 'clifton-3' })).json.data!.orderId);
    expect(c3.items.at(-1)?.posItemId).toBe('fee-200');
  });

  it('a till’s publish landing between the order’s two reads: the fee and its item come from the SAME publish (never the old fee with the new menu, never the by-hand note)', async () => {
    const m250 = menu([RS200, RS250]);
    await publish(m250, tillBlock(m250, { rev: 1 }));
    // Right after the order route reads the areas, the owner's Save moves Phase 8 to Rs 300 on its
    // own item and switches the Rs 250 item off: the menu that lands has no Rs 250 item.
    const m300 = menu([RS200, RS300]);
    db.after = {
      match: /menu_json -> 'settings' AS settings FROM site_menu/,
      run: async () => {
        const r = await publish(
          m300,
          tillBlock(m300, {
            rev: 2,
            edit: (zs) => {
              for (const z of zs) if (z.feeCents === 25_000) Object.assign(z, { feeCents: 30_000, feeItemId: 'fee-300' });
            },
          }),
        );
        expect(r.json.data).toMatchObject({ settings: 'stored' });
      },
    };
    const r = await place({ zoneId: 'dha-8' });
    expect(db.after).toBeNull();
    expect(r.status).toBe(200);
    const row = await storedOrder(r.json.data!.orderId);
    expect(row.items.map((i) => [i.posItemId, i.unitPriceCents])).toEqual([
      ['test-pizza', 200_000],
      ['fee-300', 30_000],
    ]);
    expect(row.notes).toBeNull();
    expect(r.json.data).toMatchObject({ subtotalCents: 230_000, taxCents: 34_500, totalCents: 264_500 });
  });

  it('refuses an area the owner switched off, and one it does not have', async () => {
    const m = menu([RS200, RS250]);
    await publish(m, tillBlock(m, { edit: (zs) => (zone(zs, 'emaar').active = false) }));
    const off = await place({ zoneId: 'emaar' });
    expect(off.status).toBe(400);
    expect(off.json.error).toBe('zone_paused');
    expect(off.json.message).toBe(
      'Delivery to Emaar Crescent Bay (DHA) is paused right now. Choose another area, or order on WhatsApp and we will tell you when it is back.',
    );
    const nowhere = await place({ zoneId: 'saddar' });
    expect(nowhere.json.error).toBe('outside_zone');
    expect(nowhere.json.message).toBe(
      'We deliver in DHA and Clifton only. Choose your area from the list — if it is not there, we cannot deliver to it.',
    );
  });

  it('takes a new area the owner added, and names its group when refusing', async () => {
    const m = menu([RS200, RS250, RS350]);
    await publish(
      m,
      tillBlock(m, {
        edit: (zs) =>
          zs.push({
            id: 'pechs-6',
            name: 'PECHS Block 6',
            shortName: 'Block 6',
            group: 'PECHS',
            feeCents: 35_000,
            feeItemId: 'fee-350',
            active: true,
            aliases: [],
            hints: [],
          }),
      }),
    );
    const r = await place({ zoneId: 'pechs-6' });
    expect(r.status).toBe(200);
    const row = await storedOrder(r.json.data!.orderId);
    expect(row.area).toBe('PECHS Block 6');
    expect(row.items.at(-1)).toMatchObject({ posItemId: 'fee-350', unitPriceCents: 35_000 });
    expect((await place({ zoneId: 'saddar' })).json.message).toMatch(/^We deliver in DHA, Clifton and PECHS only\./);
  });

  it('falls back by name and price, then to the note, when a kept block meets an older till’s menu', async () => {
    const m = menu([RS200, RS250, RS300]);
    await publish(m, tillBlock(m, { edit: phase8At300 }));
    // An older till's menu: its own Rs 300 item under another id; the block is kept.
    await publish(menu([RS200, RS250, item('old-300', 'Delivery Charge (Rs 300)', 300)]));
    const byName = await storedOrder((await place({ zoneId: 'dha-8' })).json.data!.orderId);
    expect(byName.items.at(-1)).toMatchObject({ posItemId: 'old-300', unitPriceCents: 30_000 });
    // …and a menu with no Rs 300 item at all: today's note for the cashier.
    await publish(menu([RS200, RS250]));
    const r = await place({ zoneId: 'dha-8', notes: 'Ring twice' });
    expect(r.status).toBe(200);
    const note = await storedOrder(r.json.data!.orderId);
    expect(note.items.map((i) => i.posItemId)).toEqual(['test-pizza']);
    expect(note.subtotal_cents).toBe(230_000);
    expect(note.notes).toBe('Delivery DHA Phase 8 Rs 300 — add the delivery charge by hand. Ring twice');
  });

  it('adds no charge line for a free area', async () => {
    const m = menu([RS200, RS250]);
    await publish(m, tillBlock(m, { edit: (zs) => (zone(zs, 'dha-6').feeCents = 0) }));
    const r = await place({ zoneId: 'dha-6' });
    const row = await storedOrder(r.json.data!.orderId);
    expect(row.items.map((i) => i.posItemId)).toEqual(['test-pizza']);
    expect(row.subtotal_cents).toBe(200_000);
    expect(row.notes).toBeNull();
  });

  it('never sells a fee item as food', async () => {
    const m = menu([RS200, RS250, RS300]);
    await publish(m, tillBlock(m, { edit: phase8At300 }));
    const r = await place({ zoneId: 'dha-6', items: [{ posItemId: 'fee-300', quantity: 1, modifierIds: [] }] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('not_deliverable');
  });
});

describe('pick-up from the block', () => {
  async function status() {
    return ((await (await storeStatus.GET()).json()) as { data: { pickupAvailable: boolean; pickupDiscountPercent: number } }).data;
  }

  it('the owner’s % beats the heartbeat’s once a block is stored', async () => {
    await heartbeat(['pickup'], 15);
    expect(await status()).toMatchObject({ pickupAvailable: true, pickupDiscountPercent: 15 }); // no block: as before
    const m = menu([RS200, RS250]);
    await publish(m, tillBlock(m, { pickup: { offered: true, percent: 20 } }));
    expect(await status()).toMatchObject({ pickupAvailable: true, pickupDiscountPercent: 20 });
    const r = await place({ fulfilment: 'pickup', addressLine: undefined });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ subtotalCents: 200_000, discountCents: 40_000, taxCents: 24_000, totalCents: 184_000 });
  });

  it('is not offered when the owner switches it off, whatever the till says', async () => {
    await heartbeat(['pickup'], 10);
    const m = menu([RS200, RS250]);
    await publish(m, tillBlock(m, { pickup: { offered: false, percent: 10 } }));
    expect((await status()).pickupAvailable).toBe(false);
    expect((await place({ fulfilment: 'pickup' })).json.error).toBe('pickup_unavailable');
  });

  it('still needs a till that can import pick-ups', async () => {
    await heartbeat();
    const m = menu([RS200, RS250]);
    await publish(m, tillBlock(m, { pickup: { offered: true, percent: 10 } }));
    expect((await status()).pickupAvailable).toBe(false);
  });
});
