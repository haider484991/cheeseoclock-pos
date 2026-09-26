/**
 * Pure helpers behind every searchable, pageable list in the till: search
 * that forgives the way people actually type ("mozarella", "jalapeno",
 * "chedar"), paging, and counting for filter chips. No React here, so it is
 * unit-tested directly (list-query.test.ts).
 */

/** "Jalapeño (Sliced)!" → "jalapeno sliced" — lower case, no accents, words only. */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The words of a search box, normalized. Empty box → no words (matches everything). */
export function searchWords(query: string): string[] {
  const n = normalizeSearchText(query);
  return n ? n.split(' ') : [];
}

/**
 * True when `a` becomes `b` with at most one typo: one letter added, dropped,
 * changed, or two neighbours swapped ("chedar" / "cheddar", "sause" / "sauce",
 * "onoin" / "onion").
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) {
    // one substitution, or one swap of neighbours
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  // one insertion / deletion
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * Words shorter than this must be typed right (as part of a word); longer
 * ones may have one typo. At 4 letters "mint" would also find "Mince".
 */
const FUZZY_MIN = 5;

function wordMatches(word: string, haystack: string, haystackWords: string[]): boolean {
  if (haystack.includes(word)) return true;
  if (word.length < FUZZY_MIN) return false;
  for (const hw of haystackWords) {
    if (hw.length + 1 < word.length) continue;
    // the whole word, or the start of it (people type the first few letters)
    for (const len of [word.length - 1, word.length, word.length + 1]) {
      if (len > hw.length) continue;
      if (withinOneEdit(word, hw.slice(0, len))) return true;
    }
  }
  return false;
}

/**
 * Does this row match the search box? Every word typed must appear somewhere
 * in the row's text (any order), each allowed one typo once it is 5+ letters.
 * `haystack` may be pre-normalized with `normalizeSearchText` for speed.
 */
export function matchesSearch(haystack: string, query: string | string[]): boolean {
  const words = typeof query === 'string' ? searchWords(query) : query;
  if (words.length === 0) return true;
  const hay = normalizeSearchText(haystack);
  const hayWords = hay.split(' ');
  return words.every((w) => wordMatches(w, hay, hayWords));
}

export interface Page<T> {
  items: T[];
  /** 1-based, clamped into range. */
  page: number;
  pageCount: number;
  total: number;
  /** 1-based position of the first row shown (0 when there are none). */
  from: number;
  /** 1-based position of the last row shown. */
  to: number;
}

/** One page of `items`. A page past the end shows the last page, never an empty one. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (p - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page: p,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}

/** How many rows fall under each key — for "Cheese & Dairy (11)" chips. */
export function countBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Human sort for names: "Box 2" before "Box 10", case ignored. */
export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}
