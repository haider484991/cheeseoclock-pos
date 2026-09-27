/**
 * The recipe calculator through the real IPC handlers, against a real
 * database built from every migration and a made-up shop
 * (db/costing-shop.fixture.ts):
 *   - a cashier is refused all four channels in the main process, in plain
 *     words, and nothing is written;
 *   - inventory:recipeCalc answers in quantities only — not one *Cents or
 *     *Mc field — with the batches to make first (each once, in order),
 *     what comes straight from stock, everything from scratch, this till's
 *     stock and what is short; the choices counted as asked, never a
 *     leave-out; picks that do not cover the count said in plain words;
 *   - what it shows for a batch is exactly what "Make" (inventory:makeBatch)
 *     then takes out of stock, nested batches included;
 *   - a loop that came in through the second till is reported, never followed;
 *   - costing:recipeCalc adds what it costs (a manager's and the owner's);
 *   - inventory:typicalPicks gives the choices in the till's order and the
 *     last 28 days' picks as counts;
 *   - inventory:printPrepList prints the prep list (no prices) on the
 *     receipt printer, and a failed print is an answer, not an error.
 *
 * Only `defineHandler` (captured), the signed-in session and the print
 * spooler (it records the paper) are stood in for. node:sqlite behind
 * better-sqlite3's shape; skips where it is missing. Every name, amount and
 * price is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { escPosToText } from '@cheeseoclock/printer-core';
import { typicalPortions } from '@cheeseoclock/pos-domain';
import type { AuthenticatedUser, CostedRecipeCalc, PrintResult, PrinterWidth, RecipeCalc, TypicalPicksView, UUID } from '@cheeseoclock/shared-types';
import { DatabaseSync, DEV, MANAGER as MANAGER_ACTOR, openCostingShop, openMigrated, type Choice } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  /** What the stand-in receipt printer was sent, rendered at 32 columns. */
  printed: [] as Uint8Array[],
  printResult: { ok: true, durationMs: 1 } as PrintResult,
}));

vi.mock('../registry.js', () => {
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
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: {
    printDocumentNow: async (render: (width: PrinterWidth) => Uint8Array) => {
      h.printed.push(render(32));
      return h.printResult;
    },
  },
}));

const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id === 'u_mgr' ? 'Test Manager' : id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');

let db: ReturnType<typeof openMigrated>;
let s: Awaited<ReturnType<typeof openCostingShop>>;

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
    // defineHandler turns a plain repository Error into precondition_failed.
    return { ok: false, code: 'precondition_failed', message: e instanceof Error ? e.message : String(e) };
  }
}
async function data<T>(channel: string, payload?: unknown): Promise<T> {
  const o = await call(channel, payload);
  if (!o.ok) throw new Error(`${channel} refused: ${o.code} ${o.message}`);
  return o.data as T;
}

const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);
const written = () => ({ audit: count(`SELECT COUNT(*) AS n FROM audit_log`), sync: count(`SELECT COUNT(*) AS n FROM sync_queue`) });
const setStock = (id: string, qty: number) => db.prepare(`UPDATE ingredients SET current_qty = ? WHERE id = ?`).run(qty, id);

/** Every key anywhere in a JSON answer that names money: *Cents or *Mc. */
function moneyKeys(v: unknown, path = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => moneyKeys(x, `${path}[${i}]`));
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => [...(/(Cents|Mc)$/.test(k) ? [`${path}.${k}`] : []), ...moneyKeys(x, `${path}.${k}`)]);
  }
  return [];
}

const item = (menuItemId: string, n: number, portions: Array<[string, number]> = []) => ({
  kind: 'item' as const,
  menuItemId,
  count: n,
  portions: portions.map(([modifierId, c]) => ({ modifierId, count: c })),
});
const byId = (rows: Array<{ ingredientId: string; qty: number }>) => Object.fromEntries(rows.map((r) => [r.ingredientId, r.qty]));

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.printed.length = 0;
  h.printResult = { ok: true, durationMs: 1 };
  db = openMigrated();
  s = await openCostingShop(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./inventory-handlers.js')).registerInventoryHandlers(ctx);
  (await import('./costing-handlers.js')).registerCostingHandlers(ctx);
});

