/**
 * A recipe that uses other menu items' recipes (0.7.47; the owner, 12 Oct
 * 2026: "Deal ki recipe bhi link ho, copy nahi" — a deal's recipe linked to
 * its items, not copied). A Big Two deal links two Zinger Burgers and a
 * Regular Fries; a deal's slot links each choice to its item ("Deal: Burger:
 * Grilled" → the Grilled Burger). Whatever reads a recipe — the stock taken
 * at a sale, an order edit, the cost kept with a sale, the plate cost, the
 * recipe calculator, What if — reads it FLATTENED here, so the deal follows
 * the burger's recipe the moment the burger's changes:
 *
 *  - the item's own lines, as before;
 *  - for each link, the component's own recipe (itself flattened: a deal may
 *    link a combo that links a burger), its every-sale lines and the lines of
 *    those of its choices the link names (a pizza's "Size: Large"), each
 *    amount × how many, all under the link's choice of this item (null =
 *    every sale);
 *  - one line per ingredient and choice, the amounts added together.
 *
 * An item with no links reads exactly its own lines, in their order. A link
 * that would come back to the item (a loop), or nests deeper than
 * MAX_LINK_DEPTH, adds nothing (the repository refuses to save a loop).
 */
import type { RecipeLine } from './recipe-expand.js';

/** A link from an item's recipe to another item's. */
export interface RecipeLink {
  componentItemId: string;
  /** How many of the component one of this item takes. */
  qtyPerUnit: number;
  /** This item's choice the component comes with; null = every sale. */
  modifierId: string | null;
  /** The component's own choices whose lines come too; empty = its every-sale lines only. */
  componentModifierIds: readonly string[];
}

/** How deep links may nest (a deal → a combo → a burger is 2). */
export const MAX_LINK_DEPTH = 6;

/** The most of one item a link takes. */
export const MAX_LINK_QTY = 99;

type Lookup<T> = (itemId: string) => ReadonlyArray<T> | undefined;

/** Lines with the same ingredient and choice made one, the amounts added; first seen first. */
function mergeLines(lines: ReadonlyArray<RecipeLine>): RecipeLine[] {
  const out: RecipeLine[] = [];
  const at = new Map<string, number>();
  for (const l of lines) {
    const key = `${l.ingredientId}|${l.modifierId ?? ''}`;
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push({ ingredientId: l.ingredientId, qtyPerUnit: l.qtyPerUnit, modifierId: l.modifierId });
    } else {
      out[i] = { ...out[i]!, qtyPerUnit: out[i]!.qtyPerUnit + l.qtyPerUnit };
    }
  }
  return out;
}

function flatten(itemId: string, own: Lookup<RecipeLine>, links: Lookup<RecipeLink>, path: ReadonlySet<string>): RecipeLine[] {
  const mine = own(itemId) ?? [];
  const itemLinks = links(itemId) ?? [];
  if (itemLinks.length === 0) return [...mine];
  const lines: RecipeLine[] = [...mine];
  const inside = new Set(path).add(itemId);
  for (const link of itemLinks) {
    // A loop, or deeper than any menu needs: nothing from this link.
    if (inside.has(link.componentItemId) || inside.size > MAX_LINK_DEPTH) continue;
    const qty = Math.max(0, Math.round(link.qtyPerUnit));
    if (qty === 0) continue;
    const included = new Set(link.componentModifierIds);
    for (const l of flatten(link.componentItemId, own, links, inside)) {
      if (l.modifierId !== null && !included.has(l.modifierId)) continue;
      lines.push({ ingredientId: l.ingredientId, qtyPerUnit: l.qtyPerUnit * qty, modifierId: link.modifierId });
    }
  }
  return mergeLines(lines);
}

/**
 * One item's recipe with its links opened up. `own` gives an item's own
 * lines, `links` its links (each may answer undefined for none).
 */
export function flattenRecipe(itemId: string, own: Lookup<RecipeLine>, links: Lookup<RecipeLink>): RecipeLine[] {
  return flatten(itemId, own, links, new Set());
}

/** Every item's recipe with its links opened up: the items with own lines or links, each once. */
export function flattenRecipes(
  own: ReadonlyMap<string, ReadonlyArray<RecipeLine>>,
  links: ReadonlyMap<string, ReadonlyArray<RecipeLink>>,
): Map<string, RecipeLine[]> {
  const out = new Map<string, RecipeLine[]>();
  for (const id of new Set([...own.keys(), ...links.keys()])) {
    out.set(id, flattenRecipe(id, (x) => own.get(x), (x) => links.get(x)));
  }
  return out;
}

/**
 * Would linking `componentItemId` into `itemId`'s recipe make a loop — is
 * `itemId` the component itself, or somewhere in what the component links?
 */
export function linkWouldLoop(itemId: string, componentItemId: string, links: Lookup<RecipeLink>): boolean {
  const seen = new Set<string>();
  const stack = [componentItemId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === itemId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of links(id) ?? []) stack.push(l.componentItemId);
  }
  return false;
}
