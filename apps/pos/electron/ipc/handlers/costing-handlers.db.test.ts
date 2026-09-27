/**
 * The Costing channels (costing spec Phase 1) through the real IPC handlers,
 * against a real database built from every migration and a made-up shop
 * (db/costing-shop.fixture.ts):
 *   - a cashier is refused every costing:* channel in the main process, and
 *     a manager may read costs but not change the owner's targets, and sees
 *     no profit (owner, 2026-09-27): no "you keep", no What-if;
 *   - Menu costs: cost to make, price, what you keep (the owner's), food
 *     cost % and the chip — neutral while the targets are suggestions,
 *     coloured once the owner taps "Use these"; the item cost sheet with its
 *     batch sauce opened up, the customer's picks, paid extras and leave-outs;
 *   - Missing costs lists an unpriced ingredient and a food item with no
 *     recipe; marking the ingredient "free" takes it off;
 *   - the batch calculator (200 g of a 2 kg sauce, every input costed) and
 *     "Make this amount" (inventory:makeBatch with any amount), which any
 *     login may call and which answers with no costs;
 *   - Phase 9: foodpanda's commission and the rider cost (managers read, the
 *     owner saves — synced and audited); What-if (profit.view, the owner's
 *     alone): a dearer tomato flows through the sauce into every pizza, at
 *     the last 4 weeks' sales, nothing saved; "price to hit target" and what
 *     you keep only for profit.view.
 *
 * Only `defineHandler` (captured) and the signed-in session are stood in
 * for. node:sqlite behind better-sqlite3's shape; skips where it is
 * missing. Every name and price is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, BatchCalc, CostingTargetsView, ItemCostSheet, MenuCostsView, MissingCosts, UUID } from '@cheeseoclock/shared-types';
import { DatabaseSync, DEV, MANAGER as MANAGER_ACTOR, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
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

const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');

let db: ReturnType<typeof openMigrated>;
let s: Awaited<ReturnType<typeof openCostingShop>>;

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

/** What the screen gets back: the handler's answer, or the guard's / repository's refusal. */
async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string } };
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

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  s = await openCostingShop(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./costing-handlers.js')).registerCostingHandlers(ctx);
  (await import('./inventory-handlers.js')).registerInventoryHandlers(ctx);
});

const live = describe.skipIf(!DatabaseSync);

const READ_CHANNELS = (): Record<string, unknown> => ({
  'costing:menuCosts': undefined,
  'costing:itemSheet': { menuItemId: s.item.fajitaM },
  'costing:missingCosts': undefined,
  'costing:getTargets': undefined,
  'costing:recipeCost': { menuItemId: s.item.fajitaM, lines: [] },
  'costing:batchCalc': { ingredientId: s.ing.sauce, amount: 200 },
  // The recipe calculator's costs (recipe-calc-handlers.db.test.ts has the rest).
  'costing:recipeCalc': { lines: [{ kind: 'item', menuItemId: s.item.fajitaM, count: 10, portions: [] }] },
  // Price alerts (costing spec Phase 6): managers read them and mark them seen.
  'costing:alerts': undefined,
  'costing:markAlertsSeen': { ids: ['no-such-alert'] },
  'costing:getAlertSettings': undefined,
  // How many tills take orders (costing spec Phase 8): managers read it.
  'costing:getTills': undefined,
  // foodpanda's commission and the rider cost (costing spec Phase 9): managers read them.
  'costing:getChannelFees': undefined,
});

/** Profit (profit.view, costing spec Phase 9): the owner's alone since 2026-09-27 (owner question 8). */
const PROFIT_CHANNELS = (): Record<string, unknown> => ({
  // What-if: prices tried against the last 4 weeks, never saved.
  'costing:whatIf': { ingredients: [], items: [] },
});

/** What a login without profit.view is told (guards.ts REFUSED.profit, shown as it is). */
const NO_PROFIT = 'Only the owner can see profit.';

/** What Costing → Targets & fees saves for Phase 9 (made-up figures). */
const FEES = () => ({
  fees: { paymentFeeBps: { cash: 0, card: 250, foodpanda: 0, transfer: 0 } },
  riderCost: { mode: 'fixed', fixedCents: 15_000 },
});

const ALERT_SETTINGS = () => ({ jumpBps: 1_500, impactWeekCents: 50_000, keyIngredientIds: [s.ing.cheese] });