const live = describe.skipIf(!DatabaseSync);

live('who may use it', () => {
  it('a cashier is refused every channel of it in the main process, in plain words, and nothing is written', async () => {
    h.session = CASHIER;
    const before = written();
    const req = { lines: [item(s.item.fajitaM, 10)] };
    expect(await call('inventory:recipeCalc', req)).toEqual({ ok: false, code: 'forbidden', message: 'Only a manager or the owner can see stock, recipes and suppliers.' });
    expect(await call('inventory:typicalPicks', { menuItemId: s.item.fajitaM })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await call('inventory:printPrepList', req)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await call('costing:recipeCalc', req)).toEqual({ ok: false, code: 'forbidden', message: 'Only a manager or the owner can see costs.' });
    expect(h.printed).toHaveLength(0);
    expect(written()).toEqual(before);
  });

  it('nobody signed in: not logged in', async () => {
    for (const channel of ['inventory:recipeCalc', 'inventory:printPrepList', 'costing:recipeCalc']) {
      expect(await call(channel, { lines: [item(s.item.fajitaM, 1)] })).toMatchObject({ ok: false, code: 'unauthenticated' });
    }
  });
});

live('how much 10 pizzas need (quantities only)', () => {
  it('the sauce to make first, what comes straight from stock, everything from scratch — with the stock here', async () => {
    h.session = MANAGER;
    setStock(s.ing.sauce, 200);
    setStock(s.ing.box, 4);
    const before = written();
    const calc = await data<RecipeCalc>('inventory:recipeCalc', {
      lines: [item(s.item.fajitaM, 10, [[s.choice.extraCheese, 3], [s.choice.sideRanch, 2]])],
    });
    expect(moneyKeys(calc)).toEqual([]);
    expect(calc.lines).toHaveLength(1);
    expect(calc.lines[0]).toMatchObject({ kind: 'item', name: 'Fajita Pizza — Medium', count: 10, warnings: [], hasRecipe: true });
    expect(calc.lines[0]!.picks.map((p) => [p.name, p.groupName, p.count])).toEqual([
      ['Extra cheese', 'Extra toppings', 3],
      ['Side of Ranch', 'Dips on the side', 2],
    ]);
    // 50 g of sauce on each: 500 g; 200 g on the shelf, so 300 g to make (0.15 of the 2 kg batch).
    expect(calc.batches).toHaveLength(1);
    expect(calc.batches[0]).toMatchObject({
      ingredientId: s.ing.sauce,
      qty: 500,
      direct: 500,
      asked: 0,
      batchYield: 2_000,
      inStock: 200,
      fromShelf: 200,
      shortBy: 300,
      toMake: 300,
      batchesText: '0.15 of a batch',
      maxAmount: 200_000,
      goes: 1,
      packSize: null,
    });
    // 2,500 g tomato and 125 g garlic a batch: for 300 g, 375 g and 18.75 → 19 g.
    expect(calc.batches[0]!.tree!.lines.map((l) => [l.name, l.qty, l.exactHundredths])).toEqual([
      ['Test tomato', 375, 37_500],
      ['Test garlic', 19, 1_875],
    ]);
    expect(byId(calc.fromStock)).toEqual({
      [s.ing.dough]: 2_000,
      [s.ing.cheese]: 720, // 600 + 3 × 40 extra
      [s.ing.chicken]: 400,
      [s.ing.onion]: 100,
      [s.ing.box]: 10,
      [s.ing.ranch]: 50,
      [s.ing.cup]: 2,
    });
    expect(calc.fromStock.find((r) => r.ingredientId === s.ing.box)).toMatchObject({ inStock: 4, shortBy: 6, unit: 'pcs' });
    // The cheese is bought in packs of 2 kg: a real pack. Dough's "per kg" price is not one.
    expect(calc.fromStock.find((r) => r.ingredientId === s.ing.cheese)!.packSize).toBe(2_000);
    expect(calc.fromStock.find((r) => r.ingredientId === s.ing.dough)!.packSize).toBeNull();
    expect(byId(calc.fromScratch)).toEqual({ ...byId(calc.fromStock), [s.ing.tomato]: 375, [s.ing.garlic]: 19 });
    // The tomato comes in 5 kg packs: a real pack, so it can say how many to buy.
    expect(calc.fromScratch.find((r) => r.ingredientId === s.ing.tomato)!.packSize).toBe(5_000);
    // Read-only.
    expect(written()).toEqual(before);
  });

  it('a deal: its pizzas counted as picked, and picks that do not cover the count said plainly', async () => {
    h.session = MANAGER;
    const calc = await data<RecipeCalc>('inventory:recipeCalc', {
      lines: [item(s.item.deal, 12, [[s.choice.d1Fajita, 7], [s.choice.d2Fajita, 6], [s.choice.d2Veggie, 6]])],
    });
    expect(calc.lines[0]!.warnings).toEqual(['Deal: Large pizza — 7 picked for 12, pick 5 more']);
    // 19 pizzas picked: 300 g dough and 80 g sauce each.
    expect(byId(calc.fromStock)[s.ing.dough]).toBe(5_700);
    expect(calc.batches[0]).toMatchObject({ ingredientId: s.ing.sauce, qty: 1_520 });
  });

  it('refuses what it cannot count, in plain words: a leave-out, more than the count, a choice that is not the item’s', async () => {
    h.session = MANAGER;
    const leaveOut = await call('inventory:recipeCalc', { lines: [item(s.item.deal, 2, [[s.choice.dealNoOnion, 1]])] });
    expect(leaveOut).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect((leaveOut as { message: string }).message).toMatch(/leave-out: it only uses less/);
    const tooMany = await call('inventory:recipeCalc', { lines: [item(s.item.fajitaM, 2, [[s.choice.extraCheese, 3]])] });
    expect(tooMany).toMatchObject({ ok: false, message: '"Extra cheese": at most 2 (one on each)' });
    const notIts = await call('inventory:recipeCalc', { lines: [item(s.item.fajitaM, 2, [[s.choice.d1Fajita, 1]])] });
    expect((notIts as { message: string }).message).toMatch(/not one of Fajita Pizza — Medium's/);
    expect(await call('inventory:recipeCalc', { lines: [item('no-such-item', 2)] })).toMatchObject({ ok: false, message: 'That menu item is no longer on the menu' });
    expect(await call('inventory:recipeCalc', { lines: [{ kind: 'batch', ingredientId: s.ing.cheese, amount: 100 }] })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Test cheese has no batch recipe/),
    });
    expect(await call('inventory:recipeCalc', { lines: [item(s.item.fajitaM, 2.5)] })).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(await call('inventory:recipeCalc', { lines: [] })).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('a sauce with enough on the shelf is not made, and nothing only it would use is counted; a sauce asked for by name is', async () => {
    h.session = MANAGER;
    // The shop keeps 100 kg of sauce made.
    const calc = await data<RecipeCalc>('inventory:recipeCalc', { lines: [item(s.item.fajitaM, 10)] });
    expect(calc.batches[0]).toMatchObject({ ingredientId: s.ing.sauce, qty: 500, fromShelf: 500, toMake: 0, shortBy: 0, batchesText: null, tree: null });
    expect(byId(calc.fromScratch)).toEqual(byId(calc.fromStock)); // no tomato, no garlic
    // "2 kg of sauce": asked for by name, so made in full, stock or not.
    const asked = await data<RecipeCalc>('inventory:recipeCalc', {
      lines: [item(s.item.fajitaM, 10), { kind: 'batch', ingredientId: s.ing.sauce, amount: 2_000 }],
    });
    expect(asked.batches[0]).toMatchObject({ qty: 2_500, asked: 2_000, fromShelf: 500, toMake: 2_000, shortBy: 0, batchesText: '1 batch' });
    expect(byId(asked.fromScratch)[s.ing.tomato]).toBe(2_500);
  });

  it('a made-here batch never says "buy a pack", even with a pack size kept beside an old price', async () => {
    h.session = MANAGER;
    setStock(s.ing.sauce, 200);
    db.prepare(`UPDATE ingredients SET pack_size = 2000 WHERE id = ?`).run(s.ing.sauce);
    const req = { lines: [item(s.item.fajitaM, 10)] };
    const calc = await data<RecipeCalc>('inventory:recipeCalc', req);
    expect(calc.batches[0]).toMatchObject({ packSize: null, shortBy: 300 });
    await data('inventory:printPrepList', req);
    expect(escPosToText(h.printed[0]!)).not.toMatch(/buy \d+ pack/);
  });

  it('a counted choice that has no recipe lines of its own (a deal pizza never given its copy) is said, not silently left out', async () => {
    h.session = MANAGER;
    const crown = s.r.createModifier(
      db,
      { modifierGroupId: s.group.deal1, name: 'Large: Test Crown', priceDeltaCents: 0, removesIngredientId: null },
      MANAGER_ACTOR,
    ).id;
    const calc = await data<RecipeCalc>('inventory:recipeCalc', {
      lines: [item(s.item.deal, 10, [[s.choice.d1Fajita, 7], [crown, 3], [s.choice.d2Fajita, 10]])],
    });
    expect(calc.lines[0]!.warnings).toEqual([
      '"Large: Test Crown" has no recipe lines yet, so the 3 counted add nothing: add its lines in Inventory → Recipes.',
    ]);
    expect(byId(calc.fromStock)[s.ing.dough]).toBe(5_100); // 17 pizzas: the 3 Crowns add nothing
    const view = await data<TypicalPicksView>('inventory:typicalPicks', { menuItemId: s.item.deal });
    expect(view.groups[0]!.options.find((o) => o.modifierId === crown)).toMatchObject({ hasLines: false });
    // Not counted: no warning.
    const none = await data<RecipeCalc>('inventory:recipeCalc', {
      lines: [item(s.item.deal, 10, [[s.choice.d1Fajita, 10], [s.choice.d2Fajita, 10]])],
    });
    expect(none.lines[0]!.warnings).toEqual([]);
  });

  it('an item with no recipe says so', async () => {
    h.session = MANAGER;
    const calc = await data<RecipeCalc>('inventory:recipeCalc', { lines: [item(s.item.bakedWings, 4)] });
    expect(calc.lines[0]).toMatchObject({ hasRecipe: false, warnings: [expect.stringMatching(/has no recipe yet/)] });
    expect(calc.fromScratch).toEqual([]);
  });
});

live('what it shows is what "Make" takes', () => {
  it('a sauce made with a paste (a batch too): each made once, in order, and Make takes exactly the grams shown', async () => {
    h.session = MANAGER;
    setStock(s.ing.sauce, 0);
    const paste = s.r.createIngredient(db, { name: 'Test garlic paste', unit: 'g', currentQty: 0 }, MANAGER_ACTOR).id;
    s.r.setBatchRecipe(db, { ingredientId: paste, batchYield: 100, lines: [{ inputIngredientId: s.ing.garlic, qty: 80 }, { inputIngredientId: s.ing.salt, qty: 20 }] }, MANAGER_ACTOR);
    s.r.setBatchRecipe(
      db,
      { ingredientId: s.ing.sauce, batchYield: 2_000, lines: [{ inputIngredientId: s.ing.tomato, qty: 2_500 }, { inputIngredientId: paste, qty: 125 }] },
      MANAGER_ACTOR,
    );
    const calc = await data<RecipeCalc>('inventory:recipeCalc', {
      lines: [item(s.item.fajitaM, 10), { kind: 'batch', ingredientId: paste, amount: 50 }],
    });
    // The paste goes in first; it is made once for the sauce (31 g) and the 50 g asked.
    expect(calc.batches.map((b) => [b.name, b.qty, b.direct])).toEqual([
      ['Test garlic paste', 81, 50],
      ['Test sauce', 500, 500],
    ]);
    expect(calc.lines[1]).toMatchObject({ kind: 'batch', count: 50, unit: 'g', batchesText: '0.5 of a batch' });
    const sauceTree = calc.batches[1]!.tree!;
    expect(sauceTree.lines.map((l) => [l.name, l.qty])).toEqual([
      ['Test tomato', 625],
      ['Test garlic paste', 31],
    ]);
    // The paste inside opens up for the 31 g it takes.
    expect(sauceTree.lines[1]!.madeOf!.lines.map((l) => [l.name, l.qty])).toEqual([
      ['Test garlic', 25], // 80 × 31 ÷ 100 = 24.8
      ['Test salt', 6],
    ]);
    expect(byId(calc.fromScratch)[s.ing.garlic]).toBe(65); // 80 × 81 ÷ 100 = 64.8

    // Make the sauce the screen showed: the same grams leave stock.
    const stock = () => ({ tomato: s.stockOf('tomato'), paste: Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(paste) as { q: number }).q) });
    const before = stock();
    expect(calc.batches[1]).toMatchObject({ toMake: 500, fromShelf: 0 });
    await data('inventory:makeBatch', { ingredientId: s.ing.sauce, amount: calc.batches[1]!.toMake });
    const after = stock();
    expect(before.tomato - after.tomato).toBe(sauceTree.lines[0]!.qty);
    expect(before.paste - after.paste).toBe(sauceTree.lines[1]!.qty);
  });

  it('a loop that came in through the second till is reported and never followed round', async () => {
    h.session = MANAGER;
    setStock(s.ing.sauce, 0);
    const paste = s.r.createIngredient(db, { name: 'Test garlic paste', unit: 'g', currentQty: 0 }, MANAGER_ACTOR).id;
    s.r.setBatchRecipe(db, { ingredientId: paste, batchYield: 100, lines: [{ inputIngredientId: s.ing.garlic, qty: 80 }] }, MANAGER_ACTOR);
    s.r.setBatchRecipe(
      db,
      { ingredientId: s.ing.sauce, batchYield: 2_000, lines: [{ inputIngredientId: s.ing.tomato, qty: 2_500 }, { inputIngredientId: paste, qty: 125 }] },
      MANAGER_ACTOR,
    );
    // The other half of the loop, as a synced row would arrive (setBatchRecipe refuses it here).
    db.prepare(
      `INSERT INTO batch_recipe_lines (id, ingredient_id, input_ingredient_id, qty, sort_order, created_at, updated_at, device_id, version)
       VALUES ('loop-line', ?, ?, 10, 5, 'x', 'x', 'till-2', 1)`,
    ).run(paste, s.ing.sauce);
    const calc = await data<RecipeCalc>('inventory:recipeCalc', { lines: [item(s.item.fajitaM, 10)] });
    expect(calc.warnings).toEqual([
      'Test garlic paste uses Test sauce, which is made with Test garlic paste: fix it in Inventory → Recipes → Batch recipes. Counted here as taken from stock.',
    ]);
    expect(calc.batches.map((b) => b.name)).toEqual(['Test garlic paste', 'Test sauce']);
    const pasteInSauce = calc.batches[1]!.tree!.lines.find((l) => l.name === 'Test garlic paste')!;
    expect(pasteInSauce.madeOf!.lines.find((l) => l.name === 'Test sauce')).toMatchObject({ loop: true, madeOf: null });
  });
});

