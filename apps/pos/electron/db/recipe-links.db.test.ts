/**
 * A recipe linked to other items' recipes (migration 0055, v0.7.47; the
 * owner, 12 Oct 2026: "Deal ki recipe bhi link ho, copy nahi"), through the
 * real IPC handlers and repositories, against a real database built from
 * every migration and the made-up shop (costing-shop.fixture.ts):
 *   - a "Pizza Pair" links two Medium Fajita pizzas and a cola: saved with a
 *     sync entry per link and one audit row, read back with the names, and
 *     counted as recipe lines;
 *   - the refusals: the item itself, a loop, the same item twice for one
 *     choice, 0 or 100 of it, an item no longer on the menu — each leaves
 *     the links as they were;
 *   - selling the pair takes the pizzas' ingredients (every-sale lines only:
 *     a pizza's Extra cheese is a pick of its own), and follows the pizza's
 *     recipe the moment it changes; a link under a deal's choice only when
 *     that choice is picked;
 *   - its cost follows too: the editor's footer with links as typed costs
 *     exactly what a copy would, Menu costs moves when the pizza's chicken
 *     does, What if tries 3 pizzas;
 *   - deleting a pizza a deal links is refused in words naming the deal;
 *     deleting the deal takes its links with it;
 *   - a menu file: the same recipe opened up changes nothing, the file's own
 *     recipe replaces the links (the file wins, as for every recipe),
 *     "keep the till's recipes" keeps them, and a fresh start clears them
 *     before it deletes the items.
 *
 * Only `defineHandler` (captured) and the signed-in session are stood in
 * for. node:sqlite behind better-sqlite3's shape; skips where it is missing.
 * Every name, amount and price is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, MenuCostsView, RecipeCostPreview, RecipeLinkView, RecipeWhatIf, UUID } from '@cheeseoclock/shared-types';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';
import { CASHIER, DatabaseSync, DEV, MANAGER as MANAGER_ACTOR, OWNER as OWNER_ACTOR, openCostingShop, openMigrated } from './costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
}));

vi.mock('../ipc/registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));
vi.mock('../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));

const MANAGER: AuthenticatedUser = { id: MANAGER_ACTOR.userId as UUID, fullName: 'Test Manager', role: 'manager', sessionId: 'sess' as UUID };

let db: ReturnType<typeof openMigrated>;
let s: Awaited<ReturnType<typeof openCostingShop>>;
/** The made-up deal this file builds: no recipe of its own to start with. */
let pair: string;

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code, message: r.error.message };
  } catch (e) {
    const api = (e as { apiError?: { code: string; message: string } }).apiError;
    if (api) return { ok: false, code: api.code, message: api.message };
    return { ok: false, code: 'precondition_failed', message: e instanceof Error ? e.message : String(e) };
  }
}
async function data<T>(channel: string, payload?: unknown): Promise<T> {
  const o = await call(channel, payload);
  if (!o.ok) throw new Error(`${channel} refused: ${o.code} ${o.message}`);
  return o.data as T;
}

const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);
const linksOf = (itemId: string) => data<RecipeLinkView[]>('inventory:getRecipeLinks', { menuItemId: itemId });
const setRecipe = (menuItemId: string, lines: unknown[], links?: unknown[]) =>
  call('inventory:setRecipe', { menuItemId, lines, ...(links ? { links } : {}) });

/** A counter order of `quantity` of an item with these picks, sent to the kitchen (its stock taken). */
function sell(menuItemId: string, quantity = 1, modifierIds: string[] = []): string {
  const o = s.r.createOrder(db, { mode: 'takeaway' }, CASHIER);
  s.r.addOrderItem(db, { orderId: o.id, menuItemId, quantity, modifierIds, notes: null }, CASHIER);
  s.r.sendOrderToKitchen(db, o.id, CASHIER);
  return o.id;
}