live('who may see costs', () => {
  it('a cashier is refused every costing channel in the main process, in plain words', async () => {
    h.session = CASHIER;
    const channels = {
      ...READ_CHANNELS(),
      ...PROFIT_CHANNELS(),
      'costing:setTargets': { defaultBps: 3000, amberBps: 500, perCategory: {}, nonFoodCategoryIds: [], priceStepCents: 1000 },
      'costing:setAlertSettings': ALERT_SETTINGS(),
      'costing:setTills': { sellingTills: 2 },
      'costing:setChannelFees': FEES(),
    };
    expect(Object.keys(channels).sort()).toEqual([...h.handlers.keys()].filter((c) => c.startsWith('costing:')).sort());
    for (const [channel, payload] of Object.entries(channels)) {
      expect({ channel, o: await call(channel, payload) }).toEqual({
        channel,
        o: { ok: false, code: 'forbidden', message: 'Only a manager or the owner can see costs.' },
      });
    }
    expect(count(`SELECT COUNT(*) AS n FROM business_settings`)).toBe(0);
  });

  it('nobody signed in: "not logged in"', async () => {
    for (const [channel, payload] of Object.entries({ ...READ_CHANNELS(), ...PROFIT_CHANNELS() })) {
      expect((await call(channel, payload)) as { code?: string }).toMatchObject({ ok: false, code: 'unauthenticated' });
    }
  });

  it('a manager reads every cost figure but no profit, and cannot change the owner\'s targets', async () => {
    h.session = MANAGER;
    for (const [channel, payload] of Object.entries(READ_CHANNELS())) {
      expect({ channel, ok: (await call(channel, payload)).ok }).toEqual({ channel, ok: true });
    }
    // Profit is the owner's alone (owner, 2026-09-27): What-if is refused in plain words, and nothing is written.
    const written = count(`SELECT COUNT(*) AS n FROM sync_queue`) + count(`SELECT COUNT(*) AS n FROM audit_log`);
    for (const [channel, payload] of Object.entries(PROFIT_CHANNELS())) {
      expect({ channel, o: await call(channel, payload) }).toEqual({ channel, o: { ok: false, code: 'forbidden', message: NO_PROFIT } });
    }
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue`) + count(`SELECT COUNT(*) AS n FROM audit_log`)).toBe(written);
    const target = await data<CostingTargetsView>('costing:getTargets');
    const o = await call('costing:setTargets', {
      defaultBps: target.defaultBps,
      amberBps: target.amberBps,
      perCategory: {},
      nonFoodCategoryIds: [],
      priceStepCents: target.priceStepCents,
    });
    expect(o).toEqual({ ok: false, code: 'forbidden', message: 'Only the owner can change the food-cost targets.' });
    // …nor the price alerts' thresholds (costing spec Phase 6: managers read them).
    expect(await call('costing:setAlertSettings', ALERT_SETTINGS())).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'Only the owner can change the price alerts.',
    });
    expect(count(`SELECT COUNT(*) AS n FROM business_settings`)).toBe(0);
  });

  it('the owner changes the price alerts; both tills share them (business_settings, synced and audited)', async () => {
    h.session = MANAGER;
    const suggested = await data<{ jumpBps: number; impactWeekCents: number; keysSuggested: boolean; ingredients: Array<{ ingredientId: string; key: boolean }> }>(
      'costing:getAlertSettings',
    );
    // Nothing saved: 10%, Rs 1,000 a week, and the key ingredients suggested by name.
    expect(suggested).toMatchObject({ jumpBps: 1_000, impactWeekCents: 100_000, keysSuggested: true });
    expect(suggested.ingredients.filter((i) => i.key).map((i) => i.ingredientId).sort()).toEqual([s.ing.box, s.ing.chicken, s.ing.dough].sort());
    h.session = OWNER;
    const saved = await data<{ jumpBps: number; keysSuggested: boolean; ingredients: Array<{ ingredientId: string; key: boolean }> }>(
      'costing:setAlertSettings',
      { ...ALERT_SETTINGS(), keyIngredientIds: [s.ing.cheese, 'no-such-ingredient'] },
    );
    expect(saved).toMatchObject({ jumpBps: 1_500, keysSuggested: false });
    expect(saved.ingredients.filter((i) => i.key).map((i) => i.ingredientId)).toEqual([s.ing.cheese]);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings'`)).toBe(1);
    // A value that does not fit is refused, with the field named.
    expect(await call('costing:setAlertSettings', { ...ALERT_SETTINGS(), jumpBps: 50 })).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it("\"Use the sheet's price\" is refused to a cashier, like every price", async () => {
    h.session = CASHIER;
    expect(await call('inventory:useSheetPrice', { ingredientId: s.ing.cheese })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'Only a manager or the owner can change prices.',
    });
  });

  it('"Make this amount" stays open to any login (kitchen staff record batches), and answers with no costs', async () => {
    h.session = CASHIER;
    const made = await data<Record<string, unknown>>('inventory:makeBatch', { ingredientId: s.ing.sauce, amount: 200 });
    expect(Object.keys(made).sort()).toEqual(['made', 'resultingQty']);
  });
});

/** "Use these": the owner confirms every suggestion as shown. */
async function useSuggestions() {
  h.session = OWNER;
  const t = await data<CostingTargetsView>('costing:getTargets');
  const perCategory = Object.fromEntries(t.categories.map((c) => [c.categoryId, { bps: c.bps, confirmed: true }]));
  return data<CostingTargetsView>('costing:setTargets', {
    defaultBps: t.defaultBps,
    amberBps: t.amberBps,
    perCategory,
    nonFoodCategoryIds: t.categories.filter((c) => c.nonFood).map((c) => c.categoryId),
    priceStepCents: t.priceStepCents,
  });
}