live('what it costs (COST_CAPABILITY)', () => {
  it('the same quantities, and one total: each first-level line at today’s price, the sauce at its rolled-up price', async () => {
    for (const who of [MANAGER, OWNER]) {
      h.session = who;
      const req = { lines: [item(s.item.fajitaM, 10), item(s.item.cola, 3)] };
      const costed = await data<CostedRecipeCalc>('costing:recipeCalc', req);
      const plain = await data<RecipeCalc>('inventory:recipeCalc', req);
      const { costs, ...quantities } = costed;
      expect(quantities).toEqual(plain);
      // dough 18,000 + sauce 500 g of (30,000 + 5,625) ÷ 2,000 g = 8,906.25 + cheese 72,000
      // + chicken 36,000 + onion 1,500 + boxes 40,000 = 176,406.25 → Rs 1,764.06.
      expect(costs.perLine[0]).toEqual({ costCents: 176_406, eachCents: 17_641, complete: true, unpriced: [] });
      // The bottles have no price yet: Rs 0, and said.
      expect(costs.perLine[1]).toEqual({ costCents: 0, eachCents: 0, complete: false, unpriced: ['Test bottle'] });
      expect(costs).toMatchObject({ totalCostCents: 176_406, complete: false, unpriced: ['Test bottle'] });
      expect(costs.perRow[s.ing.sauce]).toEqual({ costCents: 8_906, complete: true });
      expect(costs.perRow[s.ing.box]).toEqual({ costCents: 40_000, complete: true });
    }
  });
});

