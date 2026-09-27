/**
 * The Costing page fixes nothing itself: prices and recipes stay in
 * Inventory (costing spec §5). These open the right Inventory screen,
 * searched for the thing to fix, with its form already open.
 */
import { presetSessionState } from '../../components/list';

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
