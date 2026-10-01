/**
 * The recipe calculator (owner, 2026-09-27: "make it more easy if a manager
 * wants to see how much ingredients a recipe needs for making anything like
 * pizzas, burgers, sauce, dips"), read-only.
 *
 * Worked out here from the live menu, recipes, batch recipes and this till's
 * stock by the pure functions in pos-domain (itemFirstLevel → expandRecipe,
 * explodeNeeds / batchTree → scaleBatch, the rounding makeBatch takes by).
 * A batch already made on this till's shelf is used before making more (a
 * batch asked for by name is made in full), so "make first", the SHORT
 * marks and the packs to buy are for what is really left to make.
 * Nothing is written: stock only ever changes through "Make" (makeBatch).
 *
 * Two answers:
 *  - workOutRecipeCalc / getRecipeCalc: quantities only (inventory:
 *    channels, menu.manage). The loader reads no price column and the
 *    answer has no rupee in it, so the calculator keeps working if costs
 *    are ever hidden from managers;
 *  - getCostedRecipeCalc: the same plus what it costs (costing:recipeCalc,
 *    COST_CAPABILITY only) — each first-level line at today's price, a
 *    batch at its price rolled up from its inputs, as the Costing page
 *    costs a plate. ONE total: never the raw ingredients added up again.
 *
 * Money in paisa, unit costs in millicents, every figure rounded once.
 */