live('what it costs, nested batches', () => {
  it('a batch only inside another batch has no cost of its own: the cost column adds up to the one total', async () => {
    h.session = MANAGER;
    const paste = s.r.createIngredient(db, { name: 'Test garlic paste', unit: 'g', currentQty: 0 }, MANAGER_ACTOR).id;
    s.r.setBatchRecipe(
      db,
      { ingredientId: paste, batchYield: 100, lines: [{ inputIngredientId: s.ing.garlic, qty: 80 }, { inputIngredientId: s.ing.salt, qty: 20 }] },
      MANAGER_ACTOR,
    );
    s.r.setBatchRecipe(
      db,
      { ingredientId: s.ing.sauce, batchYield: 2_000, lines: [{ inputIngredientId: s.ing.tomato, qty: 2_500 }, { inputIngredientId: paste, qty: 125 }] },
      MANAGER_ACTOR,
    );
    setStock(s.ing.sauce, 0);
    const pizzasOnly = await data<CostedRecipeCalc>('costing:recipeCalc', { lines: [item(s.item.fajitaM, 10)] });
    // The paste goes only into the sauce: in the sauce's price, not a second time on its own row.
    expect(pizzasOnly.batches.map((b) => [b.name, b.qty, b.direct])).toEqual([
      ['Test garlic paste', 31, 0],
      ['Test sauce', 500, 500],
    ]);
    expect(pizzasOnly.costs.perRow[paste]).toBeUndefined();
    // Paste: 80 g garlic at Rs 450 / kg = Rs 36 per 100 g. Sauce: 2,500 g tomato Rs 300 + 125 g paste Rs 45 = Rs 345 per 2 kg.
    expect(pizzasOnly.costs.perRow[s.ing.sauce]).toEqual({ costCents: 8_625, complete: true });
    const sum = (c: CostedRecipeCalc) => Object.values(c.costs.perRow).reduce((t, r) => t + r.costCents, 0);
    expect(sum(pizzasOnly)).toBe(pizzasOnly.costs.totalCostCents);
    // 50 g of paste asked for as well: that 50 g on its row, the 31 g in the sauce still only in the sauce.
    const both = await data<CostedRecipeCalc>('costing:recipeCalc', {
      lines: [item(s.item.fajitaM, 10), { kind: 'batch', ingredientId: paste, amount: 50 }],
    });
    expect(both.costs.perRow[paste]).toEqual({ costCents: 1_800, complete: true });
    expect(Math.abs(sum(both) - both.costs.totalCostCents)).toBeLessThanOrEqual(1);
  });
});

