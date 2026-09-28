/**
 * PUT /api/bridge/settings — the owner's settings block ALONE (Settings
 * step 3), what a till sends by itself after a Save: the website stores it
 * with the menu it ALREADY holds (the last one published), adding only the
 * "Delivery Charge (Rs N)" items the block's areas need. A price the owner
 * changed on the till and has not published never reaches the website this
 * way. The same stamp rule as a menu publish (newer or equal, or the same
 * till's later Save), one guarded write: a menu publish landing in between
 * is never overwritten with the older menu. On a real Postgres (PGlite, in
 * memory, with db/schema.sql). All menu items and figures are made up.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  type DeliveryZoneSetting,
  type PublishedFeeItem,
  type PublishedMenu,
  type PublishedMenuItem,
  type PublishedSettings,
} from '@cheeseoclock/shared-types';
import { buildSettingsBlock } from '../../../../packages/pos-domain/src/delivery-charge';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  /** Runs once after the next query whose text matches (a till's publish landing in between). */
  after: null as { match: RegExp; run: () => Promise<void> } | null,
}));
vi.mock('@/lib/db', () => ({
  sql: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
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
const settingsRoute = await import('@/app/api/bridge/settings/route');

const SECRET = 'test-bridge-secret-0123456789';
function bridge(path: string, init?: { method?: string; body?: unknown; secret?: string }) {
  return new Request(`https://site.test${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${init?.secret ?? SECRET}`, 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function item(id: string, name: string, priceRs: number): PublishedMenuItem {
  return { posItemId: id, name, description: null, basePriceCents: priceRs * 100, taxRateBps: 1500, imageUrl: null, sortOrder: 0, modifierGroups: [] };
}
const FEES = { posCategoryId: 'c-del', name: 'Delivery Charges', displayOrder: 6 };
function menu(pizzaRs: number, charges: PublishedMenuItem[]): PublishedMenu {
  return {
    categories: [
      { posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 1, items: [item('test-pizza', 'Test Pizza — Large', pizzaRs)] },
      { ...FEES, items: charges },
    ],
    publishedAt: '2026-09-27T09:00:00.000Z',
    store: { name: 'Test Shop', phone: null, whatsapp: null, addressLine: null, tagline: null },
  };
}
const RS200 = item('fee-200', 'Delivery Charge (Rs 200)', 200);
const RS250 = item('fee-250', 'Delivery Charge (Rs 250)', 250);
const RS300 = item('fee-300', 'Delivery Charge (Rs 300)', 300);

/** The till's block (its own code), today's areas with Phase 8 at Rs 300 on its own item, against the till's menu. */
function tillBlock(tillMenu: PublishedMenu, opts: { rev?: number; at?: string; device?: string; phase8?: number } = {}): PublishedSettings {
  const zones: DeliveryZoneSetting[] = DEFAULT_DELIVERY_ZONES.zones.map((z) => ({ ...z, aliases: [...z.aliases], hints: [...z.hints] }));
  const p8 = zones.find((z) => z.id === 'dha-8')!;
  p8.feeCents = (opts.phase8 ?? 300) * 100;
  return buildSettingsBlock({
    zones,
    pickup: { offered: true, percent: 10 },
    stamps: [{ version: opts.rev ?? 1, updatedAt: opts.at ?? '2026-09-27T10:00:00.000Z' }],
    menuItems: tillMenu.categories.flatMap((c) => c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents }))),
    deviceId: opts.device ?? 'till-1',
  });
}
const fee = (i: PublishedMenuItem): PublishedFeeItem => ({ category: FEES, item: i });

async function publishMenu(m: PublishedMenu, settings?: PublishedSettings) {
  const res = await menuRoute.PUT(bridge('/api/bridge/menu', { method: 'PUT', body: settings ? { ...m, settings } : m }));
  expect(res.status).toBe(200);
}
async function putSettings(body: unknown, secret?: string) {
  const res = await settingsRoute.PUT(bridge('/api/bridge/settings', { method: 'PUT', body, ...(secret ? { secret } : {}) }));
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; message?: string; data?: Record<string, unknown> } };
}
async function stored(): Promise<PublishedMenu | null> {
  const rows = (await db.pg.query('SELECT menu_json FROM site_menu WHERE id = 1', [])).rows as Array<{ menu_json: PublishedMenu | string }>;
  const v = rows[0]?.menu_json;
  if (!v) return null;
  return typeof v === 'string' ? (JSON.parse(v) as PublishedMenu) : v;
}
const priceOf = (m: PublishedMenu | null, id: string) => m?.categories.flatMap((c) => c.items).find((i) => i.posItemId === id)?.basePriceCents;

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  db.after = null;
  revalidated.length = 0;
  await db.pg.query('DELETE FROM site_menu', []);
});