live('Menu costs', () => {
  it('costs every item from today\'s prices: cost to make, what you keep, food cost %', async () => {
    h.session = OWNER;
    const view = await data<MenuCostsView>('costing:menuCosts');
    const row = (id: string) => view.rows.find((r) => r.menuItemId === id)!;
    // Fajita Medium: 200 g dough Rs 18 + 50 g sauce Rs 8.90625 (rolled up from tomato and garlic)
    // + 60 g cheese Rs 72 + 40 g chicken Rs 36 + 10 g onion Rs 1.50 + box Rs 40 = Rs 176.40625
    expect(row(s.item.fajitaM)).toMatchObject({
      priceCents: 120_000,
      costCents: 17_641,
      profitCents: 102_359,
      foodCostBps: 1470,
      targetBps: 3000,
      targetConfirmed: false,
      flag: 'neutral',
    });
    // Veggie Lovers, no sales yet: the most veggies (5) × the average veggie, the average dip
    expect(row(s.item.veggieL)).toMatchObject({ costCents: 23_151, minCostCents: 20_330, maxCostCents: 24_040, foodCostBps: 1543 });
    // The deal: each pizza slot at the average of its pizzas
    expect(row(s.item.deal)).toMatchObject({ costCents: 45_125, foodCostBps: 1504, targetBps: 3500 });
    expect(row(s.item.cola)).toMatchObject({ flag: 'grey', missingLines: 1, missingIngredients: ['Test bottle'] });
    expect(row(s.item.bakedWings)).toMatchObject({ flag: 'grey', hasRecipe: false });
    expect(row(s.item.crispyWings)).toMatchObject({ costCents: 14_500, estimateLines: 1, flag: 'neutral' });
    expect(row(s.item.delivery)).toMatchObject({ flag: 'nonfood' });
    expect(view.summary).toEqual({ items: 6, onTarget: 0, close: 0, over: 0, cantCost: 2, notConfirmed: 4 });
    expect(view.missingCount).toBe(3);

    // A manager (owner, 2026-09-27): the same costs, food cost % and chips — and no "you keep" on any row.
    h.session = MANAGER;
    const mgr = await data<MenuCostsView>('costing:menuCosts');
    expect(mgr.rows.find((r) => r.menuItemId === s.item.fajitaM)).toMatchObject({ priceCents: 120_000, costCents: 17_641, profitCents: null, foodCostBps: 1470 });
    expect(mgr.rows.every((r) => r.profitCents === null)).toBe(true);
    expect(mgr.rows.map((r) => ({ ...r, profitCents: null }))).toEqual(view.rows.map((r) => ({ ...r, profitCents: null })));
    expect(mgr.summary).toEqual(view.summary);
  });

  it('the chips colour only once the owner taps "Use these"; the owner\'s own targets then decide green, amber, red', async () => {
    const saved = await useSuggestions();
    expect(saved.anyUnconfirmed).toBe(false);
    expect(saved.savedAt).not.toBeNull();
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings'`)).toBe(2);
    h.session = MANAGER;
    let view = await data<MenuCostsView>('costing:menuCosts');
    expect(view.summary).toMatchObject({ onTarget: 4, close: 0, over: 0, cantCost: 2, notConfirmed: 0 });

    // Pizza at 15% (close = 5 points): Fajita 14.70% green, Veggie Lovers 15.43% amber; deals at 10%: 15.04% red
    h.session = OWNER;
    const t = await data<CostingTargetsView>('costing:getTargets');
    const perCategory = Object.fromEntries(t.categories.map((c) => [c.categoryId, { bps: c.bps, confirmed: true }]));
    perCategory[s.cat.pizza] = { bps: 1500, confirmed: true };
    perCategory[s.cat.deals] = { bps: 1000, confirmed: true };
    await data('costing:setTargets', {
      defaultBps: t.defaultBps,
      amberBps: t.amberBps,
      perCategory,
      nonFoodCategoryIds: [s.cat.fees],
      priceStepCents: 1000,
    });
    view = await data<MenuCostsView>('costing:menuCosts');
    const flag = (id: string) => view.rows.find((r) => r.menuItemId === id)!.flag;
    expect([flag(s.item.fajitaM), flag(s.item.veggieL), flag(s.item.deal)]).toEqual(['green', 'amber', 'red']);
  });

  it('refuses a target that makes no sense', async () => {
    h.session = OWNER;
    const o = await call('costing:setTargets', { defaultBps: 3000, amberBps: 500, perCategory: { [s.cat.pizza]: { bps: 20_000, confirmed: true } }, nonFoodCategoryIds: [], priceStepCents: 1000 });
    expect(o).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(count(`SELECT COUNT(*) AS n FROM business_settings`)).toBe(0);
  });

  it('weights the customer\'s picks by what sold in the last 28 days (quantity × picks)', async () => {
    const a = s.ring([['veggieL', 4, ['pickOlive', 'pickMushroom', 'pickCorn', 'pickJalapeno', 'pickOnion', 'dipRanch']]]);
    const b = s.ring([['veggieL', 6, ['pickOnion', 'pickPepper', 'dipChili']]]);
    s.markPaid(a);
    s.markPaid(b);
    // An old sale (40 days ago) is outside the window.
    const old = s.ring([['veggieL', 50, ['pickOlive', 'dipRanch']]]);
    s.markPaid(old, new Date(Date.now() - 40 * 86_400_000));
    h.session = MANAGER;
    const sheet = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.veggieL }))!;
    // veggies: (4×12 + 4×8 + 4×4 + 4×6 + 10×1.50 + 6×3) ÷ 10 = Rs 15.30; dip: (4×17.55 + 6×12.55) ÷ 10 = Rs 14.55
    expect(sheet.row).toMatchObject({ soldLast28: 10, costCents: 18_925 + 1_530 + 1_455 });
    const veg = sheet.groups.find((g) => g.groupId === s.group.veg)!;
    expect(veg).toMatchObject({ basis: 'observed', kMin: 1, kMax: 5, typicalCostCents: 1_530 });
    expect(veg.options.find((o) => o.modifierId === s.choice.pickOlive)!.pickedShareBps).toBe(4000);
  });
});

