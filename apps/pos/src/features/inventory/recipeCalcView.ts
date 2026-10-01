/**
 * The recipe calculator's screen logic (Inventory → Recipe calculator), pure
 * so it is tested: what the manager is making (the lines, kept for the
 * session), the search that finds a dish, a deal, a dip or a batch, "the
 * till's usual picks" worked out ONCE here and sent as explicit counts (so
 * the screen, the costs and the paper say the same), and what each batch
 * row's "Make / calculate" opens at.
 */
import {
  MAX_CALC_AMOUNT,
  MAX_CALC_COUNT,
  typicalPortions,
  type PickMix,
} from '@cheeseoclock/pos-domain';
import { paperClock } from '@cheeseoclock/shared-types';
import type {
  Category,
  Ingredient,
  MenuItem,
  RecipeCalcBatchRow,
  RecipeCalcLineRequest,
  RecipeCalcQtyRow,
  RecipeCalcRequest,
  TypicalPicksView,
} from '@cheeseoclock/shared-types';
import { matchesSearch } from '../../components/list';
import { searchMenu } from '../checkout/menuSearch';
import { amountProblem, readAmount, splitSize, thousandUnit } from '../costing/costingFormat';

/** Session memory: the lines being worked out (they survive a tab switch). */
export const CALC_LINES_KEY = 'inv.calc.lines';
/** Session memory: what was picked lately, for the chips under the search box. */
export const CALC_RECENT_KEY = 'inv.calc.recent';
/** The React Query key of the answers (under 'inventory', so a Make refreshes the stock shown). */
export const RECIPE_CALC_KEY = ['inventory', 'recipeCalc'] as const;

/** One thing being made, as typed. */
export type CalcLine = ItemCalcLine | BatchCalcLine;
export type ItemCalcLine = Extract<CalcLineUnion, { kind: 'item' }>;
export type BatchCalcLine = Extract<CalcLineUnion, { kind: 'batch' }>;
type CalcLineUnion =
  | {
      key: string;
      kind: 'item';
      menuItemId: string;
      name: string;
      countText: string;
      /** The choices counted by hand; null = the till's usual picks, following the count. */
      portions: Record<string, number> | null;
    }
  | {
      key: string;
      kind: 'batch';
      ingredientId: string;
      name: string;
      unit: string;
      text: string;
      /** Typed in kg / litres. */
      inBig: boolean;
    };

/** Something picked lately (a chip). */
export interface RecentPick {
  kind: 'item' | 'batch';
  id: string;
  name: string;
}

let seq = 0;
function newKey(): string {
  seq += 1;
  return `l${Date.now().toString(36)}${seq}`;
}

/** A line for N of a menu item, with the usual picks. */
export function itemLine(item: { id: string; name: string }, count = 10): ItemCalcLine {
  return { key: newKey(), kind: 'item', menuItemId: item.id, name: item.name, countText: String(count), portions: null };
}

/** A line for one batch of a batch recipe (the amount can be changed). */
export function batchLine(ing: { id: string; name: string; unit: string; batchYield: number | null }): BatchCalcLine {
  return { key: newKey(), kind: 'batch', ingredientId: ing.id, name: ing.name, unit: ing.unit, text: ing.batchYield ? String(ing.batchYield) : '', inBig: false };
}

/** The recent chips with this one first (each once, at most 6). */
export function withRecent(list: readonly RecentPick[], pick: RecentPick): RecentPick[] {
  return [pick, ...list.filter((r) => !(r.kind === pick.kind && r.id === pick.id))].slice(0, 6);
}

// ----------------------------------------------------------------- search --

export type CalcHit =
  | {
      kind: 'item';
      key: string;
      /** "Fajita Pizza" for the sizes, or the whole name. */
      base: string;
      categoryName: string;
      /** Each size is its own menu item with its own recipe; `label` null when it has no size. */
      sizes: Array<{ label: string | null; item: MenuItem }>;
    }
  | { kind: 'batch'; key: string; ingredient: Ingredient };

const SIZE_ORDER = ['small', 'regular', 'medium', 'large', 'family', 'jumbo'];
const sizeRank = (label: string | null) => {
  const i = SIZE_ORDER.indexOf((label ?? '').toLowerCase());
  return i === -1 ? SIZE_ORDER.length : i;
};

/** Rows kept for batch recipes when menu items alone would fill the list. */
export const CALC_SEARCH_BATCH_ROOM = 4;

/**
 * What the search box finds: menu items (the till's own menu search, a typo
 * forgiven when it finds nothing), each dish once with its sizes as
 * buttons — Small pizzas left out as the till leaves them out — and batch
 * recipes. What matches by NAME comes first (dishes, then batches), then
 * dishes found only through their description or category ("pizza sauce"
 * finds the Pizza Sauce batch before every pizza "on rich tomato sauce");
 * and batches always keep a few rows (CALC_SEARCH_BATCH_ROOM), so a common
 * word never hides them. At most `limit` rows.
 */