/** The Medium Fajita's every-sale lines, as setRecipe takes them (its Extra cheese, Extra onion and Ranch are picks). */
const fajitaLines = (chicken = 40) => [
  { ingredientId: s.ing.dough, qtyPerUnit: 200, modifierId: null },
  { ingredientId: s.ing.sauce, qtyPerUnit: 50, modifierId: null },
  { ingredientId: s.ing.cheese, qtyPerUnit: 60, modifierId: null },
  { ingredientId: s.ing.chicken, qtyPerUnit: chicken, modifierId: null },
  { ingredientId: s.ing.onion, qtyPerUnit: 10, modifierId: null },
  { ingredientId: s.ing.box, qtyPerUnit: 1, modifierId: null },
];
const fajitaWithPicks = (chicken = 40) => [
  ...fajitaLines(chicken),
  { ingredientId: s.ing.cheese, qtyPerUnit: 40, modifierId: s.choice.extraCheese },
  { ingredientId: s.ing.onion, qtyPerUnit: 10, modifierId: s.choice.extraOnion },
  { ingredientId: s.ing.ranch, qtyPerUnit: 25, modifierId: s.choice.sideRanch },
  { ingredientId: s.ing.cup, qtyPerUnit: 1, modifierId: s.choice.sideRanch },
];

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = MANAGER;
  db = openMigrated();
  s = await openCostingShop(db);
  const tax = (db.prepare(`SELECT tax_category_id AS t FROM menu_items WHERE id = ?`).get(s.item.fajitaM) as { t: string }).t;
  pair = s.r.createMenuItem(db, { categoryId: s.cat.deals, name: 'Pizza Pair', basePriceCents: 250_000, taxCategoryId: tax }, MANAGER_ACTOR).id;
  const ctx = { db, deviceId: DEV } as never;
  (await import('../ipc/handlers/inventory-handlers.js')).registerInventoryHandlers(ctx);
  (await import('../ipc/handlers/costing-handlers.js')).registerCostingHandlers(ctx);
});

const live = describe.skipIf(!DatabaseSync);