live('the item cost sheet', () => {
  it('"On foodpanda": the price after the deal for a manager; foodpanda’s commission and what you keep for the owner only (profit.view)', async () => {
    const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
    const owner = { userId: 'u_admin', deviceId: DEV };
    setBusinessSetting(db as never, 'foodpanda.deal', { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null }, owner);
    setBusinessSetting(db as never, 'foodpanda.fees', { v: 1, commissionBps: 2_500, confirmed: true, base: 'after_deal', fixedFeeCents: 0, commissionTaxBps: 0, upliftBps: 0 }, owner);
    h.session = MANAGER;
    const forManager = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM }))!;
    const price = forManager.row.priceCents;
    expect(forManager.onFoodpanda).toMatchObject({ dealPercent: 20, priceCents: price, priceAfterDealCents: price - Math.round(price / 5), owner: null });
    h.session = OWNER;
    const forOwner = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM }))!;
    const after = forOwner.onFoodpanda!.priceAfterDealCents;
    expect(forOwner.onFoodpanda!.owner).toMatchObject({
      commissionBps: 2_500,
      confirmed: true,
      foodpandaKeepsCents: Math.round(after / 4),
      youKeepCents: after - Math.round(after / 4),
    });

    // A minimum above one plate's price: the plate is still worked at the deal's
    // price (as part of an order that reaches it), and the minimum is said.
    const minimum = Math.ceil((price * 3) / 100) * 100; // whole rupees
    setBusinessSetting(db as never, 'foodpanda.deal', { v: 1, percent: 20, shopPercent: 20, minOrderCents: minimum, maxOffCents: null, startsOn: null, endsOn: null }, owner);
    const withMinimum = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM }))!;
    expect(withMinimum.onFoodpanda).toMatchObject({ dealPercent: 20, minOrderCents: minimum, priceAfterDealCents: price - Math.round(price / 5) });

    // foodpanda 10% dearer: the listing price and the price after the deal at its prices, for both;
    // the commission on that price, and what the shop keeps, for the owner only.
    setBusinessSetting(db as never, 'foodpanda.deal', { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null }, owner);
    setBusinessSetting(db as never, 'foodpanda.fees', { v: 1, commissionBps: 2_500, confirmed: false, base: 'after_deal', fixedFeeCents: 0, commissionTaxBps: 0, upliftBps: 1_000 }, owner);
    const tillAfter = price - Math.round(price / 5);
    const dearerAfter = tillAfter + Math.round(tillAfter / 10);
    const dearerOwner = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM }))!;
    expect(dearerOwner.onFoodpanda).toMatchObject({
      upliftBps: 1_000,
      listingPriceCents: price + Math.round(price / 10),
      priceAfterDealCents: dearerAfter,
      owner: { confirmed: false, foodpandaKeepsCents: Math.round(dearerAfter / 4), youKeepCents: dearerAfter - Math.round(dearerAfter / 4) },
    });
    h.session = MANAGER;
    const dearerManager = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM }))!;
    expect(dearerManager.onFoodpanda).toMatchObject({ listingPriceCents: price + Math.round(price / 10), priceAfterDealCents: dearerAfter, owner: null });
    // …and no profit anywhere on a manager's sheet: no "you keep", no price to hit.
    expect(dearerManager.row.profitCents).toBeNull();
    expect(dearerManager.priceToHitCents).toBeNull();
    expect(JSON.stringify(dearerManager.onFoodpanda)).not.toMatch(/commission|youKeep/i);
  });

  it('every line with its price per kg, the batch sauce opened up, paid extras and leave-outs', async () => {
    h.session = OWNER;
    const sheet = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM }))!;
    expect(sheet.always.map((l) => [l.name, l.qty, l.costCents])).toEqual([
      ['Test dough', 200, 1_800],
      ['Test sauce', 50, 891],
      ['Test cheese', 60, 7_200],
      ['Test chicken', 40, 3_600],
      ['Test onion', 10, 150],
      ['Test box', 1, 4_000],
    ]);
    const cheese = sheet.always.find((l) => l.ingredientId === s.ing.cheese)!;
    expect(cheese).toMatchObject({ unitCostMc: 120_000, priceKind: 'set' }); // Rs 1,200 / kg
    expect(cheese.shareBps).toBe(4081); // Rs 72 of Rs 176.41
    const sauce = sheet.always.find((l) => l.ingredientId === s.ing.sauce)!;
    expect(sauce.madeOf).toMatchObject({ amount: 50, totalCostMc: 890_625, complete: true });
    expect(sauce.madeOf!.lines.map((l) => [l.name, l.scaledHundredths, l.stockQty, l.costMc])).toEqual([
      ['Test tomato', 6_250, 63, 750_000],
      ['Test garlic', 313, 3, 140_625],
    ]);
    expect(sheet.groups).toEqual([]);
    expect(sheet.paidExtras.map((x) => [x.name, x.priceDeltaCents, x.costCents, x.marginCents, x.foodCostBps])).toEqual([
      ['Extra cheese', 15_000, 4_800, 10_200, 3200],
      ['Extra onion', 5_000, 150, 4_850, 300],
      ['Side of Ranch', 10_000, 1_755, 8_245, 1755],
    ]);
    expect(sheet.leaveOuts).toEqual([
      { modifierId: s.choice.noOnion, name: 'No onion', ingredientName: 'Test onion', savingCents: 150, missingLines: 0 },
    ]);
    expect(await data('costing:itemSheet', { menuItemId: 'no-such-item' })).toBeNull();

    // A manager (owner, 2026-09-27): every cost the same, and no "you keep" — not per sale, not per extra.
    h.session = MANAGER;
    const mgr = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM }))!;
    expect(mgr.row.profitCents).toBeNull();
    expect(mgr.priceToHitCents).toBeNull();
    expect(mgr.paidExtras.map((x) => [x.name, x.priceDeltaCents, x.costCents, x.marginCents, x.foodCostBps])).toEqual([
      ['Extra cheese', 15_000, 4_800, null, 3200],
      ['Extra onion', 5_000, 150, null, 300],
      ['Side of Ranch', 10_000, 1_755, null, 1755],
    ]);
    expect(mgr.always).toEqual(sheet.always);
    expect(mgr.leaveOuts).toEqual(sheet.leaveOuts);
    expect(await data('costing:itemSheet', { menuItemId: 'no-such-item' })).toBeNull();
  });

  it('a deal: each pizza slot costed, the range, and what "No onion" saves across its free pizza picks', async () => {
    h.session = MANAGER;
    const sheet = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.deal }))!;
    expect(sheet.always).toEqual([]);
    expect(sheet.groups.map((g) => [g.name, g.typicalCostCents, g.cheapestCostCents, g.dearestCostCents, g.basis])).toEqual([
      ['Deal: Large pizza', 22_563, 20_575, 24_550, 'usual'],
      ['Deal: 2nd Large pizza', 22_563, 20_575, 24_550, 'usual'],
    ]);
    expect(sheet.leaveOuts).toEqual([expect.objectContaining({ name: 'No onion', savingCents: 225 })]);
  });

  it('the recipe editor\'s live footer costs the recipe as typed, before it is saved', async () => {
    h.session = MANAGER;
    const lines = [
      { ingredientId: s.ing.dough, qtyPerUnit: 200, modifierId: null },
      { ingredientId: s.ing.cheese, qtyPerUnit: 100, modifierId: null },
      { ingredientId: '', qtyPerUnit: 0, modifierId: null }, // a line still being filled in
    ];
    expect(await data('costing:recipeCost', { menuItemId: s.item.fajitaM, lines })).toMatchObject({
      hasRecipe: true,
      costCents: 1_800 + 12_000,
      priceCents: 120_000,
      foodCostBps: 1150,
      flag: 'neutral',
    });
    expect(await data('costing:recipeCost', { menuItemId: s.item.fajitaM, lines: [{ ingredientId: s.ing.bottle, qtyPerUnit: 1 }] })).toMatchObject({
      missingLines: 1,
      flag: 'grey',
    });
    expect(await call('costing:recipeCost', { menuItemId: 'no-such-item', lines: [] })).toMatchObject({ ok: false, code: 'precondition_failed' });
  });
});