describe('PUT /api/bridge/settings: the block alone, with the menu the website already holds', () => {
  it('stores the block with the LAST PUBLISHED menu plus only the fee item it needs — a price changed on the till but not published stays off the website', async () => {
    await publishMenu(menu(2000, [RS200, RS250]));
    // On the till: the pizza is now Rs 2,340 (not published) and Phase 8 moved to a new Rs 300 item.
    const tillMenu = menu(2340, [RS200, RS250, RS300]);
    const block = tillBlock(tillMenu);
    revalidated.length = 0;
    const r = await putSettings({ settings: block, feeItems: [fee(RS300)] });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ settings: 'stored', settingsRev: 1, settingsDeviceId: 'till-1', settingsProblem: null, categories: 2, items: 4 });
    const now = await stored();
    expect(priceOf(now, 'test-pizza')).toBe(200_000);
    expect(now?.categories.find((c) => c.posCategoryId === 'c-del')?.items.map((i) => i.posItemId)).toEqual(['fee-200', 'fee-250', 'fee-300']);
    expect(now?.settings).toEqual(block);
    expect(now?.publishedAt).toBe('2026-09-27T09:00:00.000Z');
    expect(revalidated).toEqual(['/ layout']);
  });

  it('a fee item the website has already is replaced in place (never twice); a category it lacks is made', async () => {
    const old = menu(2000, [RS200, RS250]);
    old.categories = old.categories.filter((c) => c.posCategoryId !== 'c-del');
    await publishMenu(old);
    const tillMenu = menu(2000, [RS200, RS250, RS300]);
    const r = await putSettings({ settings: tillBlock(tillMenu), feeItems: [fee(RS200), fee(RS250), fee(RS300)] });
    expect(r.status).toBe(200);
    const again = await putSettings({ settings: tillBlock(tillMenu, { rev: 2 }), feeItems: [fee(RS200), fee(RS250), fee(RS300)] });
    expect(again.json.data).toMatchObject({ settings: 'stored', settingsRev: 2 });
    const now = await stored();
    expect(now?.categories.map((c) => c.posCategoryId)).toEqual(['c-pizza', 'c-del']);
    expect(now?.categories.flatMap((c) => c.items).filter((i) => i.posItemId.startsWith('fee-'))).toHaveLength(3);
  });

  it('only the fee items the block’s areas charge: food, or an item no area names, is refused — and nothing is stored', async () => {
    await publishMenu(menu(2000, [RS200, RS250]));
    const tillMenu = menu(2340, [RS200, RS250, RS300]);
    const before = await stored();
    const food = { category: { posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 1 }, item: item('test-pizza', 'Test Pizza — Large', 2340) };
    for (const feeItems of [[fee(RS300), food], [fee(RS300), fee(item('fee-999', 'Delivery Charge (Rs 999)', 999))]]) {
      const r = await putSettings({ settings: tillBlock(tillMenu), feeItems });
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ ok: false, error: 'validation' });
    }
    expect(await stored()).toEqual(before);
  });

  it('refuses a block whose fee item is neither on the stored menu nor sent (settings_invalid, the reason) — nothing stored', async () => {
    await publishMenu(menu(2000, [RS200, RS250]));
    const before = await stored();
    const r = await putSettings({ settings: tillBlock(menu(2000, [RS200, RS250, RS300])), feeItems: [] });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ ok: false, error: 'settings_invalid', message: expect.stringMatching(/DHA Phase 8/) });
    expect(await stored()).toEqual(before);
  });

  it('an older block than the one held is ignored — the stored menu is not touched (no fee item added)', async () => {
    const tillMenu = menu(2000, [RS200, RS250, RS300]);
    await publishMenu(tillMenu, tillBlock(tillMenu, { rev: 5, device: 'till-2' }));
    const before = await stored();
    revalidated.length = 0;
    const r = await putSettings({ settings: tillBlock(menu(2000, [RS200, RS250, item('fee-350', 'Delivery Charge (Rs 350)', 350)]), { rev: 2, phase8: 350 }), feeItems: [fee(item('fee-350', 'Delivery Charge (Rs 350)', 350))] });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ settings: 'ignored_older', settingsRev: 5, settingsDeviceId: 'till-2' });
    expect(await stored()).toEqual(before);
    expect(revalidated).toEqual([]);
  });

  it('no menu published yet: 409 menu_not_published, nothing stored (the owner’s Publish sends the first menu)', async () => {
    const r = await putSettings({ settings: tillBlock(menu(2000, [RS200, RS250, RS300])), feeItems: [fee(RS300)] });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, error: 'menu_not_published' });
    expect(await stored()).toBeNull();
  });

  it('a menu publish landing between the read and the write: the block goes onto the NEW menu (never the old one written back)', async () => {
    await publishMenu(menu(2000, [RS200, RS250]));
    const tillMenu = menu(2340, [RS200, RS250, RS300]);
    db.after = {
      match: /SELECT menu_json/,
      run: async () => publishMenu(menu(2500, [RS200, RS250])),
    };
    const r = await putSettings({ settings: tillBlock(tillMenu), feeItems: [fee(RS300)] });
    expect(r.status).toBe(200);
    const now = await stored();
    expect(priceOf(now, 'test-pizza')).toBe(250_000);
    expect(priceOf(now, 'fee-300')).toBe(30_000);
    expect(now?.settings?.settingsRev).toBe(1);
  });

  it('needs the bridge secret', async () => {
    await publishMenu(menu(2000, [RS200, RS250]));
    const r = await putSettings({ settings: tillBlock(menu(2000, [RS200, RS250, RS300])), feeItems: [fee(RS300)] }, 'wrong-secret-0123456789');
    expect(r.status).toBe(401);
  });
});
