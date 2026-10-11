/**
 * A recipe built from the recipes of items already on the menu. 0.7.46 (the
 * owner, 12 Oct 2026: "if the manager or anyone want to create new deals it
 * should be able to group the already listed products … I don't have time to
 * add [recipes] one by one again") copied their lines in; 0.7.47 (the owner,
 * the same day: "Deal ki recipe bhi link ho, copy nahi") LINKS them: a Big Two
 * deal links two Zinger Burgers and a Regular Fries, a deal's slot ("Deal:
 * Large pizza") links each pizza under its own choice, and a later change to
 * the burger's recipe moves the deal's with it (the main process opens the
 * links up: pos-domain recipe-links.ts). Pure, so tested.
 */
import { MAX_LINK_QTY } from '@cheeseoclock/pos-domain';

/** A recipe line as the editor holds it. */
export interface DraftLine {
  ingredientId: string;
  qtyPerUnit: number;
  /** The choice it is used with; null = every sale. */
  modifierId: string | null;
}

/** A link to another item's recipe as the editor holds it. */
export interface DraftLink {
  componentItemId: string;
  /** How many of that item one of this item takes (1–99; 0 only while trying in What if). */
  qtyPerUnit: number;
  /** This item's choice it comes with; null = every sale. */
  modifierId: string | null;
  /** That item's own choices whose lines come too (a pizza's "Size: Large"). */
  componentModifierIds: string[];
  /** For the screen: the item's name and those choices' names. */
  componentName: string;
  componentModifierNames: string[];
}

/** The most of one item a deal takes in one go (the link's limit, pos-domain MAX_LINK_QTY). */
export const MAX_TIMES = MAX_LINK_QTY;

/** A link's place: one per item and choice. */
export const linkKey = (l: { componentItemId: string; modifierId: string | null }): string => `${l.componentItemId}|${l.modifierId ?? ''}`;

/**
 * Another item's recipe as lines of this one: its every-sale lines, and the
 * lines of those of its choices that were ticked (a pizza's "Size: Large"),
 * each amount × `times`, all under `target` (this item's choice; null = every
 * sale) — one line per ingredient, the amounts added together. What 0.7.46's
 * copy put in: withoutCopiedLines takes such a copy out when the item is
 * linked instead.
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
 * Links added to a recipe: the same item for the same choice gets the
 * amounts added (at most MAX_TIMES) and its ticked choices joined; every
 * other link goes at the end, in the order given.
 */
export function mergeLinks(existing: ReadonlyArray<DraftLink>, added: ReadonlyArray<DraftLink>): DraftLink[] {
  const out = existing.map((l) => ({ ...l, componentModifierIds: [...l.componentModifierIds], componentModifierNames: [...l.componentModifierNames] }));
  for (const a of added) {
    const same = out.find((l) => linkKey(l) === linkKey(a));
    if (!same) {
      out.push({ ...a, componentModifierIds: [...a.componentModifierIds], componentModifierNames: [...a.componentModifierNames] });
      continue;
    }
    same.qtyPerUnit = Math.min(MAX_TIMES, same.qtyPerUnit + a.qtyPerUnit);
    a.componentModifierIds.forEach((id, i) => {
      if (same.componentModifierIds.includes(id)) return;
      same.componentModifierIds.push(id);
      same.componentModifierNames.push(a.componentModifierNames[i] ?? '');
    });
  }
  return out;
}

/**
 * A copy of another item's lines (0.7.46's "Add another item's recipe")
 * taken out of a recipe now that the item is linked, so it isn't counted
 * twice: only when every line of the copy is there for its choice with at
 * least that amount (an ingredient two items share was added together);
 * those amounts come off and a line left at 0 goes. Otherwise the lines are
 * left as they are and `removed` is false.
 */
export function withoutCopiedLines(lines: ReadonlyArray<DraftLine>, copy: ReadonlyArray<DraftLine>): { lines: DraftLine[]; removed: boolean } {
  const kept = lines.map((l) => ({ ...l }));
  if (copy.length === 0) return { lines: kept, removed: false };
  const find = (c: DraftLine) => kept.find((l) => l.ingredientId === c.ingredientId && (l.modifierId ?? null) === (c.modifierId ?? null));
  if (!copy.every((c) => (find(c)?.qtyPerUnit ?? 0) >= c.qtyPerUnit)) return { lines: kept, removed: false };
  for (const c of copy) find(c)!.qtyPerUnit -= c.qtyPerUnit;
  return { lines: kept.filter((l) => l.qtyPerUnit > 0), removed: true };
}

/** The links Save writes: as setRecipe takes them, one tried at 0 left out (taken off the recipe). */
export function linksToSave(links: ReadonlyArray<DraftLink>): Array<{ componentItemId: string; qtyPerUnit: number; modifierId: string | null; componentModifierIds: string[] }> {
  return links
    .filter((l) => l.qtyPerUnit > 0)
    .map((l) => ({ componentItemId: l.componentItemId, qtyPerUnit: l.qtyPerUnit, modifierId: l.modifierId, componentModifierIds: [...l.componentModifierIds] }));
}

/** What stops the links being saved, in words; null when nothing does. */
export function linkProblem(links: ReadonlyArray<DraftLink>): string | null {
  const bad = links.find((l) => !Number.isInteger(l.qtyPerUnit) || l.qtyPerUnit < 1 || l.qtyPerUnit > MAX_TIMES);
  if (bad) return `How many ${bad.componentName || 'of a linked item'}: a whole number from 1 to ${MAX_TIMES}.`;
  const seen = new Set<string>();
  for (const l of links) {
    if (seen.has(linkKey(l))) return `${l.componentName || 'An item'} is linked twice for the same choice: change how many instead.`;
    seen.add(linkKey(l));
  }
  return null;
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
