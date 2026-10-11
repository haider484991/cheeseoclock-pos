/**
 * A menu item's links to other items' recipes (migration 0055, v0.7.47), read
 * only. Here, not in recipe-link-repo.ts, because the costing service runs in
 * the Reports worker thread too, which must not load the write paths: the
 * plate cost, the recipe calculator and Reports open the links up from what
 * this reads (pos-domain flattenRecipes), the stock and the edits through
 * recipe-link-repo effectiveRecipesFor.
 */
import type { RecipeLink } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from './connection.js';

export interface RecipeLinkRow {
  id: string;
  menu_item_id: string;
  component_item_id: string;
  qty_per_unit: number;
  modifier_id: string | null;
  component_modifier_ids_json: string | null;
}

/** A stored component_modifier_ids_json read back: the ids it holds, else none. */
export function linkModifierIdsOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

export function recipeLinkOf(r: RecipeLinkRow): RecipeLink {
  return { componentItemId: r.component_item_id, qtyPerUnit: r.qty_per_unit, modifierId: r.modifier_id, componentModifierIds: linkModifierIdsOf(r.component_modifier_ids_json) };
}

/**
 * The live links — their component still on the menu, their choice still
 * there — of these items, or of every item; per item, every-sale links
 * first, in the order they were saved.
 */
export function loadRecipeLinks(db: AppDatabase, itemIds?: readonly string[]): Map<string, RecipeLink[]> {
  const out = new Map<string, RecipeLink[]>();
  if (itemIds && itemIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT l.id, l.menu_item_id, l.component_item_id, l.qty_per_unit, l.modifier_id, l.component_modifier_ids_json
         FROM recipe_links l
         JOIN menu_items c ON c.id = l.component_item_id AND c.deleted_at IS NULL
         LEFT JOIN modifiers m ON m.id = l.modifier_id AND m.deleted_at IS NULL
        WHERE l.deleted_at IS NULL AND (l.modifier_id IS NULL OR m.id IS NOT NULL)
          ${itemIds ? 'AND l.menu_item_id IN (SELECT value FROM json_each(?))' : ''}
        ORDER BY l.menu_item_id, l.modifier_id IS NOT NULL, l.rowid`,
    )
    .all(...(itemIds ? [JSON.stringify(itemIds)] : [])) as RecipeLinkRow[];
  for (const r of rows) {
    let list = out.get(r.menu_item_id);
    if (!list) out.set(r.menu_item_id, (list = []));
    list.push(recipeLinkOf(r));
  }
  return out;
}
