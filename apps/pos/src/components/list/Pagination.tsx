import { cn } from '@cheeseoclock/ui';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { PAGE_SIZES } from './useListQuery';

const fmt = new Intl.NumberFormat('en-PK');

export interface PaginationProps {
  /** 1-based. */
  page: number;
  pageCount: number;
  total: number;
  /** 1-based position of the first and last row shown. */
  from: number;
  to: number;
  onPage: (page: number) => void;
  pageSize?: number;
  onPageSize?: (size: number) => void;
  /** What the rows are, for "Showing 1–50 of 123 ingredients". */
  noun?: string;
  className?: string;
}

function PageButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-stone-300 dark:ring-stone-700 dark:hover:bg-stone-800"
    >
      {children}
    </button>
  );
}

/**
 * "Showing 51–100 of 312 ingredients", page buttons, and a page-size pick.
 * Works for in-memory lists (useListQuery) and lists paged in SQL alike.
 */
export function Pagination({
  page,
  pageCount,
  total,
  from,
  to,
  onPage,
  pageSize,
  onPageSize,
  noun = 'rows',
  className,
}: PaginationProps) {
  if (total === 0) return null;
  return (
    <div className={cn('mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-stone-600 dark:text-stone-400', className)}>
      <div aria-live="polite">
        Showing <strong className="text-stone-900 dark:text-stone-100">{fmt.format(from)}–{fmt.format(to)}</strong> of{' '}
        <strong className="text-stone-900 dark:text-stone-100">{fmt.format(total)}</strong> {noun}
      </div>
      <div className="flex items-center gap-2">
        {pageSize !== undefined && onPageSize && (
          <label className="flex items-center gap-1.5">
            <span className="text-xs">Per page</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="h-9 rounded-lg border border-stone-300 bg-white px-2 text-sm dark:border-stone-700 dark:bg-stone-800"
            >
              {[...new Set([...PAGE_SIZES, pageSize])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <PageButton onClick={() => onPage(1)} disabled={page <= 1} label="First page">
              <ChevronsLeft className="h-4 w-4" />
            </PageButton>
            <PageButton onClick={() => onPage(page - 1)} disabled={page <= 1} label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </PageButton>
            <span className="min-w-[6.5rem] text-center tabular-nums">
              Page {fmt.format(page)} of {fmt.format(pageCount)}
            </span>
            <PageButton onClick={() => onPage(page + 1)} disabled={page >= pageCount} label="Next page">
              <ChevronRight className="h-4 w-4" />
            </PageButton>
            <PageButton onClick={() => onPage(pageCount)} disabled={page >= pageCount} label="Last page">
              <ChevronsRight className="h-4 w-4" />
            </PageButton>
          </div>
        )}
      </div>
    </div>
  );
}
