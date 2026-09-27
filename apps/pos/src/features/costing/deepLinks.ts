/**
 * The Costing page fixes nothing itself: prices and recipes stay in
 * Inventory (costing spec §5). These open the right Inventory screen,
 * searched for the thing to fix, with its form already open. The Reports
 * links (a tab, a period, a part of it) are here too.
 */
import type { ReportTab } from '@cheeseoclock/shared-types';
import { presetSessionState, readSessionState } from '../../components/list';
import { CALC_LINES_KEY, withItemLine, type CalcLine } from '../inventory/recipeCalcView';
import type { RangePreset } from '../reports/dateRange';
import { SHIFT_HISTORY_ANCHOR } from '../reports/reportTabs';

type Navigate = (to: string) => void;

/** Inventory → Ingredients, searched for it, its "Set price" open (per kg, per pack or per piece). */
export function openIngredientInInventory(navigate: Navigate, ingredient: { id: string; name: string }): void {
  presetSessionState('inv.tab', 'ingredients');
  presetSessionState('inv.ing:q', ingredient.name);
  presetSessionState('inv.ing:page', 1);
  presetSessionState('inv.ing.category', 'all');
  presetSessionState('inv.ing.stock', 'all');
  presetSessionState('inv.ing.openId', ingredient.id);
  navigate('/inventory');
}

/** Inventory → Recipes → Menu items, searched for it, its recipe open ("Open recipe"). */
export function openRecipeInInventory(navigate: Navigate, item: { id: string; name: string }): void {
  presetSessionState('inv.tab', 'recipes');
  presetSessionState('inv.rec.mode', 'items');
  presetSessionState('inv.rec:q', item.name);
  presetSessionState('inv.rec:page', 1);
  presetSessionState('inv.rec.category', 'all');
  presetSessionState('inv.rec.missing', false);
  presetSessionState('inv.rec.openId', item.id);
  navigate('/inventory');
}

/** Inventory → Ingredients, searched for it and showing low stock (a "Do this" line: a key ingredient running low). */
export function openLowStockInInventory(navigate: Navigate, ingredient: { id: string; name: string }): void {
  presetSessionState('inv.tab', 'ingredients');
  presetSessionState('inv.ing:q', ingredient.name);
  presetSessionState('inv.ing:page', 1);
  presetSessionState('inv.ing.category', 'all');
  presetSessionState('inv.ing.stock', 'low');
  navigate('/inventory');
}

/**
 * Settings → foodpanda: the one place foodpanda's commission, fee, tax,
 * dearer prices and deal are changed (Costing → Targets & fees shows them
 * read-only). Settings opens a tab from `?tab=` (SettingsPage).
 */
export function openFoodpandaSettings(navigate: Navigate): void {
  navigate('/settings?tab=foodpanda');
}

/** Inventory → Stock takes (a "Do this" line: a stock take the owner asked to be reminded of is due). */
export function openStockTakes(navigate: Navigate): void {
  presetSessionState('inv.tab', 'stocktakes');
  navigate('/inventory');
}

/** Costing on one of its tabs (the Dashboard's "Do this": Missing costs, Alerts). */
export function openCostingTab(navigate: Navigate, tab: 'menu' | 'missing' | 'alerts' | 'targets'): void {
  presetSessionState('costing.tab', tab);
  navigate('/costing');
}

/** Costing → Menu costs, searched for the dish, its cost sheet open (a "Do this" line: a dish over target). */
export function openDishInCosting(navigate: Navigate, item: { id: string; name: string }): void {
  presetSessionState('costing.tab', 'menu');
  presetSessionState('costing.menu.cat', 'all');
  presetSessionState('costing.menu:q', item.name);
  presetSessionState('costing.menu.openId', item.id);
  navigate('/costing');
}

/**
 * Inventory → Recipes → Batch recipes, its recipe open for editing (what
 * goes in, how much it makes) — never the calculator, whose main button
 * makes a batch and moves stock.
 */
export function openBatchInInventory(navigate: Navigate, ingredientId: string): void {
  presetSessionState('inv.tab', 'recipes');
  presetSessionState('inv.rec.mode', 'batches');
  presetSessionState('inv.batch.openId', ingredientId);
  navigate('/inventory');
}

/**
 * Inventory → Recipe calculator before going there (the Dashboard tile,
 * "Calculate" on a recipe card or a cost sheet): with a menu item, that
 * item is ADDED to what is being worked out (10 of it, the usual picks) —
 * or left as it is when it is there already — so a list being built is
 * never lost; without, it is as it was left. Opening it never moves stock.
 */
export function presetRecipeCalculator(item?: { id: string; name: string }): void {
  presetSessionState('inv.tab', 'calculator');
  if (item) presetSessionState(CALC_LINES_KEY, withItemLine(readSessionState<CalcLine[]>(CALC_LINES_KEY), item).lines);
}

/** Inventory → Recipe calculator ("Calculate" on an item's cost sheet: that item). */
export function openRecipeCalculator(navigate: Navigate, item?: { id: string; name: string }): void {
  presetRecipeCalculator(item);
  navigate('/inventory');
}

/** The one-shot link Reports reads when it opens (ReportsPage). */
export const REPORTS_DEEP_LINK = 'reports.deepLink';

/** Where Reports opens: a tab, a period, and what on that tab to show. */
export interface ReportsDeepLink {
  tab: ReportTab;
  preset: RangePreset;
  /** With the "Between stock takes" period: these two. */
  stockTakes?: { fromCountId: string; toCountId: string };
  /** The id of a part of the tab to bring into view once its figures are on screen. */
  scrollTo?: string;
}

/**
 * Reports → Food cost & stock, "Between stock takes", on these two stock
 * takes: what was used against what should have been (a finished stock
 * take's link, the Dashboard's "Do this" stock line).
 */
export function openStockVariance(navigate: Navigate, stockTakes: NonNullable<ReportsDeepLink['stockTakes']>): void {
  presetSessionState(REPORTS_DEEP_LINK, { tab: 'foodStock', preset: 'stockTakes', stockTakes } satisfies ReportsDeepLink);
  navigate('/reports');
}

/**
 * Reports → Team & leakage over the last 7 days, scrolled to the shift
 * history (the top bar's "Shift history", the owner's: 2026-09-27 "I can't
 * see the shift history").
 */
export function openShiftHistory(navigate: Navigate): void {
  presetSessionState(REPORTS_DEEP_LINK, { tab: 'team', preset: 'last7', scrollTo: SHIFT_HISTORY_ANCHOR } satisfies ReportsDeepLink);
  navigate('/reports');
}