live('a deal linked to the items it is made of', () => {
  it('saved with its own lines in one go: a sync entry per link, one audit row; read back with the names; counted as recipe lines', async () => {
    const r = await setRecipe(
      pair,
      [{ ingredientId: s.ing.cup, qtyPerUnit: 2, modifierId: null }],
      [
        { componentItemId: s.item.fajitaM, qtyPerUnit: 2 },
        { componentItemId: s.item.cola, qtyPerUnit: 1 },
      ],
    );
    expect(r.ok).toBe(true);
    const links = await linksOf(pair);
    expect(links.map((l) => [l.componentName, l.qtyPerUnit, l.modifierId])).toEqual([
      ['Cola 345 ml', 1, null],
      ['Fajita Pizza — Medium', 2, null],
    ]);
    // Its own lines are only its own: the pizzas' are not copied in.
    expect((await data<unknown[]>('inventory:getRecipe', { menuItemId: pair })).length).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'recipe_links'`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'recipe_links' AND action = 'set_recipe_links' AND entity_id = ?`, pair)).toBe(1);
    const counts = await data<Array<{ menuItemId: string; lineCount: number }>>('inventory:listRecipeLineCounts');
    expect(counts.find((c) => c.menuItemId === pair)?.lineCount).toBe(3);

    // Saved again with the lines only (What if's "Save these amounts" on an older screen): the links are kept.
    expect((await setRecipe(pair, [{ ingredientId: s.ing.cup, qtyPerUnit: 3, modifierId: null }])).ok).toBe(true);
    expect((await linksOf(pair)).length).toBe(2);
    // And with links [] they go: soft-deleted, each with its sync entry.
    expect((await setRecipe(pair, [{ ingredientId: s.ing.cup, qtyPerUnit: 3, modifierId: null }], [])).ok).toBe(true);
    expect(await linksOf(pair)).toEqual([]);
    expect(count(`SELECT COUNT(*) AS n FROM recipe_links WHERE menu_item_id = ? AND deleted_at IS NOT NULL`, pair)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'recipe_links' AND op = 'delete'`)).toBe(2);
  });

  it('refused, in words, and nothing changes: itself, a loop, the same item twice for one choice, 0 or 100 of it, an item gone', async () => {
    expect((await setRecipe(pair, [], [{ componentItemId: s.item.fajitaM, qtyPerUnit: 2 }])).ok).toBe(true);
    const refused = async (menuItemId: string, links: unknown[]) => {
      const o = await setRecipe(menuItemId, [], links);
      expect(o.ok).toBe(false);
      return o.ok ? '' : o.message;
    };
    expect(await refused(pair, [{ componentItemId: pair, qtyPerUnit: 1 }])).toBe('An item can’t use its own recipe.');
    expect(await refused(s.item.fajitaM, [{ componentItemId: pair, qtyPerUnit: 1 }])).toMatch(/go round in a circle/);
    expect(await refused(pair, [{ componentItemId: s.item.cola, qtyPerUnit: 1 }, { componentItemId: s.item.cola, qtyPerUnit: 2 }])).toMatch(/linked twice for the same choice/);
    const zero = await setRecipe(pair, [], [{ componentItemId: s.item.cola, qtyPerUnit: 0 }]);
    const hundred = await setRecipe(pair, [], [{ componentItemId: s.item.cola, qtyPerUnit: 100 }]);
    expect([zero.ok ? '' : zero.code, hundred.ok ? '' : hundred.code]).toEqual(['validation_failed', 'validation_failed']);
    s.r.deleteMenuItem(db, s.item.bakedWings, MANAGER_ACTOR);
    expect(await refused(pair, [{ componentItemId: s.item.bakedWings, qtyPerUnit: 1 }])).toBe('A linked item is no longer on the menu.');
    // The same item under two different choices is two links, not a repeat.
    const twoSlots = await setRecipe(pair, [], [
      { componentItemId: s.item.fajitaM, qtyPerUnit: 1, modifierId: s.choice.sideRanch },
      { componentItemId: s.item.fajitaM, qtyPerUnit: 2 },
    ]);
    expect(twoSlots.ok).toBe(true);
    expect((await linksOf(pair)).map((l) => [l.qtyPerUnit, l.modifierName])).toEqual([[2, null], [1, 'Side of Ranch']]);
  });

  it('selling the pair takes the pizzas’ every-sale ingredients × 2, and follows the pizza’s recipe the moment it changes', async () => {
    expect((await setRecipe(pair, [{ ingredientId: s.ing.cup, qtyPerUnit: 2, modifierId: null }], [{ componentItemId: s.item.fajitaM, qtyPerUnit: 2 }])).ok).toBe(true);
    const before = { chicken: s.stockOf('chicken'), dough: s.stockOf('dough'), cheese: s.stockOf('cheese'), cup: s.stockOf('cup'), ranch: s.stockOf('ranch') };
    sell(pair);
    expect(s.stockOf('chicken')).toBe(before.chicken - 80);
    expect(s.stockOf('dough')).toBe(before.dough - 400);
    // The pizza's Extra cheese and side of Ranch are its own picks: not part of the pair.
    expect(s.stockOf('cheese')).toBe(before.cheese - 120);
    expect(s.stockOf('ranch')).toBe(before.ranch);
    expect(s.stockOf('cup')).toBe(before.cup - 2);

    // The pizza now takes 70 g of chicken: the pair follows, nothing to change on it.
    expect((await setRecipe(s.item.fajitaM, fajitaWithPicks(70))).ok).toBe(true);
    const mid = s.stockOf('chicken');
    sell(pair, 2);
    expect(s.stockOf('chicken')).toBe(mid - 280);
  });

  it('a link under one of the deal’s choices is only taken when that choice is picked; a pizza’s pick ticked on the link always comes', async () => {
    expect(
      (
        await setRecipe(pair, [], [
          { componentItemId: s.item.fajitaM, qtyPerUnit: 1, componentModifierIds: [s.choice.extraCheese] },
          { componentItemId: s.item.cola, qtyPerUnit: 1, modifierId: s.choice.sideRanch },
        ])
      ).ok,
    ).toBe(true);
    s.r.setItemModifierGroups(db, pair, [{ modifierGroupId: s.group.sideDips, sortOrder: 0 }], MANAGER_ACTOR);
    const cheese0 = s.stockOf('cheese');
    const bottle0 = s.stockOf('bottle');
    sell(pair);
    expect(s.stockOf('cheese')).toBe(cheese0 - 100);
    expect(s.stockOf('bottle')).toBe(bottle0);
    sell(pair, 1, [s.choice.sideRanch]);
    expect(s.stockOf('bottle')).toBe(bottle0 - 1);
  });

  it('its cost follows too: a link costs what a copy would, Menu costs moves with the pizza’s chicken, What if tries 3 pizzas', async () => {
    const linked = await data<RecipeCostPreview>('costing:recipeCost', { menuItemId: pair, lines: [], links: [{ componentItemId: s.item.fajitaM, qtyPerUnit: 2 }] });
    const copied = await data<RecipeCostPreview>('costing:recipeCost', {
      menuItemId: pair,
      lines: fajitaLines().map((l) => ({ ...l, qtyPerUnit: l.qtyPerUnit * 2 })),
      links: [],
    });
    expect(linked.hasRecipe).toBe(true);
    expect(linked.costCents).toBe(copied.costCents);
    expect(linked.costCents).toBeGreaterThan(0);

    expect((await setRecipe(pair, [], [{ componentItemId: s.item.fajitaM, qtyPerUnit: 2 }])).ok).toBe(true);
    const costOf = async () => (await data<MenuCostsView>('costing:menuCosts')).rows.find((r) => r.menuItemId === pair)!;
    const was = await costOf();
    expect(was).toMatchObject({ hasRecipe: true, costCents: linked.costCents });
    // 30 g more chicken in each pizza (Rs 900 / kg, made up): 60 g, Rs 54, on the pair.
    expect((await setRecipe(s.item.fajitaM, fajitaWithPicks(70))).ok).toBe(true);
    expect((await costOf()).costCents).toBe(was.costCents + 5_400);

    // What if: 3 pizzas instead of 2 — the link's own cost and the plate's move together.
    const w = await data<RecipeWhatIf>('costing:recipeWhatIf', { menuItemId: pair, lines: [], links: [{ componentItemId: s.item.fajitaM, qtyPerUnit: 3 }] });
    expect(w.saved.links).toEqual([{ componentItemId: s.item.fajitaM, modifierId: null, qty: 2, costCents: was.costCents + 5_400, missingLines: 0 }]);
    expect(w.tried.links[0]).toMatchObject({ qty: 3 });
    // (Each worked out in its own rounding to the paisa: within one.)
    expect(Math.abs(w.tried.links[0]!.costCents - w.saved.links[0]!.costCents - (w.tried.costCents - w.saved.costCents))).toBeLessThanOrEqual(1);
    expect(Math.abs(w.tried.costCents * 2 - w.saved.costCents * 3)).toBeLessThanOrEqual(3);
    // Links absent: the ones it has.
    const same = await data<RecipeWhatIf>('costing:recipeWhatIf', { menuItemId: pair, lines: [] });
    expect(same.tried.costCents).toBe(same.saved.costCents);
  });
});

live('deleting an item a deal uses', () => {
  it('is refused in words naming the deal; deleting the deal takes its links with it (synced, audited), then the pizza can go', async () => {
    expect((await setRecipe(pair, [], [{ componentItemId: s.item.fajitaM, qtyPerUnit: 2 }, { componentItemId: s.item.cola, qtyPerUnit: 1 }])).ok).toBe(true);
    expect(() => s.r.deleteMenuItem(db, s.item.fajitaM, MANAGER_ACTOR)).toThrow(
      'Pizza Pair uses the recipe of Fajita Pizza — Medium: take it out of that recipe first (Inventory → Recipes).',
    );
    expect(count(`SELECT COUNT(*) AS n FROM menu_items WHERE id = ? AND deleted_at IS NULL`, s.item.fajitaM)).toBe(1);

    s.r.deleteMenuItem(db, pair, MANAGER_ACTOR);
    expect(count(`SELECT COUNT(*) AS n FROM recipe_links WHERE menu_item_id = ? AND deleted_at IS NULL`, pair)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'recipe_links' AND action = 'delete_with_item'`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'recipe_links' AND op = 'delete'`)).toBe(2);
    expect(() => s.r.deleteMenuItem(db, s.item.fajitaM, MANAGER_ACTOR)).not.toThrow();
  });
});

live('a menu file and a linked deal', () => {
  const fileWith = (recipe: Array<{ ingredient: string; qty: number }>) =>
    menuImportFileSchema.parse({
      format: 'cheeseoclock-menu-import',
      version: 1,
      source: 'test',
      categories: [{ name: 'Value Deals' }],
      ingredients: [
        { name: 'Test cup', unit: 'pcs', costPerUnitCents: 0 },
        { name: 'Test bottle', unit: 'pcs', costPerUnitCents: 0 },
      ],
      items: [{ name: 'Pizza Pair', category: 'Value Deals', priceCents: 250_000, recipe }],
    });
  const importIt = async (file: ReturnType<typeof fileWith>, opts: { fresh?: boolean } = {}) => {
    const { applyMenuImport } = await import('./repositories/menu-import-repo.js');
    return applyMenuImport(db, file, 'test.json', OWNER_ACTOR, opts);
  };

  it('the same recipe opened up changes nothing; the file’s own recipe replaces the links (the file wins)', async () => {
    expect((await setRecipe(pair, [{ ingredientId: s.ing.cup, qtyPerUnit: 2, modifierId: null }], [{ componentItemId: s.item.cola, qtyPerUnit: 1 }])).ok).toBe(true);
    // The pair opened up: 2 cups and the cola's bottle.
    await importIt(fileWith([{ ingredient: 'Test cup', qty: 2 }, { ingredient: 'Test bottle', qty: 1 }]));
    expect((await linksOf(pair)).map((l) => l.componentName)).toEqual(['Cola 345 ml']);

    await importIt(fileWith([{ ingredient: 'Test cup', qty: 3 }]));
    expect(await linksOf(pair)).toEqual([]);
    expect((await data<Array<{ qtyPerUnit: number }>>('inventory:getRecipe', { menuItemId: pair })).map((l) => l.qtyPerUnit)).toEqual([3]);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'recipe_links' AND action = 'set_recipe_links' AND entity_id = ?`, pair)).toBe(2);
  });

  it('"keep the till’s recipes": a deal made only of links keeps them', async () => {
    const { setBusinessSetting } = await import('./repositories/business-settings-repo.js');
    setBusinessSetting(db, 'menu.importPolicy', { v: 1, itemPrices: 'file', choices: 'file', recipes: 'till', tax: 'file' }, OWNER_ACTOR);
    expect((await setRecipe(pair, [], [{ componentItemId: s.item.cola, qtyPerUnit: 1 }])).ok).toBe(true);
    const summary = await importIt(fileWith([{ ingredient: 'Test cup', qty: 3 }]));
    expect((await linksOf(pair)).length).toBe(1);
    expect(await data<unknown[]>('inventory:getRecipe', { menuItemId: pair })).toEqual([]);
    expect(summary.keptOnTill.recipes).toBe(1);
  });

  it('a fresh start clears the links before it deletes the items (a linked pizza would refuse to go)', async () => {
    expect((await setRecipe(pair, [], [{ componentItemId: s.item.fajitaM, qtyPerUnit: 2 }])).ok).toBe(true);
    await importIt(fileWith([{ ingredient: 'Test cup', qty: 1 }]), { fresh: true });
    expect(count(`SELECT COUNT(*) AS n FROM recipe_links WHERE deleted_at IS NULL`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM menu_items WHERE id = ? AND deleted_at IS NULL`, s.item.fajitaM)).toBe(0);
  });
});
