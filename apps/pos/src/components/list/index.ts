/**
 * The list kit: search box, filter chips, sortable headers and pagination
 * that every long list in the till can share, plus the in-memory
 * search/filter/page hook behind them. Inventory uses it first; other
 * screens can adopt it piece by piece.
 */
export { SearchBox, type SearchBoxProps } from './SearchBox';
export { FilterChips, ToggleChip, type ChipOption, type ChipTone } from './FilterChips';
export { Pagination, type PaginationProps } from './Pagination';
export { SortHeader } from './SortHeader';
export {
  useListQuery,
  useSessionState,
  useDebouncedValue,
  PAGE_SIZES,
  type ListQuery,
  type ListQueryOptions,
} from './useListQuery';
export {
  normalizeSearchText,
  searchWords,
  matchesSearch,
  withinOneEdit,
  paginate,
  countBy,
  compareText,
  type Page,
} from './list-query';