import {
  addQtyLines,
  batchTree,
  batchesText,
  choiceWithoutLinesText,
  costLines,
  explodeNeeds,
  goesFor,
  isRealPack,
  itemFirstLevel,
  lineCostMc,
  makeBatchLookup,
  maxBatchAmount,
  mcToCents,
  portionProblem,
  portionProblemText,
  prepListDocument,
  ratioRound,
  shortOf,
  thousandSize,
  type BatchLookup,
  type BatchTreeNode,
  type PlateGroup,
  type QtyLine,
} from '@cheeseoclock/pos-domain';
import {
  choiceGroupKind,
  groupDisplayName,
  orderChoiceGroups,
  paperClock,
  type PlainDocument,
  type RecipeCalc,
  type RecipeCalcCosts,
  type RecipeCalcLineView,
  type RecipeCalcQtyRow,
  type RecipeCalcRequest,
  type RecipeCalcTree,
  type TypicalPicksView,
  type CostedRecipeCalc,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { loadPriceBook, priceOfBook } from '../db/price-book.js';
import { loadItemPickMix, loadMenu, type MenuData } from './costing-service.js';

/** An ingredient as the calculator reads it: its stock and its units, no price. */
interface StockIngredient {
  id: string;
  name: string;
  unit: string;
  /** This till's own count. */
  currentQty: number;
  /** The pack it is bought in (a size; kept beside the price). */
  packSize: number | null;
  batchYield: number | null;
}

/** Everything the calculator reads: quantities only. */
export interface RecipeBook {
  ingredients: Map<string, StockIngredient>;
  batchOf: BatchLookup;
  menu: MenuData;
}

const DELETED = 'An ingredient that was deleted';

/**
 * The live ingredients (stock, units, pack size, yield — no price column),
 * every batch recipe's LIVE inputs in the recipe's order (the join and order
 * makeBatch's batchInputs reads, so what is shown is what "Make" takes), and
 * the menu with its live recipe lines and choices (costing-service loadMenu).
 */
export function loadRecipeBook(db: AppDatabase): RecipeBook {
  const rows = db
    .prepare(`SELECT id, name, unit, current_qty, pack_size, batch_yield FROM ingredients WHERE deleted_at IS NULL`)
    .all() as Array<{ id: string; name: string; unit: string; current_qty: number; pack_size: number | null; batch_yield: number | null }>;
  const ingredients = new Map<string, StockIngredient>(
    rows.map((r) => [
      r.id,
      { id: r.id, name: r.name, unit: r.unit, currentQty: Number(r.current_qty), packSize: r.pack_size, batchYield: r.batch_yield },
    ]),
  );
  const inputs = new Map<string, Array<{ inputId: string; qty: number }>>();
  for (const l of db
    .prepare(
      `SELECT l.ingredient_id, l.input_ingredient_id, l.qty
         FROM batch_recipe_lines l
         JOIN ingredients i ON i.id = l.input_ingredient_id AND i.deleted_at IS NULL
        WHERE l.deleted_at IS NULL
        ORDER BY l.ingredient_id, l.sort_order, i.name`,
    )
    .all() as Array<{ ingredient_id: string; input_ingredient_id: string; qty: number }>) {
    if (!ingredients.has(l.ingredient_id)) continue;
    let list = inputs.get(l.ingredient_id);
    if (!list) inputs.set(l.ingredient_id, (list = []));
    list.push({ inputId: l.input_ingredient_id, qty: Number(l.qty) });
  }
  const yields = new Map([...ingredients.values()].map((i) => [i.id, i.batchYield]));
  return { ingredients, batchOf: makeBatchLookup(yields, inputs), menu: loadMenu(db) };
}

/** A recipe calculation, and what each line uses first level (what the costs are worked from). */
interface Worked {
  calc: RecipeCalc;
  firstLevel: QtyLine[][];
}

/**
 * An amount of an ingredient with this till's stock beside it. Packs only
 * for what is bought in: a batch is made here, so a pack size kept beside
 * its old price (a sauce once priced "per tub") never reads "buy 1 pack".
 */
function rowOf(book: RecipeBook, ingredientId: string, qty: number): RecipeCalcQtyRow {
  const ing = book.ingredients.get(ingredientId);
  const inStock = ing?.currentQty ?? 0;
  const unit = ing?.unit ?? '';
  return {
    ingredientId,
    name: ing?.name ?? DELETED,
    unit,
    qty,
    inStock,
    shortBy: shortOf(qty, inStock),
    packSize: ing && !book.batchOf(ingredientId) && isRealPack(unit, ing.packSize) ? ing.packSize : null,
  };
}

function treeView(book: RecipeBook, node: BatchTreeNode): RecipeCalcTree {
  const ing = book.ingredients.get(node.id);
  return {
    ingredientId: node.id,
    name: ing?.name ?? DELETED,
    unit: ing?.unit ?? '',
    amount: node.amount,
    batchYield: node.batchYield,
    batchesText: batchesText(node.amount, node.batchYield),
    lines: node.lines.map((l) => ({
      ...rowOf(book, l.inputId, l.qty),
      perBatchQty: l.perBatchQty,
      exactHundredths: l.hundredths,
      madeOf: l.madeOf ? treeView(book, l.madeOf) : null,
      loop: l.loop,
    })),
  };
}

const toPortionGroup = (g: PlateGroup) => ({
  id: g.id,
  selectionType: g.selectionType,
  minSelect: g.minSelect,
  maxSelect: g.maxSelect,
  isRequired: g.isRequired,
  options: g.options,
});

/**
 * Work the request out. Throws, in plain words, for something it cannot
 * work out (an item no longer on the menu, a choice that is not the item's,
 * a leave-out, more of one choice than the count, a batch with no recipe).
 */
export function workOutRecipeCalc(db: AppDatabase, req: RecipeCalcRequest, book: RecipeBook = loadRecipeBook(db)): Worked {
  const nameOf = (id: string) => book.ingredients.get(id)?.name ?? DELETED;
  const lines: RecipeCalcLineView[] = [];
  const firstLevel: QtyLine[][] = [];
  const usesOf = (fl: QtyLine[]): RecipeCalcLineView['uses'] =>
    fl.map((l) => ({
      ingredientId: l.ingredientId,
      name: nameOf(l.ingredientId),
      unit: book.ingredients.get(l.ingredientId)?.unit ?? '',
      qty: l.qty,
      madeInHouse: !!book.batchOf(l.ingredientId),
    }));

  /** Batches asked for by name, and how much: made in full, whatever is on the shelf. */
  const askedBatches = new Map<string, number>();

  for (const l of req.lines) {
    if (l.kind === 'batch') {
      const ing = book.ingredients.get(l.ingredientId);
      if (!ing) throw new Error('That batch recipe no longer exists');
      const b = book.batchOf(ing.id);
      if (!b) throw new Error(`${ing.name} has no batch recipe: add what goes in it in Inventory → Recipes → Batch recipes`);
      const fl = [{ ingredientId: ing.id, qty: l.amount }];
      firstLevel.push(fl);
      askedBatches.set(ing.id, (askedBatches.get(ing.id) ?? 0) + l.amount);
      lines.push({
        kind: 'batch',
        id: ing.id,
        name: ing.name,
        count: l.amount,
        unit: ing.unit,
        batchesText: batchesText(l.amount, b.batchYield),
        picks: [],
        warnings: [],
        hasRecipe: true,
        uses: usesOf(fl),
      });
      continue;
    }

    const item = book.menu.items.find((i) => i.id === l.menuItemId);
    if (!item) throw new Error('That menu item is no longer on the menu');
    const recipe = book.menu.recipes.get(item.id) ?? [];
    const groups = book.menu.groups.get(item.id) ?? [];
    const optionOf = new Map<string, { group: PlateGroup; name: string; leaveOut: boolean }>();
    for (const g of groups) for (const o of g.options) optionOf.set(o.id, { group: g, name: o.name, leaveOut: o.removesIngredientId !== null });
    const counts = new Map<string, number>();
    for (const p of l.portions) {
      const hit = optionOf.get(p.modifierId);
      if (!hit) throw new Error(`A choice asked for is not one of ${item.name}'s (the menu may have changed): pick the choices again`);
      if (counts.has(p.modifierId)) throw new Error(`"${hit.name}" is counted twice`);
      if (hit.leaveOut && p.count > 0) throw new Error(`"${hit.name}" is a leave-out: it only uses less, so the calculator does not count it`);
      if (p.count > l.count) throw new Error(`"${hit.name}": at most ${l.count.toLocaleString('en-PK')} (one on each)`);
      counts.set(p.modifierId, p.count);
    }
    const portions = [...counts].filter(([, n]) => n > 0).map(([modifierId, count]) => ({ modifierId, count }));
    const fl = itemFirstLevel(recipe, portions, l.count);
    firstLevel.push(fl);

    const warnings: string[] = [];
    if (recipe.length === 0) warnings.push(`${item.name} has no recipe yet: add one in Inventory → Recipes to see what it uses.`);
    const withLines = new Set(recipe.map((r) => r.modifierId).filter((m): m is string => m !== null));
    for (const g of groups) {
      const p = portionProblem(toPortionGroup(g), (id) => counts.get(id) ?? 0, l.count);
      if (p) warnings.push(portionProblemText(groupDisplayName(g.name, g), p, l.count));
      // A counted choice with no lines of its own, beside ones that have them (a deal
      // pizza added but never given its copy of the pizza's lines): it adds nothing.
      if (!g.options.some((o) => withLines.has(o.id))) continue;
      for (const o of g.options) {
        const c = counts.get(o.id) ?? 0;
        if (c > 0 && !withLines.has(o.id)) warnings.push(choiceWithoutLinesText(o.name, c));
      }
    }
    lines.push({
      kind: 'item',
      id: item.id,
      name: item.name,
      count: l.count,
      unit: null,
      batchesText: null,
      picks: groups.flatMap((g) =>
        g.options
          .filter((o) => (counts.get(o.id) ?? 0) > 0)
          .map((o) => ({ modifierId: o.id, name: o.name, groupName: groupDisplayName(g.name, g), count: counts.get(o.id)! })),
      ),
      warnings,
      hasRecipe: recipe.length > 0,
      uses: usesOf(fl),
    });
  }

  const all = addQtyLines(...firstLevel);
  // What is already made on this till's shelf is used first: only the rest is made.
  const e = explodeNeeds(all, book.batchOf, { stockOf: (id) => book.ingredients.get(id)?.currentQty ?? 0, asked: askedBatches });
  const calc: RecipeCalc = {
    lines,
    batches: e.batches.map((b) => {
      const cb = book.batchOf(b.id)!;
      const max = maxBatchAmount(cb.batchYield);
      const tree = b.toMake > 0 ? batchTree(b.id, b.toMake, book.batchOf, { droppedEdges: e.droppedEdges }) : null;
      return {
        ...rowOf(book, b.id, b.need),
        // What the recipes need that the shelf does not have (what was asked for by name is made, not short).
        shortBy: b.toMake - b.asked,
        batchYield: cb.batchYield,
        direct: b.direct,
        asked: b.asked,
        fromShelf: b.fromShelf,
        toMake: b.toMake,
        batchesText: b.toMake > 0 ? batchesText(b.toMake, cb.batchYield) : null,
        maxAmount: max,
        goes: goesFor(b.toMake, max),
        tree: tree ? treeView(book, tree) : null,
      };
    }),
    fromStock: all.filter((l) => l.qty > 0 && !book.batchOf(l.ingredientId)).map((l) => rowOf(book, l.ingredientId, l.qty)),
    fromScratch: e.raw.map((l) => rowOf(book, l.ingredientId, l.qty)),
    warnings: e.loops.map(
      (x) =>
        `${nameOf(x.batchId)} uses ${nameOf(x.inputId)}, which is made with ${nameOf(x.batchId)}: fix it in Inventory → Recipes → Batch recipes. Counted here as taken from stock.`,
    ),
  };
  return { calc, firstLevel };
}

/** inventory:recipeCalc — quantities only. */
export function getRecipeCalc(db: AppDatabase, req: RecipeCalcRequest): RecipeCalc {
  return workOutRecipeCalc(db, req).calc;
}

/**
 * costing:recipeCalc — the same, and what it costs at today's prices. Only
 * ever called behind COST_CAPABILITY.
 */
export function getCostedRecipeCalc(db: AppDatabase, req: RecipeCalcRequest): CostedRecipeCalc {
  const w = workOutRecipeCalc(db, req);
  return { ...w.calc, costs: costRecipeCalc(db, w) };
}

function costRecipeCalc(db: AppDatabase, w: Worked): RecipeCalcCosts {
  const book = loadPriceBook(db);
  const priceOf = priceOfBook(book);
  const nameOf = (id: string) => book.ingredients.get(id)?.name ?? DELETED;
  const unpriced = new Set<string>();
  const estimates = new Set<string>();
  let totalMc = 0;
  const perLine = w.firstLevel.map((fl, i) => {
    const pc = costLines(fl, priceOf);
    totalMc += pc.costMc;
    const missing = [...new Set(pc.lines.filter((l) => l.kind === 'missing').map((l) => nameOf(l.ingredientId)))];
    for (const n of missing) unpriced.add(n);
    for (const l of pc.lines) if (l.kind === 'estimate') estimates.add(nameOf(l.ingredientId));
    const line = w.calc.lines[i]!;
    let eachCents: number | null = null;
    if (line.kind === 'item') eachCents = ratioRound([pc.costMc], [line.count, 1000]);
    else if (line.count > 0) {
      // A batch: per kg / litre when weighed (a unit's price in mc is the thousand's in paisa), else per unit.
      eachCents = thousandSize(line.unit ?? '') === 1000 ? ratioRound([pc.costMc], [line.count]) : ratioRound([pc.costMc], [line.count, 1000]);
    }
    return { costCents: pc.costCents, eachCents, complete: pc.missingLines === 0, unpriced: missing };
  });
  // A batch row at what the recipes use of it themselves: what goes into another
  // batch is already in that batch's rolled-up price, so the column adds up to the total.
  const perRow: RecipeCalcCosts['perRow'] = {};
  for (const r of [...w.calc.batches.map((b) => ({ ingredientId: b.ingredientId, qty: b.direct })), ...w.calc.fromStock]) {
    if (!(r.qty > 0)) continue;
    const p = priceOf(r.ingredientId);
    const priced = !!p && p.kind !== 'unset';
    perRow[r.ingredientId] = { costCents: priced ? mcToCents(lineCostMc(r.qty, p.pack)) : 0, complete: priced };
  }
  return {
    totalCostCents: mcToCents(totalMc),
    complete: unpriced.size === 0,
    unpriced: [...unpriced],
    estimates: [...estimates],
    perLine,
    perRow,
  };
}

/**
 * A menu item's choice groups in the order the till asks them, and the
 * last 28 days' picks on this till: counts of sales only, never money.
 */
export function getTypicalPicks(db: AppDatabase, menuItemId: string, now = new Date()): TypicalPicksView {
  const menu = loadMenu(db);
  const item = menu.items.find((i) => i.id === menuItemId);
  if (!item) throw new Error('That menu item is no longer on the menu');
  const withLines = new Set((menu.recipes.get(item.id) ?? []).map((r) => r.modifierId).filter((m): m is string => m !== null));
  const groups = orderChoiceGroups(
    (menu.groups.get(item.id) ?? []).map((g) => ({
      ...g,
      modifiers: g.options.map((o) => ({ name: o.name, removesIngredientId: o.removesIngredientId })),
    })),
  );
  const mix = loadItemPickMix(db, item.id, now);
  return {
    menuItemId: item.id,
    name: item.name,
    groups: groups.map((g) => ({
      groupId: g.id,
      name: groupDisplayName(g.name, g),
      kind: choiceGroupKind(g),
      selectionType: g.selectionType,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      isRequired: g.isRequired,
      options: g.options.map((o) => ({
        modifierId: o.id,
        name: o.name,
        leaveOut: o.removesIngredientId !== null,
        hasLines: withLines.has(o.id),
      })),
    })),
    mix: {
      units: mix.units,
      picks: Object.fromEntries(mix.picks),
      groupUnits: Object.fromEntries(mix.groupUnits ?? []),
    },
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "27 Sep 2026, 14:05", Pakistan time (UTC+5) like every paper, whatever the PC's zone. */
function whenText(d: Date): string {
  const pk = new Date(d.getTime() + 5 * 3_600_000);
  return `${pk.getUTCDate()} ${MONTHS[pk.getUTCMonth()]} ${pk.getUTCFullYear()}, ${paperClock(d)}`;
}

/** The prep list for a request, worked out now (no prices: it goes to the kitchen). */
export function prepListFor(db: AppDatabase, req: RecipeCalcRequest, meta: { byName: string | null; now?: Date }): PlainDocument {
  return prepListDocument(getRecipeCalc(db, req), { when: whenText(meta.now ?? new Date()), by: meta.byName });
}