live('the usual picks', () => {
  it("a menu item's choices in the till's order, and the last 28 days' picks as counts — no money", async () => {
    h.session = MANAGER;
    for (let i = 0; i < 12; i++) {
      const veg: Choice[] = i < 8 ? ['pickOnion', 'pickPepper'] : ['pickOlive'];
      s.markPaid(s.ring([['veggieL', 1, [...veg, i < 9 ? 'dipRanch' : 'dipChili']]]));
    }
    const view = await data<TypicalPicksView>('inventory:typicalPicks', { menuItemId: s.item.veggieL });
    expect(moneyKeys(view)).toEqual([]);
    expect(view.groups.map((g) => [g.name, g.kind])).toEqual([
      ['Choose up to 5 veggies', 'required'],
      ['Choose your dip', 'required'],
      ['Extra toppings', 'extras'],
      ['Leave out', 'leave-out'],
    ]);
    expect(view.groups[3]!.options[0]).toMatchObject({ name: 'No onion', leaveOut: true, hasLines: false });
    expect(view.mix.units).toBe(12);
    expect(view.mix.picks[s.choice.pickOnion]).toBe(8);
    expect(view.mix.groupUnits[s.group.veg]).toBe(12);
    // For 6 pizzas: the veggies shared as customers pick them.
    const veg = view.groups[0]!;
    const mix = { units: view.mix.units, picks: new Map(Object.entries(view.mix.picks)), groupUnits: new Map(Object.entries(view.mix.groupUnits)) };
    const t = typicalPortions({ id: veg.groupId, ...veg, options: veg.options.map((o) => ({ id: o.modifierId })) }, mix, 6)!;
    expect(t.basis).toBe('observed');
    // 20 picks over 12 pizzas → 10 for 6: onion 8, pepper 8, olive 4 of 20.
    expect(Object.fromEntries(t.portions.filter((p) => p.count > 0).map((p) => [p.modifierId, p.count]))).toEqual({
      [s.choice.pickOnion]: 4,
      [s.choice.pickPepper]: 4,
      [s.choice.pickOlive]: 2,
    });
  });
});

