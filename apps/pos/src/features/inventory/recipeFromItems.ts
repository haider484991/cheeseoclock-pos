/**
 * A recipe built from the recipes of items already on the menu (0.7.46; the
 * owner, 12 Oct 2026: "if the manager or anyone want to create new deals it
 * should be able to group the already listed products so the inventory
 * ingredients and recipes should be able to add easily … I don't have time
 * to add [recipes] one by one again"). The recipe editor's "Add another
 * item's recipe": a Big Two deal takes two Zinger Burgers' ingredients and a
 * Regular Fries' at once, and a deal's slot ("Deal: Large pizza") takes each
 * pizza's ingredients under its own choice. The lines are COPIED into the
 * recipe being edited (the owner checks them and presses Save): a later
 * change to the burger's recipe does not move the deal's. Pure, so tested.
 */

/** A recipe line as the editor holds it. */
export interface DraftLine {
  ingredientId: string;
  qtyPerUnit: number;
  /** The choice it is used with; null = every sale. */
  modifierId: string | null;
}

/** The most of one item a deal takes in one go. */
export const MAX_TIMES = 20;

/**
 * Another item's recipe as lines of this one: its every-sale lines, and the
 * lines of those of its choices that were ticked (a pizza's "Size: Large"),
 * each amount × `times`, all under `target` (this item's choice; null = every
 * sale) — one line per ingredient, the amounts added together.
 */
export function linesFromItem(
  source: ReadonlyArray<DraftLine>,
  opts: { times: number; withChoices?: ReadonlySet<string>; target: string | null },
): DraftLine[] {
  const times = Math.max(1, Math.min(MAX_TIMES, Math.round(opts.times)));
  const out: DraftLine[] = [];
  for (const l of source) {
    if (l.modifierId !== null && !opts.withChoices?.has(l.modifierId)) continue;
    if (!l.ingredientId || !(l.qtyPerUnit > 0)) continue;
    const same = out.find((x) => x.ingredientId === l.ingredientId);
    if (same) same.qtyPerUnit += l.qtyPerUnit * times;
    else out.push({ ingredientId: l.ingredientId, qtyPerUnit: l.qtyPerUnit * times, modifierId: opts.target });
  }
  return out;
}

/**
 * Lines added to a recipe: an ingredient it already has for the same choice
 * gets the amount added (the editor never holds one twice for a choice);
 * every other line goes at the end, in the order given.
 */
export function mergeRecipeLines(existing: ReadonlyArray<DraftLine>, added: ReadonlyArray<DraftLine>): DraftLine[] {
  const out = existing.map((l) => ({ ...l }));
  for (const a of added) {
    const same = out.find((l) => l.ingredientId === a.ingredientId && (l.modifierId ?? null) === (a.modifierId ?? null));
    if (same) same.qtyPerUnit += a.qtyPerUnit;
    else out.push({ ...a });
  }
  return out;
}

/** The words of a name, lower case: "Large: Fajita" → ["large", "fajita"]. */
function wordsOf(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * The menu item a deal's choice most likely is, to start its box with: the
 * item of the same name, else the shortest item whose name holds every word
 * of the choice that some item's name has ("2nd Large: Fajita" → "Fajita
 * Pizza — Large"). Null when nothing fits: the owner picks it.
 */
export function itemForChoice(choiceName: string, items: ReadonlyArray<{ id: string; name: string }>): string | null {
  const exact = items.find((i) => i.name.trim().toLowerCase() === choiceName.trim().toLowerCase());
  if (exact) return exact.id;
  const itemWords = items.map((i) => ({ id: i.id, name: i.name, words: new Set(wordsOf(i.name)) }));
  const known = wordsOf(choiceName).filter((w) => itemWords.some((i) => i.words.has(w)));
  if (known.length === 0) return null;
  const fits = itemWords.filter((i) => known.every((w) => i.words.has(w)));
  if (fits.length === 0) return null;
  fits.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return fits[0]!.id;
}