live('Missing costs', () => {
  it('lists the unpriced bottle, the food item with no recipe and the guessed breading; "free" takes the bottle off', async () => {
    h.session = MANAGER;
    let m = await data<MissingCosts>('costing:missingCosts');
    expect(m.unpriced.map((r) => [r.name, r.items])).toEqual([['Test bottle', ['Cola 345 ml']]]);
    expect(m.noRecipe.map((r) => r.name)).toEqual(['Baked Wings']); // not the delivery charge
    expect(m.guessed.map((r) => r.name)).toEqual(['Test breading']);
    expect(m.roundedPerGram).toEqual([]);
    expect(m.batches).toEqual([]);
    expect(m.total).toBe(3);

    // "Mark free" on the Missing costs row: an ordinary ingredient update
    await data('inventory:updateIngredient', { id: s.ing.bottle, priceKind: 'free' });
    m = await data<MissingCosts>('costing:missingCosts');
    expect(m.unpriced).toEqual([]);
    expect(m.total).toBe(2);
    const cola = (await data<MenuCostsView>('costing:menuCosts')).rows.find((r) => r.menuItemId === s.item.cola)!;
    expect(cola).toMatchObject({ missingLines: 0, costCents: 0 });
  });

  it('a batch with an unpriced input, and a per-gram price rounded to whole paisa', async () => {
    h.session = MANAGER;
    await data('inventory:updateIngredient', { id: s.ing.garlic, costPerUnitCents: 0, packSize: null, packPriceCents: null });
    await data('inventory:updateIngredient', { id: s.ing.onion, costPerUnitCents: 15, packSize: null, packPriceCents: null });
    const m = await data<MissingCosts>('costing:missingCosts');
    expect(m.batches).toEqual([
      { ingredientId: s.ing.sauce, name: 'Test sauce', unpricedInputs: [{ ingredientId: s.ing.garlic, name: 'Test garlic', gone: false }], loop: false },
    ]);
    // garlic reaches three dishes through the sauce, the bottle one: most used first
    expect(m.unpriced.map((r) => [r.name, r.items.length])).toEqual([
      ['Test garlic', 3],
      ['Test bottle', 1],
    ]);
    expect(m.roundedPerGram.map((r) => r.name)).toEqual(['Test onion']);
  });
});

live('the batch calculator and "Make this amount"', () => {
  it('200 g of a 2,000 g sauce: every input scaled and costed, the total, per gram and per kg', async () => {
    h.session = MANAGER;
    const c = await data<BatchCalc>('costing:batchCalc', { ingredientId: s.ing.sauce, amount: 200 });
    expect(c).toMatchObject({ batchYield: 2000, amount: 200, totalCostMc: 3_562_500, totalCostCents: 3_563, perUnitMc: 17_813, complete: true, maxAmount: 200_000 });
    expect(c.lines.map((l) => [l.name, l.perBatchQty, l.scaledHundredths, l.stockQty, l.unitCostMc, l.costMc, l.shareBps])).toEqual([
      ['Test tomato', 2500, 25_000, 250, 12_000, 3_000_000, 8421],
      ['Test garlic', 125, 1_250, 13, 45_000, 562_500, 1579],
    ]);
    expect(await call('costing:batchCalc', { ingredientId: s.ing.tomato, amount: 200 })).toMatchObject({ ok: false, code: 'precondition_failed', message: 'This ingredient has no batch recipe' });
    expect(await call('costing:batchCalc', { ingredientId: s.ing.sauce, amount: 12.5 })).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('a batch made from another batch: the sauce inside opens up, scaled the same way, and adds up exactly', async () => {
    // A made-up base mix: 500 g sauce (made here) + 500 g cheese → 1,000 g.
    const mix = s.r.createIngredient(db, { name: 'Test base mix', unit: 'g' }, MANAGER_ACTOR).id;
    s.r.setBatchRecipe(
      db,
      {
        ingredientId: mix,
        batchYield: 1000,
        batchMethod: null,
        lines: [
          { inputIngredientId: s.ing.sauce, qty: 500 },
          { inputIngredientId: s.ing.cheese, qty: 500 },
        ],
      },
      MANAGER_ACTOR,
    );
    h.session = MANAGER;
    const c = await data<BatchCalc>('costing:batchCalc', { ingredientId: mix, amount: 200 });
    // 100 g sauce at its rolled-up Rs 356.25 / 2,000 g = Rs 17.8125; 100 g cheese at Rs 1,200 / kg = Rs 120
    expect(c.lines.map((l) => [l.name, l.stockQty, l.costMc, l.madeInHouse])).toEqual([
      ['Test sauce', 100, 1_781_250, true],
      ['Test cheese', 100, 12_000_000, false],
    ]);
    expect(c).toMatchObject({ totalCostMc: 13_781_250, totalCostCents: 13_781, perUnitMc: 68_906, complete: true });
    const sauce = c.lines[0]!.madeOf!;
    expect(sauce).toMatchObject({ amount: 100, totalCostMc: 1_781_250 });
    expect(sauce.lines.map((l) => [l.name, l.scaledHundredths, l.costMc])).toEqual([
      ['Test tomato', 12_500, 1_500_000],
      ['Test garlic', 625, 281_250],
    ]);

    // Making it takes the sauce and the cheese, not what the sauce is made of.
    const before = { sauce: s.stockOf('sauce'), cheese: s.stockOf('cheese'), tomato: s.stockOf('tomato') };
    expect(await data('inventory:makeBatch', { ingredientId: mix, amount: 200 })).toEqual({ made: 200, resultingQty: 200 });
    expect([s.stockOf('sauce'), s.stockOf('cheese'), s.stockOf('tomato')]).toEqual([before.sauce - 100, before.cheese - 100, before.tomato]);
  });

  it('"Make this amount" takes out exactly what the calculator showed, and adds what was made', async () => {
    h.session = MANAGER;
    const shown = await data<BatchCalc>('costing:batchCalc', { ingredientId: s.ing.sauce, amount: 200 });
    const before = { tomato: s.stockOf('tomato'), garlic: s.stockOf('garlic'), sauce: s.stockOf('sauce') };
    h.session = CASHIER;
    expect(await data('inventory:makeBatch', { ingredientId: s.ing.sauce, amount: 200 })).toEqual({ made: 200, resultingQty: before.sauce + 200 });
    expect(s.stockOf('tomato')).toBe(before.tomato - shown.lines[0]!.stockQty);
    expect(s.stockOf('garlic')).toBe(before.garlic - shown.lines[1]!.stockQty);
    expect(s.stockOf('sauce')).toBe(before.sauce + 200);
    const notes = (db.prepare(`SELECT notes FROM stock_movements ORDER BY rowid`).all() as Array<{ notes: string }>).map((r) => r.notes);
    expect(notes).toEqual([
      'Used to make 200 g of Test sauce (0.1 of a batch)',
      'Used to make 200 g of Test sauce (0.1 of a batch)',
      'Made 200 g (0.1 of a batch; one batch makes 2,000 g)',
    ]);
    // …and the old whole-batch button still works
    expect(await data('inventory:makeBatch', { ingredientId: s.ing.sauce, batches: 1 })).toEqual({ made: 2000, resultingQty: before.sauce + 2200 });
    expect(await call('inventory:makeBatch', { ingredientId: s.ing.sauce, batches: 1, amount: 5 })).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(await call('inventory:makeBatch', { ingredientId: s.ing.sauce, amount: 200_001 })).toMatchObject({ ok: false, code: 'precondition_failed' });
  });
});

live('the cost sheet says what is not known, and never shows it as Rs 0', () => {
  it('"Always in it" shares are of the whole typical plate, choices included', async () => {
    h.session = MANAGER;
    const sheet = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.veggieL }))!;
    // Veggie Lovers: dough, sauce, cheese and box are always in it; the veggies and the dip are picks.
    const plateMc = sheet.always.reduce((t, l) => t + l.costMc, 0) + sheet.groups.reduce((t, g) => t + g.typicalCostCents * 1000, 0);
    const cheese = sheet.always.find((l) => l.ingredientId === s.ing.cheese)!;
    expect(cheese.costCents).toBe(10_800); // 90 g at Rs 1,200 / kg
    // Rs 108 of the Rs 231.51 plate, not of the Rs 189.25 always in it
    expect(sheet.row.costCents).toBe(23_151);
    expect(cheese.shareBps).toBe(4665);
    expect(sheet.always.reduce((t, l) => t + (l.shareBps ?? 0), 0)).toBeLessThan(10_000);
    expect(Math.abs(plateMc - sheet.row.costCents * 1000)).toBeLessThan(2_000);
  });

  it('one unpriced ingredient in every pizza of a deal is named once; leaving it out saves "not known", not Rs 0', async () => {
    h.session = MANAGER;
    await data('inventory:updateIngredient', { id: s.ing.onion, costPerUnitCents: 0, packSize: null, packPriceCents: null });
    const deal = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.deal }))!;
    // onion is in the Fajita of both slots (two lines), and it is one ingredient to price
    expect(deal.row).toMatchObject({ flag: 'grey', missingLines: 2, missingIngredients: ['Test onion'] });
    expect(deal.leaveOuts).toEqual([expect.objectContaining({ name: 'No onion', savingCents: 0, missingLines: 2 })]);
    const preview = await data<{ missingIngredients: string[] }>('costing:recipeCost', {
      menuItemId: s.item.fajitaM,
      lines: [
        { ingredientId: s.ing.onion, qtyPerUnit: 10 },
        { ingredientId: s.ing.onion, qtyPerUnit: 5, modifierId: s.choice.extraOnion },
        { ingredientId: s.ing.bottle, qtyPerUnit: 1 },
      ],
    });
    expect(preview.missingIngredients).toEqual(['Test onion', 'Test bottle']);
  });
});

