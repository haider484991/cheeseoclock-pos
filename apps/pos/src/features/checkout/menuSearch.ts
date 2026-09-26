import type { Category, MenuItem } from '@cheeseoclock/shared-types';

/**
 * The till's menu search. It always searches the whole menu (a cashier on
 * "Drinks" who types "fajita" wants the pizza, not "nothing found"), every
 * word must match somewhere in the name, description or category, and names
 * that start with what was typed come first — so Enter adds the likely one.
 */
export function searchMenu(
  items: ReadonlyArray<MenuItem>,
  categories: ReadonlyArray<Category>,
  query: string,
): MenuItem[] {
  const words = normalise(query).split(' ').filter(Boolean);
  if (words.length === 0) return [...items];
  const categoryName = new Map(categories.map((c) => [c.id, normalise(c.name)] as const));
  const phrase = words.join(' ');
  const ranked: Array<{ item: MenuItem; rank: number; order: number }> = [];
  items.forEach((item, order) => {
    const name = normalise(item.name);
    const haystack = `${name} ${normalise(item.description ?? '')} ${categoryName.get(item.categoryId) ?? ''}`;
    if (!words.every((w) => haystack.includes(w))) return;
    const rank = name.startsWith(phrase)
      ? 0
      : name.split(' ').some((part) => part.startsWith(words[0]!))
        ? 1
        : name.includes(words[0]!)
          ? 2
          : 3;
    ranked.push({ item, rank, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.map((r) => r.item);
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[—–-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