live('the prep list', () => {
  it('prints on the receipt printer — the batch, its inputs, SHORT marks, and no prices — and writes nothing', async () => {
    h.session = MANAGER;
    setStock(s.ing.sauce, 200);
    setStock(s.ing.box, 4);
    const before = written();
    const r = await data<PrintResult>('inventory:printPrepList', { lines: [item(s.item.fajitaM, 10)] });
    expect(r.ok).toBe(true);
    expect(h.printed).toHaveLength(1);
    const text = escPosToText(h.printed[0]!);
    expect(text).toMatch(/Test\s+Manager/);
    for (const want of [
      'PREP LIST',
      '10 x Fajita Pizza - Medium',
      'MAKE FIRST',
      'needs 500 g: 200 g in stock',
      'SHORT 6 pcs (in stock 4',
      'FROM STOCK',
      'EVERYTHING FROM SCRATCH',
    ]) {
      expect(text).toContain(want);
    }
    // Only the 300 g the shelf does not hold is made, and the tomato for that.
    expect(text).toMatch(/^Test sauce +300 g$/m);
    expect(text).toMatch(/^ {2}Test tomato +375 g$/m);
    expect(text).not.toMatch(/Rs\b/);
    expect(written()).toEqual(before);
  });

  it('a sauce with enough on the shelf is not on MAKE FIRST: it is under FROM STOCK, said to be enough', async () => {
    h.session = MANAGER;
    await data<PrintResult>('inventory:printPrepList', { lines: [item(s.item.fajitaM, 10)] });
    const text = escPosToText(h.printed[0]!);
    expect(text).not.toContain('MAKE FIRST');
    expect(text).toMatch(/^Test sauce +500 g$/m);
    expect(text).toMatch(/^ {2}enough in stock here \(100 kg\):\s+no need to make/m);
    expect(text).not.toContain('Test tomato');
  });

  it('a printer that fails is an answer the screen can show, not an error', async () => {
    h.session = MANAGER;
    h.printResult = { ok: false, durationMs: 1, error: { code: 'printer_offline', message: 'The printer is off', recoverable: true } };
    expect(await call('inventory:printPrepList', { lines: [item(s.item.fajitaM, 2)] })).toEqual({ ok: true, data: h.printResult });
  });
});