live('customer picks are weighted over the sales that made them', () => {
  it('orders that came without a dip do not make the required dip cost Rs 0', async () => {
    // Twenty Veggie Lovers rung up before the dip was asked for: veggies, no dip.
    s.markPaid(s.ring([['veggieL', 20, ['pickOnion']]]));
    h.session = MANAGER;
    let sheet = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.veggieL }))!;
    let dip = sheet.groups.find((g) => g.groupId === s.group.yourDip)!;
    // no dip picked at all yet: the usual fallback, the average dip (Rs 17.55 and Rs 12.55)
    expect(dip).toMatchObject({ basis: 'usual', typicalCostCents: 1_505 });
    expect(sheet.groups.find((g) => g.groupId === s.group.veg)!.basis).toBe('observed');

    // Ten more, each with a ranch dip: the dip is weighted over those ten, not over all thirty.
    s.markPaid(s.ring([['veggieL', 10, ['pickOnion', 'dipRanch']]]));
    sheet = (await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.veggieL }))!;
    dip = sheet.groups.find((g) => g.groupId === s.group.yourDip)!;
    expect(dip).toMatchObject({ basis: 'observed', typicalCostCents: 1_755 });
    expect(dip.options.find((o) => o.modifierId === s.choice.dipRanch)!.pickedShareBps).toBe(10_000);
    expect(sheet.row.soldLast28).toBe(30);
  });
});

live('a dish taken off the menu', () => {
  it('counts nowhere once it is hidden and not selling; a hidden dish that still sold stays in', async () => {
    h.session = MANAGER;
    // Baked Wings last sold 40 days ago, then hidden; so is the cola, never sold.
    const wings = s.ring([['bakedWings', 2]]);
    s.markPaid(wings, new Date(Date.now() - 40 * 86_400_000));
    s.r.updateMenuItem(db, { id: s.item.bakedWings, isActive: false }, MANAGER_ACTOR);
    s.r.updateMenuItem(db, { id: s.item.cola, isActive: false }, MANAGER_ACTOR);
    let m = await data<MissingCosts>('costing:missingCosts');
    expect(m.noRecipe).toEqual([]);
    expect(m.unpriced).toEqual([]); // the bottle is only in the hidden cola
    expect(m.total).toBe(1); // the guessed breading
    let view = await data<MenuCostsView>('costing:menuCosts');
    expect(view.summary).toMatchObject({ items: 4, cantCost: 0 });
    expect(view.missingCount).toBe(1);
    // still in the table, tagged off the menu by the screen
    expect(view.rows.find((r) => r.menuItemId === s.item.bakedWings)).toMatchObject({ isActive: false, flag: 'grey' });

    // Hidden today (sold out) but sold this week: still on the menu.
    s.markPaid(wings, new Date());
    m = await data<MissingCosts>('costing:missingCosts');
    expect(m.noRecipe.map((r) => r.name)).toEqual(['Baked Wings']);
    view = await data<MenuCostsView>('costing:menuCosts');
    expect(view.summary).toMatchObject({ items: 5, cantCost: 1 });
  });
});