export function calcSearch(
  items: readonly MenuItem[],
  categories: readonly Category[],
  batches: readonly Ingredient[],
  query: string,
  limit = 12,
): CalcHit[] {
  if (query.trim() === '') return [];
  const pizzaCategories = new Set(categories.filter((c) => /\bpizzas?\b/i.test(c.name)).map((c) => c.id));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const visible = items.filter((i) => !(pizzaCategories.has(i.categoryId) && /\s+[—–-]\s*Small$/i.test(i.name)));
  let found = searchMenu(visible, [...categories], query);
  if (found.length === 0) found = visible.filter((i) => matchesSearch(`${i.name} ${catName.get(i.categoryId) ?? ''}`, query));

  const groups = new Map<string, Extract<CalcHit, { kind: 'item' }>>();
  for (const item of found) {
    const { base, size } = splitSize(item.name);
    const key = `${item.categoryId}|${base.toLowerCase()}`;
    const g = groups.get(key);
    if (g) g.sizes.push({ label: size, item });
    else groups.set(key, { kind: 'item', key, base, categoryName: catName.get(item.categoryId) ?? '', sizes: [{ label: size, item }] });
  }
  for (const g of groups.values()) g.sizes.sort((a, b) => sizeRank(a.label) - sizeRank(b.label));
  const itemByName = (g: Extract<CalcHit, { kind: 'item' }>) => g.sizes.some((s) => matchesSearch(s.item.name, query));
  const itemHits = [...groups.values()];

  const recipes = batches.filter((b) => b.batchYield !== null);
  const batchHit = (b: Ingredient): CalcHit => ({ kind: 'batch', key: `batch|${b.id}`, ingredient: b });
  const batchesByName = recipes.filter((b) => matchesSearch(b.name, query));
  // "sauce batch", "batch": a batch recipe by what it is.
  const batchesOther = recipes.filter((b) => !batchesByName.includes(b) && matchesSearch(`${b.name} batch`, query));

  const ranked: CalcHit[] = [
    ...itemHits.filter(itemByName),
    ...batchesByName.map(batchHit),
    ...itemHits.filter((g) => !itemByName(g)),
    ...batchesOther.map(batchHit),
  ];
  const itemRoom = limit - Math.min(CALC_SEARCH_BATCH_ROOM, batchesByName.length + batchesOther.length);
  const out: CalcHit[] = [];
  let itemsIn = 0;
  for (const h of ranked) {
    if (out.length >= limit) break;
    if (h.kind === 'item') {
      if (itemsIn >= itemRoom) continue;
      itemsIn += 1;
    }
    out.push(h);
  }
  return out;
}

// ------------------------------------------------------------- the picks --

/** The customers' picks as pos-domain reads them. */
export function mixOf(view: TypicalPicksView): PickMix {
  return {
    units: view.mix.units,
    picks: new Map(Object.entries(view.mix.picks)),
    groupUnits: new Map(Object.entries(view.mix.groupUnits)),
  };
}

/** The groups the calculator counts: every one but the leave-outs, with their options that are not leave-outs. */
export function countedGroups(view: TypicalPicksView): TypicalPicksView['groups'] {
  return view.groups
    .filter((g) => g.kind !== 'leave-out')
    .map((g) => ({ ...g, options: g.options.filter((o) => !o.leaveOut) }))
    .filter((g) => g.options.length > 0);
}

/** A leave-out group the item has ("they only use less"). */
export function hasLeaveOuts(view: TypicalPicksView): boolean {
  return view.groups.some((g) => g.kind === 'leave-out' || g.options.some((o) => o.leaveOut));
}

export interface UsualPicks {
  /** Every counted option: how many of `count` get it (optional groups: 0). */
  portions: Record<string, number>;
  /** Required groups spread evenly, too few sold to go by (their names). */
  evenGroups: string[];
  /** Units sold in the last 28 days. */
  sold: number;
}

/** The till's usual picks for `count` (pos-domain typicalPortions: the plate cost's rule). */
export function usualPicks(view: TypicalPicksView, count: number): UsualPicks {
  const mix = mixOf(view);
  const portions: Record<string, number> = {};
  const evenGroups: string[] = [];
  for (const g of countedGroups(view)) {
    const t = typicalPortions(
      { id: g.groupId, selectionType: g.selectionType, minSelect: g.minSelect, maxSelect: g.maxSelect, isRequired: g.isRequired, options: g.options.map((o) => ({ id: o.modifierId })) },
      mix,
      count,
    );
    for (const o of g.options) portions[o.modifierId] = 0;
    if (!t) continue;
    for (const p of t.portions) portions[p.modifierId] = p.count;
    if (t.basis === 'even' && g.options.length > 1) evenGroups.push(g.name);
  }
  return { portions, evenGroups, sold: view.mix.units };
}

