import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { matchesSearch, normalizeSearchText, paginate, searchWords, type Page } from './list-query';

/**
 * Screen state that should survive switching tabs and coming back (search
 * box, chosen filter, page) but not a restart. Kept in memory for the life of
 * the window, keyed by `key`; without a key it is ordinary useState.
 */
const sessionMemory = new Map<string, unknown>();

export function useSessionState<T>(key: string | undefined, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    key !== undefined && sessionMemory.has(key) ? (sessionMemory.get(key) as T) : initial,
  );
  useEffect(() => {
    if (key !== undefined) sessionMemory.set(key, value);
  }, [key, value]);
  return [value, setValue];
}

/** `value`, but only once it has stopped changing for `ms` — for searches that go to the database. */
export function useDebouncedValue<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export const PAGE_SIZES = [25, 50, 100] as const;

export interface ListQueryOptions<T> {
  items: readonly T[] | undefined;
  /** Everything a person might type to find this row (name, category, supplier…). Keep it stable (useCallback). */
  searchText: (item: T) => string;
  /** The screen's own filters (chips, toggles), applied after the search. */
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  /** Remember search, page and page size across tab switches under this key. */
  persistKey?: string;
  defaultPageSize?: number;
  /**
   * When this changes (a filter chip, the sort), go back to page 1 so the
   * person is not left staring at an empty page 7.
   */
  resetPageOn?: unknown;
}

export interface ListQuery<T> extends Page<T> {
  query: string;
  setQuery: (q: string) => void;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  /** Rows matching the search box only — count filter chips from these. */
  searched: T[];
  /** Rows matching the search and the screen's filters, sorted (every page). */
  matched: T[];
}

/**
 * Search → filter → sort → page, in memory. For lists of hundreds of rows
 * (ingredients, suppliers, recipes) this is instant; lists that grow without
 * end (stock movements, orders) should page in SQL instead and use only the
 * components.
 */
export function useListQuery<T>(opts: ListQueryOptions<T>): ListQuery<T> {
  const { items, searchText, filter, sort, persistKey, resetPageOn } = opts;
  const [query, setQueryState] = useSessionState(persistKey && `${persistKey}:q`, '');
  const [page, setPage] = useSessionState(persistKey && `${persistKey}:page`, 1);
  const [pageSize, setPageSizeState] = useSessionState(
    persistKey && `${persistKey}:size`,
    opts.defaultPageSize ?? 50,
  );

  // The search text of each row, normalized once per data change rather than
  // on every key press. Pass `searchText` through useCallback when it reads
  // other data (a supplier's name) so the index is rebuilt when that arrives.
  const indexed = useMemo(
    () => (items ?? []).map((item) => ({ item, text: normalizeSearchText(searchText(item)) })),
    [items, searchText],
  );

  const searched = useMemo(() => {
    const words = searchWords(query);
    if (words.length === 0) return indexed.map((r) => r.item);
    return indexed.filter((r) => matchesSearch(r.text, words)).map((r) => r.item);
  }, [indexed, query]);

  const matched = useMemo(() => {
    const rows = filter ? searched.filter(filter) : [...searched];
    if (sort) rows.sort(sort);
    return rows;
  }, [searched, filter, sort]);

  // Back to page 1 when the filters change (not on first render: a remembered
  // page stays). Compared by value, so an inline `[category, lowOnly]` is fine.
  const resetKey = JSON.stringify(resetPageOn ?? null);
  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    setPage(1);
  }, [resetKey, setPage]);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      setPage(1);
    },
    [setQueryState, setPage],
  );
  const setPageSize = useCallback(
    (size: number) => {
      setPageSizeState(size);
      setPage(1);
    },
    [setPageSizeState, setPage],
  );

  const pageData = paginate(matched, page, pageSize);
  return { ...pageData, query, setQuery, setPage, pageSize, setPageSize, searched, matched };
}
