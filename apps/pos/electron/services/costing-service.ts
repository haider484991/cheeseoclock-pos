/**
 * The Costing page, read-only (costing spec, Phase 1): what every menu item
 * costs to make at today's prices, whether its food cost is on target, what
 * is still missing a price, the item cost sheet and the batch calculator.
 *
 * Everything is worked out here from the live menu, recipes and prices by
 * the pure functions in pos-domain (effectivePrices, expandRecipe via
 * plateCost, scaleBatch, findMissingCosts) — nothing is stored with a sale
 * yet (that is Phase 2). The only writes are the owner's targets and alert
 * thresholds, through business-settings-repo. The price alerts' figures
 * (Phase 6: which dishes a price change moves, per week) are worked out
 * here too; the alerts themselves are cost-alert-repo's.
 *
 * Money in paisa, unit costs in millicents, every figure rounded once.
 */
import {
  DEFAULT_PRICE_STEP_CENTS,
  confirmAll,
  findMissingCosts,
  foodCostFlag,
  maxBatchAmount,
  mulDivRound,
  plateCost,
  resolveAlertSettings,
  resolveTargets,
  scaleBatch,
  shareBps,
  suggestedKeyIngredient,
  unitCostMc,
  weeklyImpactCents,
  type CostedLine,
  type PickMix,
  type PlateCost,
  type PlateGroup,
  type PriceOf,
  type RecipeLine,
  type ResolvedAlertSettings,
  type ResolvedTarget,
  type ResolvedTargets,
  type ScaleInput,
} from '@cheeseoclock/pos-domain';
import {
  COST_ALERT_KINDS,
  type BatchCalc,
  type BatchCalcLine,
  type CostAlert,
  type CostAlertDetail,
  type CostAlertItemMove,
  type CostAlertKind,
  type CostAlertSettingsView,
  type CostAlertsView,
  type CostLineView,
  type CostingTargetsView,
  type FoodCostFlag,
  type ItemCostSheet,
  type MenuCostRow,
  type MenuCostsView,
  type MissingCosts,
  type MissingPriceRow,
  type RecipeCostPreview,
  type SetCostAlertSettingsRequest,
  type SetCostingTargetsRequest,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { loadPriceBook, type PriceBook } from '../db/price-book.js';
import { getBusinessSetting, setBusinessSetting, setBusinessSettings } from '../db/repositories/business-settings-repo.js';
import type { Actor } from '../db/repositories/base.js';
import { COUNTED } from './analytics/sql.js';

/** "Sold in the last 28 days": the window the customers' picks are weighted over. */
export const MIX_WINDOW_DAYS = 28;
/** How deep a sauce inside a sauce inside a dough is opened on the cost sheet. */
const MAX_BATCH_DEPTH = 4;

interface MenuItemRow {
  id: string;
  name: string;
  categoryId: string;
  basePriceCents: number;
  isActive: boolean;
}

interface MenuData {
  categories: Array<{ id: string; name: string }>;
  items: MenuItemRow[];
  recipes: Map<string, RecipeLine[]>;
  groups: Map<string, PlateGroup[]>;
}

interface Sales {
  units: number;
  salesCents: number;
  /** Per choice: units whose line had it (N_o). */
  picks: Map<string, number>;
  /** Per choice group: units whose line had any of its (live) choices (U_g). */
  groupUnits: Map<string, number>;
}

interface Ctx {
  book: PriceBook;
  menu: MenuData;
  sales: Map<string, Sales>;
  targets: ResolvedTargets;
  priceStepCents: number;
  savedAt: string | null;
  priceOf: PriceOf;
}

/**
 * Which sales a channel needs. The order history only ever grows, so every
 * query below walks the 28-day window by the orders' date index, and a
 * channel that needs no sales (the batch calculator, the targets) reads none.
 */
type SalesNeed =
  /** Units and sales of every item (Missing costs: no picks). */
  | { kind: 'totals' }
  /** Units, sales and picks of every item (Menu costs). */
  | { kind: 'all' }
  /** Units, sales and picks of one item (its cost sheet, the recipe editor's footer). */
  | { kind: 'item'; itemId: string };

// ------------------------------------------------------------------ loading --

function loadMenu(db: AppDatabase): MenuData {
  const categories = loadCategories(db);
  const items = (
    db
      .prepare(
        `SELECT id, name, category_id, base_price_cents, is_active FROM menu_items
          WHERE deleted_at IS NULL ORDER BY sort_order, name`,
      )
      .all() as Array<{ id: string; name: string; category_id: string; base_price_cents: number; is_active: number }>
  ).map((r) => ({
    id: r.id,
    name: r.name,
    categoryId: r.category_id,
    basePriceCents: r.base_price_cents,
    isActive: r.is_active === 1,
  }));

  // The lines that can still apply: a live ingredient (the stock SQL joins
  // it the same way), and a live choice when the line depends on one.
  const recipes = new Map<string, RecipeLine[]>();
  const lines = db
    .prepare(
      `SELECT r.menu_item_id, r.ingredient_id, r.qty_per_unit, r.modifier_id
         FROM recipes r
         JOIN ingredients i ON i.id = r.ingredient_id AND i.deleted_at IS NULL
         LEFT JOIN modifiers m ON m.id = r.modifier_id AND m.deleted_at IS NULL
        WHERE r.deleted_at IS NULL AND (r.modifier_id IS NULL OR m.id IS NOT NULL)
        ORDER BY r.menu_item_id, r.modifier_id IS NOT NULL, r.rowid`,
    )
    .all() as Array<{ menu_item_id: string; ingredient_id: string; qty_per_unit: number; modifier_id: string | null }>;
  for (const l of lines) {
    let list = recipes.get(l.menu_item_id);
    if (!list) recipes.set(l.menu_item_id, (list = []));
    list.push({ ingredientId: l.ingredient_id, qtyPerUnit: l.qty_per_unit, modifierId: l.modifier_id });
  }

  const options = new Map<string, PlateGroup['options']>();
  for (const m of db
    .prepare(
      `SELECT id, modifier_group_id, name, price_delta_cents, removes_ingredient_id FROM modifiers
        WHERE deleted_at IS NULL ORDER BY modifier_group_id, sort_order, name`,
    )
    .all() as Array<{ id: string; modifier_group_id: string; name: string; price_delta_cents: number; removes_ingredient_id: string | null }>) {
    let list = options.get(m.modifier_group_id);
    if (!list) options.set(m.modifier_group_id, (list = []));
    list.push({ id: m.id, name: m.name, priceDeltaCents: m.price_delta_cents, removesIngredientId: m.removes_ingredient_id });
  }
  const groups = new Map<string, PlateGroup[]>();
  for (const g of db
    .prepare(
      `SELECT x.menu_item_id, g.id, g.name, g.selection_type, g.min_select, g.max_select, g.is_required
         FROM menu_item_modifier_groups x
         JOIN modifier_groups g ON g.id = x.modifier_group_id AND g.deleted_at IS NULL
        WHERE x.deleted_at IS NULL
        ORDER BY x.menu_item_id, x.sort_order`,
    )
    .all() as Array<{
    menu_item_id: string;
    id: string;
    name: string;
    selection_type: 'single' | 'multi';
    min_select: number;
    max_select: number;
    is_required: number;
  }>) {
    let list = groups.get(g.menu_item_id);
    if (!list) groups.set(g.menu_item_id, (list = []));
    list.push({
      id: g.id,
      name: g.name,
      selectionType: g.selection_type,
      minSelect: g.min_select,
      maxSelect: g.max_select,
      isRequired: g.is_required === 1,
      options: options.get(g.id) ?? [],
    });
  }
  return { categories, items, recipes, groups };
}

/**
 * The counted order lines of the window, walked in this order on purpose:
 * orders by their date index (idx_orders_created), then each order's lines
 * (idx_order_items_order), then each line's choices (idx_oim_by_item).
 * CROSS JOIN keeps SQLite to that order: left to itself (no ANALYZE
 * statistics) it would read every choice ever rung up and look the orders up
 * afterwards, so the Costing page would slow down with every day of trading.
 */
const WINDOW_LINES = `orders o CROSS JOIN order_items oi`;
const IN_WINDOW = `o.created_at >= ? AND o.created_at <= ? AND ${COUNTED}
    AND oi.order_id = o.id AND oi.deleted_at IS NULL AND oi.menu_item_id IS NOT NULL`;

/**
 * Units, sales and (when asked) picks per menu item over the last 28 days of
 * counted orders on this till, up to `now` (the weekly digest looks back
 * from its own Monday): U = Σ qty; N_o = Σ qty over lines with o picked;
 * U_g = Σ qty over lines with any live choice of group g.
 */
function loadSales(db: AppDatabase, now: Date, need: SalesNeed): Map<string, Sales> {
  const since = new Date(now.getTime() - MIX_WINDOW_DAYS * 86_400_000).toISOString();
  const until = now.toISOString();
  const oneItem = need.kind === 'item' ? ' AND oi.menu_item_id = ?' : '';
  const params: unknown[] = need.kind === 'item' ? [since, until, need.itemId] : [since, until];
  const out = new Map<string, Sales>();
  for (const r of db
    .prepare(
      `SELECT oi.menu_item_id AS item, SUM(oi.quantity) AS units, SUM(oi.line_total_cents) AS sales
         FROM ${WINDOW_LINES}
        WHERE ${IN_WINDOW}${oneItem}
        GROUP BY oi.menu_item_id`,
    )
    .all(...params) as Array<{ item: string; units: number; sales: number }>) {
    out.set(r.item, { units: Number(r.units), salesCents: Number(r.sales), picks: new Map(), groupUnits: new Map() });
  }
  if (need.kind === 'totals' || out.size === 0) return out;
  // A choice counts once per order line (the till refuses the same choice twice on a line).
  for (const r of db
    .prepare(
      `SELECT oi.menu_item_id AS item, oim.modifier_id AS modifier, SUM(oi.quantity) AS n
         FROM ${WINDOW_LINES} CROSS JOIN order_item_modifiers oim
        WHERE ${IN_WINDOW}${oneItem}
          AND oim.order_item_id = oi.id AND oim.deleted_at IS NULL AND oim.modifier_id IS NOT NULL
        GROUP BY oi.menu_item_id, oim.modifier_id`,
    )
    .all(...params) as Array<{ item: string; modifier: string; n: number }>) {
    out.get(r.item)?.picks.set(r.modifier, Number(r.n));
  }
  // A line counts once per group however many of its choices it had (five veggies = one line).
  for (const r of db
    .prepare(
      `SELECT item, grp, SUM(qty) AS n FROM (
         SELECT DISTINCT oi.id AS line, oi.menu_item_id AS item, oi.quantity AS qty, m.modifier_group_id AS grp
           FROM ${WINDOW_LINES} CROSS JOIN order_item_modifiers oim CROSS JOIN modifiers m
          WHERE ${IN_WINDOW}${oneItem}
            AND oim.order_item_id = oi.id AND oim.deleted_at IS NULL
            AND m.id = oim.modifier_id AND m.deleted_at IS NULL)
        GROUP BY item, grp`,
    )
    .all(...params) as Array<{ item: string; grp: string; n: number }>) {
    out.get(r.item)?.groupUnits.set(r.grp, Number(r.n));
  }
  return out;
}

function loadCategories(db: AppDatabase): MenuData['categories'] {
  return db
    .prepare(`SELECT id, name FROM categories WHERE deleted_at IS NULL ORDER BY display_order, name`)
    .all() as Array<{ id: string; name: string }>;
}

/** The owner's targets and price step, resolved against the live categories. */
function loadTargets(db: AppDatabase, categories: MenuData['categories']) {
  const saved = getBusinessSetting(db, 'costing.targets');
  const step = getBusinessSetting(db, 'costing.priceStep');
  return {
    targets: resolveTargets(saved?.value ?? null, categories),
    priceStepCents: step?.value ?? DEFAULT_PRICE_STEP_CENTS,
    savedAt: saved?.updatedAt ?? null,
  };
}

function priceOfBook(book: PriceBook): PriceOf {
  return (id) => {
    const p = book.prices.get(id);
    return p ? { pack: p.pack, kind: p.kind } : undefined;
  };
}

function loadCtx(db: AppDatabase, now: Date, need: SalesNeed): Ctx {
  const book = loadPriceBook(db);
  const menu = loadMenu(db);
  return {
    book,
    menu,
    sales: loadSales(db, now, need),
    ...loadTargets(db, menu.categories),
    priceOf: priceOfBook(book),
  };
}

// --------------------------------------------------------------- the plate --

function targetOf(ctx: Ctx, categoryId: string): ResolvedTarget {
  return (
    ctx.targets.byCategory.get(categoryId) ?? {
      bps: ctx.targets.defaultBps,
      suggestedBps: ctx.targets.defaultBps,
      confirmed: false,
      nonFood: false,
    }
  );
}

function mixOf(ctx: Ctx, itemId: string): PickMix | null {
  const s = ctx.sales.get(itemId);
  return s ? { units: s.units, picks: s.picks, groupUnits: s.groupUnits } : null;
}

/** On the menu: on the till, or hidden but sold in the window (sold out today). A retired dish counts nowhere. */
function onMenu(ctx: Ctx, item: MenuItemRow): boolean {
  return item.isActive || (ctx.sales.get(item.id)?.units ?? 0) > 0;
}

function ingredientName(book: PriceBook, id: string): string {
  return book.ingredients.get(id)?.name ?? 'An ingredient that was deleted';
}

function plateOf(ctx: Ctx, item: MenuItemRow, recipe?: RecipeLine[]): PlateCost {
  return plateCost(
    {
      basePriceCents: item.basePriceCents,
      recipe: recipe ?? ctx.menu.recipes.get(item.id) ?? [],
      groups: ctx.menu.groups.get(item.id) ?? [],
      mix: mixOf(ctx, item.id),
    },
    ctx.priceOf,
  );
}

function flagOf(ctx: Ctx, item: MenuItemRow, pc: PlateCost): FoodCostFlag {
  const t = targetOf(ctx, item.categoryId);
  return foodCostFlag(
    { hasRecipe: pc.hasRecipe, missingLines: pc.missingLines, costMc: pc.typicalCostMc, priceMc: pc.typicalPriceMc },
    { ...t, amberBps: ctx.targets.amberBps },
  );
}

function rowOf(ctx: Ctx, item: MenuItemRow, pc: PlateCost): MenuCostRow {
  const t = targetOf(ctx, item.categoryId);
  return {
    menuItemId: item.id,
    name: item.name,
    categoryId: item.categoryId,
    categoryName: ctx.menu.categories.find((c) => c.id === item.categoryId)?.name ?? '',
    isActive: item.isActive,
    basePriceCents: item.basePriceCents,
    priceCents: pc.typicalPriceCents,
    costCents: pc.typicalCostCents,
    minCostCents: pc.minCostCents,
    maxCostCents: pc.maxCostCents,
    profitCents: pc.profitCents,
    foodCostBps: pc.foodCostBps,
    targetBps: t.bps,
    targetConfirmed: t.confirmed,
    flag: flagOf(ctx, item, pc),
    hasRecipe: pc.hasRecipe,
    missingLines: pc.missingLines,
    missingIngredients: pc.missingIngredientIds.map((id) => ingredientName(ctx.book, id)),
    estimateLines: pc.estimateLines,
    soldLast28: ctx.sales.get(item.id)?.units ?? 0,
  };
}

// -------------------------------------------------------------- batch calc --

/**
 * A batch worked out for an amount given in HUNDREDTHS of a base unit, so a
 * sauce inside a plate line (or inside another batch) is scaled exactly,
 * not from a rounded gram. Inputs made in-house open up the same way, a few
 * levels deep, never round a loop.
 */
function batchCalcOf(book: PriceBook, ingredientId: string, amountHundredths: number, depth: number, seen: ReadonlySet<string>): BatchCalc | null {
  const ing = book.ingredients.get(ingredientId);
  const lines = book.batchLines.get(ingredientId);
  if (!ing || !ing.batchYield || !lines || lines.length === 0 || amountHundredths < 1) return null;
  const inputs: ScaleInput[] = lines.map((l) => {
    const p = book.prices.get(l.inputId);
    return {
      inputId: l.inputId,
      qty: l.qty,
      pack: p && p.kind !== 'unset' ? p.pack : null,
      kind: p ? p.kind : 'missing',
    };
  });
  const scaled = scaleBatch(ing.batchYield * 100, inputs, amountHundredths);
  const nameOf = (id: string) => ingredientName(book, id);
  const inside = new Set([...seen, ingredientId]);
  const out: BatchCalcLine[] = scaled.lines.map((l) => {
    const input = book.ingredients.get(l.inputId);
    const madeInHouse = !!book.prices.get(l.inputId)?.batch;
    return {
      inputId: l.inputId,
      name: nameOf(l.inputId),
      unit: input?.unit ?? '',
      perBatchQty: l.perBatchQty,
      scaledHundredths: l.scaledHundredths,
      // An input deleted since (only possible through the other till) is not taken by "Make this amount".
      stockQty: input ? l.stockQty : 0,
      unitCostMc: l.unitCostMc,
      costMc: l.costMc,
      costCents: l.costCents,
      shareBps: l.shareBps,
      priceKind: l.kind,
      madeInHouse,
      madeOf:
        madeInHouse && depth < MAX_BATCH_DEPTH && !inside.has(l.inputId)
          ? batchCalcOf(book, l.inputId, l.scaledHundredths, depth + 1, inside)
          : null,
    };
  });
  return {
    ingredientId,
    name: ing.name,
    unit: ing.unit,
    batchYield: ing.batchYield,
    amount: mulDivRound(amountHundredths, 1, 100),
    lines: out,
    totalCostMc: scaled.totalCostMc,
    totalCostCents: scaled.totalCostCents,
    perUnitMc: mulDivRound(scaled.totalCostMc, 100, amountHundredths),
    complete: scaled.complete,
    unpricedInputs: scaled.unpricedInputIds.map(nameOf),
    estimateInputs: scaled.estimateInputIds.map(nameOf),
    roundedAway: scaled.roundedAwayIds.map(nameOf),
    inStock: ing.currentQty,
    maxAmount: maxBatchAmount(ing.batchYield),
  };
}

// ------------------------------------------------------------- line views --

/**
 * Lines as the cost sheet shows them. `ofMc` is what each share is a share
 * of: the typical plate for "Always in it" (so the bars say what drives the
 * plate's cost, choices included), or by default the lines' own total (one
 * choice, one paid extra).
 */
function lineViews(ctx: Ctx, lines: readonly CostedLine[], ofMc?: number): CostLineView[] {
  const total = ofMc ?? lines.reduce((s, l) => s + l.costMc, 0);
  return lines.map((l) => {
    const ing = ctx.book.ingredients.get(l.ingredientId);
    const p = ctx.book.prices.get(l.ingredientId);
    return {
      ingredientId: l.ingredientId,
      name: ingredientName(ctx.book, l.ingredientId),
      unit: ing?.unit ?? '',
      qty: l.qty,
      unitCostMc: p && l.kind !== 'missing' ? unitCostMc(p.pack) : null,
      costMc: l.costMc,
      costCents: mulDivRound(l.costMc, 1, 1000),
      shareBps: shareBps(l.costMc, total),
      priceKind: l.kind,
      madeOf: p?.batch ? batchCalcOf(ctx.book, l.ingredientId, l.qty * 100, 1, new Set()) : null,
    };
  });
}

// ------------------------------------------------------------------ public --

/** Every menu item on the Menu costs table, with the summary line and the Missing costs badge. */
export function getMenuCosts(db: AppDatabase, now = new Date()): MenuCostsView {
  const ctx = loadCtx(db, now, { kind: 'all' });
  const rows = ctx.menu.items.map((item) => rowOf(ctx, item, plateOf(ctx, item)));
  // The summary counts the dishes on the menu; a retired one stays in the table, tagged.
  const counted = new Set(ctx.menu.items.filter((i) => onMenu(ctx, i)).map((i) => i.id));
  const food = rows.filter((r) => r.flag !== 'nonfood' && counted.has(r.menuItemId));
  const missing = missingOf(ctx);
  return {
    rows,
    summary: {
      items: food.length,
      onTarget: food.filter((r) => r.flag === 'green').length,
      close: food.filter((r) => r.flag === 'amber').length,
      over: food.filter((r) => r.flag === 'red').length,
      cantCost: food.filter((r) => r.flag === 'grey').length,
      notConfirmed: food.filter((r) => r.flag === 'neutral').length,
    },
    amberBps: ctx.targets.amberBps,
    missingCount: missing.total,
  };
}

/** One item's cost sheet; null when there is no such item. */
export function getItemCostSheet(db: AppDatabase, menuItemId: string, now = new Date()): ItemCostSheet | null {
  const ctx = loadCtx(db, now, { kind: 'item', itemId: menuItemId });
  const item = ctx.menu.items.find((i) => i.id === menuItemId);
  if (!item) return null;
  const pc = plateOf(ctx, item);
  const t = targetOf(ctx, item.categoryId);
  const nameOf = (id: string) => ctx.book.ingredients.get(id)?.name ?? 'an ingredient that was deleted';
  return {
    row: rowOf(ctx, item, pc),
    always: lineViews(ctx, pc.base.lines, pc.typicalCostMc),
    alwaysCostCents: pc.base.costCents,
    groups: pc.groups.map((g) => ({
      groupId: g.group.id,
      name: g.group.name,
      kMin: g.kMin,
      kMax: g.kMax,
      basis: g.basis,
      options: g.options.map((oc) => ({
        modifierId: oc.option.id,
        name: oc.option.name,
        priceDeltaCents: oc.option.priceDeltaCents,
        costCents: oc.cost.costCents,
        missingLines: oc.cost.missingLines,
        estimateLines: oc.cost.estimateLines,
        pickedShareBps: oc.pickedShareBps,
        lines: lineViews(ctx, oc.cost.lines),
      })),
      typicalCostCents: mulDivRound(g.typicalCostMc, 1, 1000),
      cheapestCostCents: mulDivRound(g.cheapestMc, 1, 1000),
      dearestCostCents: mulDivRound(g.dearestMc, 1, 1000),
      typicalPriceCents: mulDivRound(g.typicalPriceMc, 1, 1000),
    })),
    paidExtras: pc.paidExtras.map((x) => ({
      modifierId: x.option.id,
      name: x.option.name,
      groupName: x.groupName,
      priceDeltaCents: x.option.priceDeltaCents,
      costCents: x.cost.costCents,
      marginCents: x.marginCents,
      foodCostBps: x.foodCostBps,
      flag: foodCostFlag(
        {
          hasRecipe: x.cost.lines.length > 0,
          missingLines: x.cost.missingLines,
          costMc: x.cost.costMc,
          priceMc: x.option.priceDeltaCents * 1000,
        },
        { ...t, amberBps: ctx.targets.amberBps },
      ),
      missingLines: x.cost.missingLines,
      lines: lineViews(ctx, x.cost.lines),
    })),
    leaveOuts: pc.leaveOuts.map((l) => ({
      modifierId: l.option.id,
      name: l.option.name,
      ingredientName: nameOf(l.ingredientId),
      savingCents: l.savingCents,
      missingLines: l.missingLines,
    })),
  };
}

/** The recipe editor's footer: the lines as typed (not saved), costed against the item. */
export function previewRecipeCost(
  db: AppDatabase,
  menuItemId: string,
  lines: ReadonlyArray<{ ingredientId: string; qtyPerUnit: number; modifierId?: string | null }>,
  now = new Date(),
): RecipeCostPreview {
  const ctx = loadCtx(db, now, { kind: 'item', itemId: menuItemId });
  const item = ctx.menu.items.find((i) => i.id === menuItemId);
  if (!item) throw new Error('Menu item not found');
  const recipe: RecipeLine[] = lines
    .filter((l) => l.ingredientId && l.qtyPerUnit > 0)
    .map((l) => ({ ingredientId: l.ingredientId, qtyPerUnit: l.qtyPerUnit, modifierId: l.modifierId ?? null }));
  const pc = plateOf(ctx, item, recipe);
  const t = targetOf(ctx, item.categoryId);
  return {
    hasRecipe: pc.hasRecipe,
    costCents: pc.typicalCostCents,
    priceCents: pc.typicalPriceCents,
    foodCostBps: pc.foodCostBps,
    missingLines: pc.missingLines,
    missingIngredients: pc.missingIngredientIds.map((id) => ingredientName(ctx.book, id)),
    estimateLines: pc.estimateLines,
    targetBps: t.bps,
    targetConfirmed: t.confirmed,
    flag: flagOf(ctx, item, pc),
  };
}

function missingOf(ctx: Ctx): MissingCosts {
  const nonFood = new Set([...ctx.targets.byCategory].filter(([, t]) => t.nonFood).map(([id]) => id));
  const lists = findMissingCosts({
    ingredients: [...ctx.book.ingredients.values()],
    prices: ctx.book.prices,
    batchLines: ctx.book.batchLines,
    items: ctx.menu.items.map((i) => ({
      id: i.id,
      name: i.name,
      categoryId: i.categoryId,
      ingredientIds: (ctx.menu.recipes.get(i.id) ?? []).map((l) => l.ingredientId),
      salesCents: ctx.sales.get(i.id)?.salesCents ?? 0,
      onMenu: onMenu(ctx, i),
    })),
    nonFoodCategoryIds: nonFood,
  });
  const itemName = new Map(ctx.menu.items.map((i) => [i.id, i.name]));
  const ingName = (id: string) => ingredientName(ctx.book, id);
  const priceRow = (r: { ingredientId: string; itemIds: string[]; salesShareBps: number | null }): MissingPriceRow => {
    const ing = ctx.book.ingredients.get(r.ingredientId);
    return {
      ingredientId: r.ingredientId,
      name: ingName(r.ingredientId),
      unit: ing?.unit ?? '',
      items: r.itemIds.map((id) => itemName.get(id) ?? '').filter(Boolean).sort((a, b) => a.localeCompare(b)),
      salesShareBps: r.salesShareBps,
      costPerUnitCents: ing?.costPerUnitCents ?? 0,
    };
  };
  const catName = new Map(ctx.menu.categories.map((c) => [c.id, c.name]));
  const byId = new Map(ctx.menu.items.map((i) => [i.id, i]));
  const out: MissingCosts = {
    unpriced: lists.unpriced.map(priceRow),
    noRecipe: lists.noRecipe.map((id) => {
      const i = byId.get(id)!;
      return { menuItemId: id, name: i.name, categoryName: catName.get(i.categoryId) ?? '', soldLast28: ctx.sales.get(id)?.units ?? 0 };
    }),
    guessed: lists.guessed.map(priceRow),
    roundedPerGram: lists.roundedPerGram.map(priceRow),
    batches: lists.batches.map((b) => ({
      ingredientId: b.ingredientId,
      name: ingName(b.ingredientId),
      unpricedInputs: b.unpricedInputIds.map((id) => ({ ingredientId: id, name: ingName(id), gone: !ctx.book.ingredients.has(id) })),
      loop: b.loop,
    })),
    total: 0,
  };
  out.total = out.unpriced.length + out.noRecipe.length + out.guessed.length + out.roundedPerGram.length + out.batches.length;
  return out;
}

export function getMissingCosts(db: AppDatabase, now = new Date()): MissingCosts {
  return missingOf(loadCtx(db, now, { kind: 'totals' }));
}

/** The targets need no prices, recipes or sales: categories, how many items each has, and the settings. */
function loadTargetsCtx(db: AppDatabase) {
  const categories = loadCategories(db);
  const itemCount = new Map(
    (
      db
        .prepare(`SELECT category_id AS id, COUNT(*) AS n FROM menu_items WHERE deleted_at IS NULL GROUP BY category_id`)
        .all() as Array<{ id: string; n: number }>
    ).map((r) => [r.id, Number(r.n)]),
  );
  return { categories, itemCount, ...loadTargets(db, categories) };
}

function targetsViewOf(ctx: ReturnType<typeof loadTargetsCtx>): CostingTargetsView {
  const categories = ctx.categories.map((c) => {
    const t = ctx.targets.byCategory.get(c.id) ?? {
      bps: ctx.targets.defaultBps,
      suggestedBps: ctx.targets.defaultBps,
      confirmed: false,
      nonFood: false,
    };
    return {
      categoryId: c.id,
      name: c.name,
      bps: t.bps,
      suggestedBps: t.suggestedBps,
      confirmed: t.confirmed,
      nonFood: t.nonFood,
      itemCount: ctx.itemCount.get(c.id) ?? 0,
    };
  });
  return {
    defaultBps: ctx.targets.defaultBps,
    amberBps: ctx.targets.amberBps,
    priceStepCents: ctx.priceStepCents,
    categories,
    anyUnconfirmed: categories.some((c) => !c.nonFood && !c.confirmed),
    savedAt: ctx.savedAt,
  };
}

export function getCostingTargets(db: AppDatabase): CostingTargetsView {
  return targetsViewOf(loadTargetsCtx(db));
}

/**
 * Save the owner's targets and price step, both keys in one transaction
 * (business-settings-repo). Targets for categories that no longer exist are
 * dropped. Answers with the targets as they now stand.
 */
export function saveCostingTargets(db: AppDatabase, req: SetCostingTargetsRequest, actor: Actor): CostingTargetsView {
  const live = new Set(
    (db.prepare(`SELECT id FROM categories WHERE deleted_at IS NULL`).all() as Array<{ id: string }>).map((c) => c.id),
  );
  const perCategory = Object.fromEntries(Object.entries(req.perCategory).filter(([id]) => live.has(id)));
  setBusinessSettings(
    db,
    [
      {
        key: 'costing.targets',
        value: {
          defaultBps: req.defaultBps,
          amberBps: req.amberBps,
          perCategory,
          nonFoodCategoryIds: req.nonFoodCategoryIds.filter((id) => live.has(id)),
        },
      },
      { key: 'costing.priceStep', value: req.priceStepCents },
    ],
    actor,
  );
  return getCostingTargets(db);
}

/** "Use these": every category's suggested (or current) target, confirmed. */
export function confirmedSuggestions(db: AppDatabase): SetCostingTargetsRequest {
  const t = loadTargets(db, loadCategories(db));
  return { ...confirmAll(t.targets), priceStepCents: t.priceStepCents };
}

/** The batch calculator: one batch recipe worked out for `amount` base units, every input costed. */
export function getBatchCalc(db: AppDatabase, ingredientId: string, amount: number): BatchCalc {
  // Prices only: no menu, no sales (it runs once per amount typed).
  const book = loadPriceBook(db);
  const ing = book.ingredients.get(ingredientId);
  if (!ing) throw new Error('Ingredient not found');
  if (!ing.batchYield || (book.batchLines.get(ingredientId)?.length ?? 0) === 0) {
    throw new Error('This ingredient has no batch recipe');
  }
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Enter how much, at least 1');
  return batchCalcOf(book, ingredientId, amount * 100, 0, new Set())!;
}

// ------------------------------------------------ price alerts (Phase 6) --
//
// The figures behind Costing → Alerts: which dishes a price change moves and
// what that comes to per week at this till's sales (4.9: a week is a
// quarter of the last 28 days' units). The rules and the writes are
// cost-alert-repo's; these are read-only.

/** Everything the alerts work a plate out from: prices, the menu, the last 28 days' sales and the targets. */
export type CostingContext = Ctx;
export type CostingMenuItem = MenuItemRow;

/** The costing figures' inputs now (every item's sales and picks over the last 28 days). */
export function loadCostingContext(db: AppDatabase, now = new Date()): CostingContext {
  return loadCtx(db, now, { kind: 'all' });
}

/** The menu items the figures count: on the till, or hidden but sold in the window. */
export function itemsOnMenu(ctx: CostingContext): MenuItemRow[] {
  return ctx.menu.items.filter((i) => onMenu(ctx, i));
}

/** An item's category target (the suggestion while none is saved). */
export function targetFor(ctx: CostingContext, categoryId: string): ResolvedTarget {
  return targetOf(ctx, categoryId);
}

/** An item's plate at other prices, and (the weekly digest) with the customers' picks as they were. */
export function plateAt(ctx: CostingContext, item: MenuItemRow, priceOf: PriceOf, mix: PickMix | null | undefined = mixOf(ctx, item.id)): PlateCost {
  return plateCost(
    {
      basePriceCents: item.basePriceCents,
      recipe: ctx.menu.recipes.get(item.id) ?? [],
      groups: ctx.menu.groups.get(item.id) ?? [],
      mix,
    },
    priceOf,
  );
}

/** The customers' picks of an item over the window (null when it did not sell). */
export function pickMixOf(ctx: CostingContext, itemId: string): PickMix | null {
  return mixOf(ctx, itemId);
}

/** Units of an item sold in the window, on this till. */
export function soldLast28(ctx: CostingContext, itemId: string): number {
  return ctx.sales.get(itemId)?.units ?? 0;
}

/** At most this many dishes are kept with a price alert (the most per week first). */
export const MOVES_KEPT = 25;

/**
 * The dishes on the menu a price change moves: every food item whose recipe
 * (or one of its choices) uses an ingredient in `touched` (the one whose
 * price changed, and the batches made from it), costed at the prices before
 * and after, at the customers' usual picks. Most per week first (then by
 * name).
 */
export function dishesMovedBy(
  ctx: CostingContext,
  before: PriceOf,
  after: PriceOf,
  touched: ReadonlySet<string>,
): CostAlertItemMove[] {
  const moves: CostAlertItemMove[] = [];
  for (const item of itemsOnMenu(ctx)) {
    const recipe = ctx.menu.recipes.get(item.id) ?? [];
    if (!recipe.some((l) => touched.has(l.ingredientId))) continue;
    if (targetOf(ctx, item.categoryId).nonFood) continue;
    const pb = plateAt(ctx, item, before);
    const pa = plateAt(ctx, item, after);
    if (pb.typicalCostMc === pa.typicalCostMc) continue;
    const units = soldLast28(ctx, item.id);
    moves.push({
      menuItemId: item.id,
      name: item.name,
      priceCents: pa.typicalPriceCents,
      costBeforeCents: pb.typicalCostCents,
      costAfterCents: pa.typicalCostCents,
      foodCostBeforeBps: pb.foodCostBps,
      foodCostAfterBps: pa.foodCostBps,
      soldLast28: units,
      impactWeekCents: weeklyImpactCents(units, pb.typicalCostMc, pa.typicalCostMc),
    });
  }
  return moves.sort((a, b) => Math.abs(b.impactWeekCents) - Math.abs(a.impactWeekCents) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------- the alert list --

interface CostAlertRow {
  id: string;
  kind: string;
  impact_week_cents: number;
  after_json: string | null;
  seen_at: string | null;
  seen_name: string | null;
  created_at: string;
}

/** The most alerts the list reads (newest first; not seen yet always first). */
const ALERTS_LISTED = 200;

function isAlertKind(k: string): k is CostAlertKind {
  return (COST_ALERT_KINDS as readonly string[]).includes(k);
}

/**
 * An alert's figures as written (after_json), or null when they can't be
 * read (a newer till's shape). The digest's saved bands and picks (`state`,
 * what the next digest compares with) are the till's, not the screen's.
 */
export function readAlertDetail(kind: string, afterJson: string | null): CostAlertDetail | null {
  if (!afterJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(afterJson);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || (raw as { kind?: unknown }).kind !== kind) return null;
  const r = raw as Record<string, unknown>;
  switch (kind) {
    case 'price_jump':
      return typeof r['ingredientName'] === 'string' && Array.isArray(r['items']) ? (r as unknown as CostAlertDetail) : null;
    case 'batch_unpriced_input':
      return typeof r['ingredientName'] === 'string' && Array.isArray(r['unpricedInputs']) ? (r as unknown as CostAlertDetail) : null;
    case 'weekly_digest': {
      if (typeof r['weekOf'] !== 'string' || !Array.isArray(r['changes'])) return null;
      const shown: Record<string, unknown> = { ...r };
      delete shown['state'];
      return shown as unknown as CostAlertDetail;
    }
    default:
      return null;
  }
}

/** A weekly digest that found nothing moved: kept (the next one compares with it), never listed. */
function isQuietDigest(kind: string, detail: CostAlertDetail | null): boolean {
  return kind === 'weekly_digest' && detail?.kind === 'weekly_digest' && detail.changes.length === 0;
}

/**
 * Costing → Alerts: not seen yet first, then the ones seen, newest first
 * within each. A digest with nothing to say is not listed. Exposed for the
 * Dashboard's "Do this" list too (each alert carries what it costs per
 * week, costing spec 4.17).
 */
export function getCostAlerts(db: AppDatabase, limit = ALERTS_LISTED): CostAlertsView {
  const rows = db
    .prepare(
      `SELECT a.id, a.kind, a.impact_week_cents, a.after_json, a.seen_at, a.created_at, u.full_name AS seen_name
         FROM cost_alerts a
         LEFT JOIN users u ON u.id = a.seen_by_user_id
        WHERE a.deleted_at IS NULL
        ORDER BY a.seen_at IS NOT NULL, a.created_at DESC, a.id
        LIMIT ?`,
    )
    .all(Math.max(1, Math.min(1_000, Math.floor(limit)))) as unknown as CostAlertRow[];
  const alerts: CostAlert[] = [];
  for (const r of rows) {
    if (!isAlertKind(r.kind)) continue;
    const detail = readAlertDetail(r.kind, r.after_json);
    if (isQuietDigest(r.kind, detail)) continue;
    alerts.push({
      id: r.id,
      kind: r.kind,
      createdAt: r.created_at,
      seenAt: r.seen_at,
      seenByName: r.seen_name,
      impactWeekCents: Number(r.impact_week_cents),
      detail,
    });
  }
  return { alerts, unseen: alerts.filter((a) => a.seenAt === null).length };
}

// ------------------------------------------------------ the alert settings --

function liveIngredientNames(db: AppDatabase): Array<{ id: string; name: string }> {
  return db.prepare(`SELECT id, name FROM ingredients WHERE deleted_at IS NULL ORDER BY name`).all() as Array<{ id: string; name: string }>;
}

/** The thresholds in force now (the saved ones, or the defaults with the key ingredients suggested by name). */
export function loadAlertSettings(db: AppDatabase, ingredients?: Iterable<{ id: string; name: string }>): ResolvedAlertSettings {
  const saved = getBusinessSetting(db, 'costing.alerts');
  return resolveAlertSettings(saved?.value ?? null, ingredients ?? liveIngredientNames(db));
}

export function getCostAlertSettings(db: AppDatabase): CostAlertSettingsView {
  const ingredients = liveIngredientNames(db);
  const saved = getBusinessSetting(db, 'costing.alerts');
  const s = resolveAlertSettings(saved?.value ?? null, ingredients);
  return {
    jumpBps: s.jumpBps,
    impactWeekCents: s.impactWeekCents,
    ingredients: ingredients.map((i) => ({
      ingredientId: i.id,
      name: i.name,
      key: s.keyIds.has(i.id),
      suggested: suggestedKeyIngredient(i.name),
    })),
    keysSuggested: s.keysSuggested,
    savedAt: saved?.updatedAt ?? null,
  };
}

/**
 * Save the owner's alert thresholds (business-settings-repo: synced,
 * audited). Key ingredients that are no longer there are dropped. Answers
 * with the settings as they now stand.
 */
export function saveCostAlertSettings(db: AppDatabase, req: SetCostAlertSettingsRequest, actor: Actor): CostAlertSettingsView {
  const live = new Set(liveIngredientNames(db).map((i) => i.id));
  setBusinessSetting(
    db,
    'costing.alerts',
    {
      jumpBps: req.jumpBps,
      impactWeekCents: req.impactWeekCents,
      keyIngredientIds: [...new Set(req.keyIngredientIds)].filter((id) => live.has(id)),
    },
    actor,
  );
  return getCostAlertSettings(db);
}