live('the costing channels and a growing order history', () => {
  /** The SQL a channel prepares. */
  async function sqlOf(channel: string, payload?: unknown): Promise<string[]> {
    const seen: string[] = [];
    const target = db as unknown as { prepare: (sql: string) => unknown };
    const prepare = target.prepare;
    target.prepare = (sql: string) => {
      seen.push(sql);
      return prepare(sql);
    };
    try {
      await data(channel, payload);
    } finally {
      target.prepare = prepare;
    }
    return seen;
  }
  const readsSales = (sql: string[]) => sql.some((q) => /\border_items\b/.test(q));

  it('the batch calculator and the targets read no sales at all', async () => {
    h.session = MANAGER;
    expect(readsSales(await sqlOf('costing:batchCalc', { ingredientId: s.ing.sauce, amount: 200 }))).toBe(false);
    expect(readsSales(await sqlOf('costing:getTargets'))).toBe(false);
    // the recipe editor's footer and the cost sheet read one item's sales, not the menu's
    for (const [channel, payload] of [
      ['costing:recipeCost', { menuItemId: s.item.fajitaM, lines: [] }],
      ['costing:itemSheet', { menuItemId: s.item.fajitaM }],
    ] as const) {
      const sales = (await sqlOf(channel, payload)).filter((q) => /\border_items\b/.test(q));
      expect(sales.length).toBeGreaterThan(0);
      expect(sales.every((q) => q.includes('oi.menu_item_id = ?'))).toBe(true);
    }
  });

  it('every sales query walks the 28-day window by the orders\' date index, never every choice ever sold', async () => {
    s.markPaid(s.ring([['veggieL', 1, ['pickOnion', 'dipRanch']]])); // a sale, so the picks are read too
    h.session = MANAGER;
    const sales = (await sqlOf('costing:menuCosts')).filter((q) => /\border_items\b/.test(q));
    expect(sales.length).toBe(2); // units and sales; then picks and units per choice group, in one walk of the choices
    for (const q of sales) {
      const args = Array.from({ length: (q.match(/\?/g) ?? []).length }, () => '2026-01-01T00:00:00.000Z');
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail);
      expect({ q, plan }).toEqual({ q, plan: expect.arrayContaining([expect.stringMatching(/^SEARCH o USING INDEX idx_orders_created/)]) });
      expect({ q, scans: plan.filter((d) => /^SCAN (o|oi|oim|m)\b/.test(d)) }).toEqual({ q, scans: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 9: fees, What-if, price to hit target
// ---------------------------------------------------------------------------

/** Sold `n` of an item within the last 28 days (made-up prices): stock taken, cost kept, paid. */
function sold(item: keyof typeof s.item, n: number, picks: Parameters<typeof s.ring>[0][number][2] = []): void {
  for (let i = 0; i < n; i++) {
    const o = s.ring([[item, 1, picks]]);
    s.r.decrementForOrder(db, o, MANAGER_ACTOR);
    s.markPaid(o, new Date(Date.now() - 86_400_000));
  }
}

live('card fees and the rider cost (costing spec Phase 9); foodpanda\'s terms are Settings → foodpanda\'s', () => {
  const fpRow = () =>
    db.prepare(`SELECT value_json FROM business_settings WHERE key = 'channels.fees' AND deleted_at IS NULL`).get() as { value_json: string } | undefined;

  it('the defaults until the owner answers; managers read them without foodpanda, only the owner saves them (synced and audited)', async () => {
    h.session = MANAGER;
    const view = await data<import('@cheeseoclock/shared-types').ChannelFeesView>('costing:getChannelFees');
    expect(view).toEqual({
      isDefault: true,
      savedAt: null,
      fees: { paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 } },
      riderCost: { mode: 'zone_rate', fixedCents: 0 },
      // foodpanda's commission is profit: never a manager's.
      foodpanda: null,
    });
    expect(await call('costing:setChannelFees', FEES())).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'Only the owner can change the card fees and the rider cost.',
    });
    h.session = OWNER;
    // The owner sees foodpanda's terms in force, read-only: the suggested 25%, not confirmed.
    expect((await data<import('@cheeseoclock/shared-types').ChannelFeesView>('costing:getChannelFees')).foodpanda).toMatchObject({
      fees: { commissionBps: 2_500, confirmed: false, base: 'after_deal', upliftBps: 0 },
      isDefault: true,
      carriedOver: false,
      deal: { percent: 0 },
      dealToday: false,
    });
    const saved = await data<import('@cheeseoclock/shared-types').ChannelFeesView>('costing:setChannelFees', FEES());
    expect(saved).toMatchObject({ isDefault: false, ...FEES() });
    expect(count(`SELECT COUNT(*) AS n FROM business_settings WHERE key IN ('channels.fees', 'delivery.riderCost')`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings'`)).toBe(2);
    // A payment fee over 100% is refused, with the field named.
    const bad = FEES();
    bad.fees.paymentFeeBps.card = 12_000;
    expect(await call('costing:setChannelFees', bad)).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('a foodpanda part in the request (an older screen) is stripped: never saved, never in force', async () => {
    h.session = OWNER;
    const withFoodpanda = { ...FEES(), fees: { ...FEES().fees, foodpanda: { commissionBps: 12_000, base: 'menu_price', fixedFeeCents: 999, upliftBps: 5_000 } } };
    const saved = await data<import('@cheeseoclock/shared-types').ChannelFeesView>('costing:setChannelFees', withFoodpanda);
    expect(saved.fees).toEqual(FEES().fees);
    expect(JSON.parse(fpRow()!.value_json)).toEqual(FEES().fees);
    // Not carried over either: nothing v0.7.20 saved.
    expect(saved.foodpanda).toMatchObject({ fees: { commissionBps: 2_500, confirmed: false }, carriedOver: false, isDefault: true });
  });

  it("v0.7.20's saved foodpanda part: carried over for display (and in force), and kept as stored when the card fees are saved", async () => {
    const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
    const legacy = { commissionBps: 2_200, base: 'paid_incl_tax' as const, fixedFeeCents: 2_500, upliftBps: 1_000 };
    setBusinessSetting(db as never, 'channels.fees', { foodpanda: legacy, paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 } }, { userId: 'u_admin', deviceId: DEV });
    h.session = OWNER;
    const view = await data<import('@cheeseoclock/shared-types').ChannelFeesView>('costing:getChannelFees');
    expect(view.fees).toEqual({ paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 } });
    expect(view.foodpanda).toMatchObject({
      fees: { commissionBps: 2_200, confirmed: true, base: 'after_deal', fixedFeeCents: 2_500, commissionTaxBps: 0, upliftBps: 1_000 },
      carriedOver: true,
      isDefault: false,
    });
    // Saving the card fees with a different foodpanda part: the stored one stays exactly as it was.
    await data('costing:setChannelFees', { ...FEES(), fees: { ...FEES().fees, foodpanda: { ...legacy, commissionBps: 3_000 } } });
    expect(JSON.parse(fpRow()!.value_json)).toEqual({ foodpanda: legacy, paymentFeeBps: FEES().fees.paymentFeeBps });
    expect((await data<import('@cheeseoclock/shared-types').ChannelFeesView>('costing:getChannelFees')).foodpanda?.fees.commissionBps).toBe(2_200);
    // A manager still gets no foodpanda part.
    h.session = MANAGER;
    expect((await data<import('@cheeseoclock/shared-types').ChannelFeesView>('costing:getChannelFees')).foodpanda).toBeNull();
  });
});

live('What-if (costing spec 4.9)', () => {
  it('a dearer tomato flows through the sauce into every pizza, at the last 4 weeks\' sales; nothing is saved', async () => {
    sold('fajitaM', 8);
    h.session = OWNER;
    const before = count(`SELECT COUNT(*) AS n FROM ingredient_costs`) + count(`SELECT COUNT(*) AS n FROM sync_queue`) + count(`SELECT COUNT(*) AS n FROM audit_log`);
    const tomato = { ingredientId: s.ing.tomato, packSize: 5_000, packPriceCents: 120_000 }; // Rs 240 a kilo (was Rs 120)
    const r = await data<import('@cheeseoclock/shared-types').WhatIfResult>('costing:whatIf', { ingredients: [tomato], items: [] });
    expect(r.engine).toBe('main');
    // The tomato as tried, and the sauce made from it.
    expect(r.ingredients.map((i) => [i.ingredientId, i.batch])).toEqual([
      [s.ing.tomato, false],
      [s.ing.sauce, true],
    ]);
    expect(r.ingredients[0]).toMatchObject({ beforeUnitCostMc: 12_000, afterUnitCostMc: 24_000, changeBps: 10_000 });
    const fajita = r.rows.find((x) => x.menuItemId === s.item.fajitaM)!;
    // 50 g of sauce: 2,500 g of tomato in 2,000 g of sauce, 12 paisa a gram more → 62.5 × 12 = 750 paisa more a pizza.
    expect(fajita.changed).toBe(true);
    expect(fajita.newCostCents - fajita.costCents).toBe(750);
    // 8 in 4 weeks = 2 a week: Rs 15 a week less.
    expect(fajita).toMatchObject({ soldLast28: 8, weeklyUnitsTenths: 20, weekCents: -1_500, breakEvenBps: null });
    // Every dish with sauce moved; the cola did not.
    expect(r.rows.find((x) => x.menuItemId === s.item.deal)!.changed).toBe(true);
    expect(r.rows.find((x) => x.menuItemId === s.item.cola)!.changed).toBe(false);
    expect(r.rows[0]!.changed).toBe(true);
    expect(r.totalWeekCents).toBe(r.rows.reduce((a, x) => a + x.weekCents, 0));
    // Not food (the delivery charge) is not a dish here.
    expect(r.rows.some((x) => x.menuItemId === s.item.delivery)).toBe(false);
    // Nothing written: no price, no history row, no sync or audit row.
    expect(count(`SELECT COUNT(*) AS n FROM ingredient_costs`) + count(`SELECT COUNT(*) AS n FROM sync_queue`) + count(`SELECT COUNT(*) AS n FROM audit_log`)).toBe(before);
    expect(db.prepare(`SELECT pack_price_cents AS p FROM ingredients WHERE id = ?`).get(s.ing.tomato)).toEqual({ p: 60_000 });
  });

  it('a menu price tried: per week at the same sales, the break-even volume, and the price that hits the target', async () => {
    sold('fajitaM', 8);
    h.session = OWNER;
    const r = await data<import('@cheeseoclock/shared-types').WhatIfResult>('costing:whatIf', { ingredients: [], items: [{ menuItemId: s.item.fajitaM, priceCents: 130_000 }] });
    const f = r.rows.find((x) => x.menuItemId === s.item.fajitaM)!;
    expect(f).toMatchObject({ basePriceCents: 120_000, newBasePriceCents: 130_000, newPriceCents: 130_000, weekCents: 20_000, changed: true });
    // Earns about Rs 1,024 now (Rs 1,200 − Rs 176.41); Rs 100 more: sales could fall about 8.9% before it earns less.
    expect(f.breakEvenBps).toBe(Math.round((-10_000 * 10_000) / (f.profitCents + 10_000)));
    expect(f.priceToHitCents).not.toBeNull();
  });

  it('refused to a cashier (costs) and to a manager (profit, the owner\'s alone since 2026-09-27); the owner may', async () => {
    h.session = CASHIER;
    expect(await call('costing:whatIf', { ingredients: [], items: [] })).toEqual({ ok: false, code: 'forbidden', message: 'Only a manager or the owner can see costs.' });
    h.session = MANAGER;
    expect(await call('costing:whatIf', { ingredients: [], items: [] })).toEqual({ ok: false, code: 'forbidden', message: NO_PROFIT });
    expect(await call('costing:whatIf', { ingredients: [], items: [{ menuItemId: s.item.fajitaM, priceCents: 130_000 }] })).toEqual({
      ok: false,
      code: 'forbidden',
      message: NO_PROFIT,
    });
    // "Price to hit target" and what you keep are left out of the cost sheet too; the costs stay.
    const sheet = await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM });
    expect(sheet.priceToHitCents).toBeNull();
    expect(sheet.row.profitCents).toBeNull();
    expect(sheet.row.costCents).toBeGreaterThan(0);
    h.session = OWNER;
    expect((await call('costing:whatIf', { ingredients: [], items: [] })).ok).toBe(true);
    const own = await data<ItemCostSheet>('costing:itemSheet', { menuItemId: s.item.fajitaM });
    // At the suggested 30%: the cost ÷ 0.3, up to the next Rs 10.
    expect(own.priceToHitCents).toBe(Math.ceil(own.row.costCents / 0.3 / 1_000) * 1_000);
    expect(await call('costing:whatIf', { ingredients: [{ ingredientId: s.ing.tomato, packSize: 0, packPriceCents: 1 }], items: [] })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
  });
});
