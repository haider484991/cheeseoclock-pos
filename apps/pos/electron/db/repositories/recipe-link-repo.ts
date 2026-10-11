import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { flattenRecipe, linkWouldLoop, MAX_LINK_DEPTH, MAX_LINK_QTY, type RecipeLine } from '@cheeseoclock/pos-domain';
import type { RecipeLinkInput, RecipeLinkView } from '@cheeseoclock/shared-types';
import { linkModifierIdsOf as idsOf, loadRecipeLinks, type RecipeLinkRow as LinkRow } from '../recipe-links-read.js';

export { loadRecipeLinks };

/**
 * A menu item's recipe linked to other items' recipes (migration 0055,
 * v0.7.47; the owner, 12 Oct 2026: "Deal ki recipe bhi link ho, copy nahi").
 * A Big Two deal links two Zinger Burgers and a Regular Fries; a deal's slot
 * links each choice to its item. The links are saved here with their sync
 * entries and one audit row (setRecipeLinksForItem), never in a loop;
 * everything that reads a recipe reads it through effectiveRecipesFor (or
 * flattens the whole menu with loadRecipeLinks), so the deal follows the
 * burger's recipe the moment it changes.
 */

export const LINK_TO_ITSELF = 'An item can’t use its own recipe.';
export const LINK_LOOPS = 'That would go round in a circle: the item you picked already uses this one’s recipe.';
export const LINK_TWICE = 'The same item is linked twice for the same choice: change how many instead.';
export const LINK_QTY = `How many is a whole number from 1 to ${MAX_LINK_QTY}.`;
export const LINK_ITEM_GONE = 'A linked item is no longer on the menu.';
export const LINK_CHOICE_GONE = 'A link points at a choice that does not exist.';

/**
 * The recipes of these items as everything reads them (stock, edits, the
 * cost kept with a sale): their own lines — read by `readOwn`, the caller's
 * own rule for a live line — with their links opened up, the components'
 * recipes read the same way, down to MAX_LINK_DEPTH. Items with no links read
 * exactly `readOwn`'s answer, with no other query than the links' own.
 */
export function effectiveRecipesFor(
  db: AppDatabase,
  itemIds: readonly string[],
  readOwn: (db: AppDatabase, ids: string[]) => Map<string, RecipeLine[]>,
): Map<string, RecipeLine[]> {
  const ids = [...new Set(itemIds)];
  const own = readOwn(db, ids);
  const links = loadRecipeLinks(db, ids);
  if (links.size === 0) return own;
  // The components, and theirs, each read once.
  const loaded = new Set(ids);
  let frontier = [...new Set([...links.values()].flat().map((l) => l.componentItemId))].filter((id) => !loaded.has(id));
  for (let depth = 0; frontier.length > 0 && depth < MAX_LINK_DEPTH; depth++) {
    for (const id of frontier) loaded.add(id);
    for (const [id, lines] of readOwn(db, frontier)) own.set(id, lines);
    const more = loadRecipeLinks(db, frontier);
    for (const [id, ls] of more) links.set(id, ls);
    frontier = [...new Set([...more.values()].flat().map((l) => l.componentItemId))].filter((id) => !loaded.has(id));
  }
  const out = new Map<string, RecipeLine[]>();
  for (const id of ids) {
    const lines = flattenRecipe(id, (x) => own.get(x), (x) => links.get(x));
    if (lines.length > 0) out.set(id, lines);
  }
  return out;
}