/**
 * The counts sent for a line: the ones set by hand, or the usual picks; only
 * choices the item still has (the menu may have changed), none above the
 * count, none of a leave-out.
 */
export function effectivePortions(line: ItemCalcLine, view: TypicalPicksView, count: number): Record<string, number> {
  const base = line.portions ?? usualPicks(view, count).portions;
  const out: Record<string, number> = {};
  for (const g of countedGroups(view)) {
    for (const o of g.options) out[o.modifierId] = Math.max(0, Math.min(count, Math.floor(base[o.modifierId] ?? 0)));
  }
  return out;
}

// ---------------------------------------------------------- the request --

/** "10", "1,000": a whole number of items, 1 … 10,000; null otherwise. */
export function readCount(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_CALC_COUNT ? n : null;
}

export type LineReading =
  | { ok: true; req: RecipeCalcLineRequest }
  /** Not yet: the item's choices are still loading. */
  | { ok: false; waiting: true; problem: null }
  | { ok: false; waiting: false; problem: string };

/** One line as a request, or what is wrong with it in plain words. */
export function readLine(line: CalcLine, picks: TypicalPicksView | undefined): LineReading {
  if (line.kind === 'item') {
    const count = readCount(line.countText);
    if (count === null) return { ok: false, waiting: false, problem: `Type how many, 1 to ${MAX_CALC_COUNT.toLocaleString('en-PK')}.` };
    if (!picks) return { ok: false, waiting: true, problem: null };
    const portions = Object.entries(effectivePortions(line, picks, count))
      .filter(([, n]) => n > 0)
      .map(([modifierId, n]) => ({ modifierId, count: n }));
    return { ok: true, req: { kind: 'item', menuItemId: line.menuItemId, count, portions } };
  }
  const reading = readAmount(line.text, line.inBig, line.unit);
  if (!reading.ok) return { ok: false, waiting: false, problem: amountProblem(reading, line.unit, line.inBig && !!thousandUnit(line.unit)) ?? 'Type an amount.' };
  if (reading.amount > MAX_CALC_AMOUNT) return { ok: false, waiting: false, problem: `At most ${MAX_CALC_AMOUNT.toLocaleString('en-PK')} ${line.unit} at once.` };
  return { ok: true, req: { kind: 'batch', ingredientId: line.ingredientId, amount: reading.amount } };
}

/** The request for the lines that can be read (null when none can). */
export function calcRequest(readings: readonly LineReading[]): RecipeCalcRequest | null {
  const lines = readings.flatMap((r) => (r.ok ? [r.req] : []));
  return lines.length > 0 ? { lines } : null;
}

// -------------------------------------------------------------- the rows --

/**
 * What a batch row's buttons open the batch calculator at (never past one
 * go's worth: 100 batches): what is left to make once the shelf is used
 * (null when the shelf has enough), and — when that is less than all of it
 * — all of it, for making it fresh anyway.
 */
export function makeAmounts(row: Pick<RecipeCalcBatchRow, 'qty' | 'toMake' | 'maxAmount' | 'goes'>): {
  make: number | null;
  all: number | null;
  goes: number;
} {
  return {
    make: row.toMake > 0 ? Math.min(row.toMake, row.maxAmount) : null,
    all: row.toMake < row.qty ? Math.min(row.qty, row.maxAmount) : null,
    goes: row.goes,
  };
}

/**
 * "Calculate" on a dish (its recipe card, its cost sheet): the dish added to
 * what is already being worked out — never in place of it — or, when it is
 * there already, the list as it is. Returns the lines and the dish's line.
 */
export function withItemLine(lines: readonly CalcLine[] | undefined, item: { id: string; name: string }): { lines: CalcLine[]; key: string } {
  const list = [...(lines ?? [])];
  const there = list.find((l) => l.kind === 'item' && l.menuItemId === item.id);
  if (there) return { lines: list, key: there.key };
  const line = itemLine(item);
  return { lines: [...list, line], key: line.key };
}

/** A choice with no recipe lines of its own while others in its group have them: counting it adds nothing. */
export function lacksLines(group: TypicalPicksView['groups'][number], option: TypicalPicksView['groups'][number]['options'][number]): boolean {
  return !option.hasLines && group.options.some((o) => o.hasLines);
}

/** Short rows first (red), the rest as they came. */
export function shortFirst<T extends Pick<RecipeCalcQtyRow, 'shortBy'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(b.shortBy > 0) - Number(a.shortBy > 0));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * "27 Sep 2026, 14:05" — the prep list's time, as the printed one says it:
 * Pakistan time (UTC+5), whatever the PC's zone.
 */
export function whenText(d: Date): string {
  const pk = new Date(d.getTime() + 5 * 3_600_000);
  return `${pk.getUTCDate()} ${MONTHS[pk.getUTCMonth()]} ${pk.getUTCFullYear()}, ${paperClock(d)}`;
}
