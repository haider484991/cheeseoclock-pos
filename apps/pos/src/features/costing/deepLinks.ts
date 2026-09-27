/**
 * The Costing page fixes nothing itself: prices and recipes stay in
 * Inventory (costing spec §5). These open the right Inventory screen,
 * searched for the thing to fix, with its form already open.
 */
import { presetSessionState } from '../../components/list';

type Navigate = (to: string) => void;

/** Inventory → Ingredients, searched for it, its form open ("Set price"). */
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