/** An item's links as the recipe screens show them, with the names. */
export function listRecipeLinksForItem(db: AppDatabase, menuItemId: string): RecipeLinkView[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.menu_item_id, l.component_item_id, l.qty_per_unit, l.modifier_id, l.component_modifier_ids_json,
              c.name AS component_name, m.name AS modifier_name
         FROM recipe_links l
         JOIN menu_items c ON c.id = l.component_item_id AND c.deleted_at IS NULL
         LEFT JOIN modifiers m ON m.id = l.modifier_id AND m.deleted_at IS NULL
        WHERE l.menu_item_id = ? AND l.deleted_at IS NULL AND (l.modifier_id IS NULL OR m.id IS NOT NULL)
        ORDER BY l.modifier_id IS NOT NULL, m.sort_order, m.name, c.name`,
    )
    .all(menuItemId) as Array<LinkRow & { component_name: string; modifier_name: string | null }>;
  const names = new Map(
    (db.prepare(`SELECT id, name FROM modifiers WHERE deleted_at IS NULL`).all() as Array<{ id: string; name: string }>).map((m) => [m.id, m.name]),
  );
  return rows.map((r) => {
    const componentModifierIds = idsOf(r.component_modifier_ids_json).filter((id) => names.has(id));
    return {
      id: r.id,
      menuItemId: r.menu_item_id,
      componentItemId: r.component_item_id,
      componentName: r.component_name,
      qtyPerUnit: r.qty_per_unit,
      modifierId: r.modifier_id,
      modifierName: r.modifier_name,
      componentModifierIds,
      componentModifierNames: componentModifierIds.map((id) => names.get(id)!),
    };
  });
}

/** How many live links each item's recipe has (the Recipes screen counts them as lines). */
export function recipeLinkCounts(db: AppDatabase): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, ls] of loadRecipeLinks(db)) out.set(id, ls.length);
  return out;
}

/** The live items whose recipes link this one (a deal using the burger), by name. */
export function itemsLinking(db: AppDatabase, componentItemId: string): Array<{ id: string; name: string }> {
  return db
    .prepare(
      `SELECT DISTINCT i.id, i.name
         FROM recipe_links l
         JOIN menu_items i ON i.id = l.menu_item_id AND i.deleted_at IS NULL
        WHERE l.component_item_id = ? AND l.deleted_at IS NULL
        ORDER BY i.name`,
    )
    .all(componentItemId) as Array<{ id: string; name: string }>;
}

/** The ids as component_modifier_ids_json stores them: each once, in their order; NULL for none. */
function idsJson(ids: readonly string[] | undefined): string | null {
  const clean = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && x.length > 0))];
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

/**
 * Replace an item's links. One transaction: each link checked (its item on
 * the menu, not the item itself, 1–99 of it, its choices there, never twice
 * for one choice, never a loop), the rows no longer wanted soft-deleted, the
 * rest updated or added — each with its sync entry — and one audit row.
 */
export function setRecipeLinksForItem(db: AppDatabase, menuItemId: string, desired: readonly RecipeLinkInput[], actor: Actor): void {
  const keyOf = (componentItemId: string, modifierId: string | null | undefined) => `${componentItemId}|${modifierId ?? ''}`;
  db.transaction(() => {
    const item = db.prepare(`SELECT id FROM menu_items WHERE id = ? AND deleted_at IS NULL`).get(menuItemId);
    if (!item) throw new Error('Menu item not found');
    const wanted = new Map<string, RecipeLinkInput>();
    for (const d of desired) {
      if (d.componentItemId === menuItemId) throw new Error(LINK_TO_ITSELF);
      if (!Number.isInteger(d.qtyPerUnit) || d.qtyPerUnit < 1 || d.qtyPerUnit > MAX_LINK_QTY) throw new Error(LINK_QTY);
      if (!db.prepare(`SELECT 1 FROM menu_items WHERE id = ? AND deleted_at IS NULL`).get(d.componentItemId)) throw new Error(LINK_ITEM_GONE);
      for (const m of [d.modifierId ?? null, ...(d.componentModifierIds ?? [])]) {
        if (m && !db.prepare(`SELECT 1 FROM modifiers WHERE id = ? AND deleted_at IS NULL`).get(m)) throw new Error(LINK_CHOICE_GONE);
      }
      const key = keyOf(d.componentItemId, d.modifierId);
      if (wanted.has(key)) throw new Error(LINK_TWICE);
      wanted.set(key, d);
    }
    // Never a loop: every other item's links as they are, this item's as wanted.
    const all = loadRecipeLinks(db);
    all.set(
      menuItemId,
      [...wanted.values()].map((d) => ({ componentItemId: d.componentItemId, qtyPerUnit: d.qtyPerUnit, modifierId: d.modifierId ?? null, componentModifierIds: d.componentModifierIds ?? [] })),
    );
    for (const d of wanted.values()) {
      if (linkWouldLoop(menuItemId, d.componentItemId, (id) => all.get(id))) throw new Error(LINK_LOOPS);
    }

    const now = nowIso();
    const existing = db
      .prepare(
        `SELECT id, menu_item_id, component_item_id, qty_per_unit, modifier_id, component_modifier_ids_json
           FROM recipe_links WHERE menu_item_id = ? AND deleted_at IS NULL`,
      )
      .all(menuItemId) as LinkRow[];
    const existingByKey = new Map(existing.map((r) => [keyOf(r.component_item_id, r.modifier_id), r]));
    for (const r of existing) {
      if (wanted.has(keyOf(r.component_item_id, r.modifier_id))) continue;
      db.prepare(`UPDATE recipe_links SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(now, now, r.id);
      enqueueSync(db, { entityType: 'recipe_links', entityId: r.id, op: 'delete', payload: { id: r.id, deletedAt: now } });
    }
    for (const [key, d] of wanted) {
      const json = idsJson(d.componentModifierIds);
      const ex = existingByKey.get(key);
      if (ex) {
        if (ex.qty_per_unit === d.qtyPerUnit && (ex.component_modifier_ids_json ?? null) === json) continue;
        db.prepare(`UPDATE recipe_links SET qty_per_unit = ?, component_modifier_ids_json = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(
          d.qtyPerUnit,
          json,
          now,
          ex.id,
        );
        enqueueSync(db, { entityType: 'recipe_links', entityId: ex.id, op: 'upsert', payload: { id: ex.id, qtyPerUnit: d.qtyPerUnit } });
      } else {
        const id = uuidv7();
        db.prepare(
          `INSERT INTO recipe_links
             (id, menu_item_id, component_item_id, qty_per_unit, modifier_id, component_modifier_ids_json, created_at, updated_at, device_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, menuItemId, d.componentItemId, d.qtyPerUnit, d.modifierId ?? null, json, now, now, actor.deviceId);
        enqueueSync(db, { entityType: 'recipe_links', entityId: id, op: 'upsert', payload: { id, menuItemId, componentItemId: d.componentItemId } });
      }
    }
    writeAudit(db, {
      entityType: 'recipe_links',
      entityId: menuItemId,
      action: 'set_recipe_links',
      actorUserId: actor.userId,
      before: existing.map((r) => ({ componentItemId: r.component_item_id, qtyPerUnit: r.qty_per_unit, modifierId: r.modifier_id, componentModifierIds: idsOf(r.component_modifier_ids_json) })),
      after: [...wanted.values()].map((d) => ({ componentItemId: d.componentItemId, qtyPerUnit: d.qtyPerUnit, modifierId: d.modifierId ?? null, componentModifierIds: d.componentModifierIds ?? [] })),
    });
  })();
}
