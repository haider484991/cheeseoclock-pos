import { useQuery } from '@tanstack/react-query';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { DeletedTestsPage } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { DataTable } from '../reports/reportUi';
import { orderTimeLabel, shortOrderNumber } from './historyFilters';
import { deletedPaidWords, deletedStockWords } from './testDeleteCopy';

/** "Test orders deleted — 2 (Rs 1,850)" */
export function deletedTestsTitle(page: Pick<DeletedTestsPage, 'total' | 'totalCents'> | undefined): string {
  if (!page) return 'Test orders deleted';
  return `Test orders deleted — ${page.total} (${formatCents(page.totalCents)})`;
}

export const NO_DELETED_TESTS = 'No test orders were deleted in this period.';

/** The query for one period: shared by the panel and the Order History link's count. */
export function useDeletedTests(sinceIso: string, untilIso: string, enabled = true) {
  return useQuery({
    queryKey: ['orders', 'deletedTests', sinceIso, untilIso],
    queryFn: () => ipc.orders.listDeletedTests({ sinceIso, untilIso, limit: 500 }),
    enabled: enabled && untilIso > sinceIso,
    staleTime: 30_000,
  });
}

/**
 * The owner's list of test orders deleted (migration 0043), by when the order
 * was taken: Reports → Team & leakage, and Order History's "Deleted test
 * orders" link for the page's dates. Read-only — no reprint, no restore: a
 * deleted test order can't be brought back.
 */
export function DeletedTestOrdersPanel({ sinceIso, untilIso }: { sinceIso: string; untilIso: string }) {
  const q = useDeletedTests(sinceIso, untilIso);
  if (q.isLoading) return <p className="py-4 text-center text-sm text-stone-500">Loading…</p>;
  if (q.error) {
    return (
      <p className="py-4 text-center text-sm text-red-700 dark:text-red-400">
        {q.error instanceof Error ? q.error.message : 'Could not load the deleted test orders.'}
      </p>
    );
  }
  const page = q.data;
  return (
    <div data-testid="deleted-test-orders">
      <DataTable
        columns={[
          { label: 'Order' },
          { label: 'Taken' },
          { label: 'Deleted' },
          { label: 'Why' },
          { label: 'Total', right: true },
          { label: 'Paid', right: true },
          { label: 'Stock' },
        ]}
        rows={(page?.rows ?? []).map((r) => [
          <div key="o">
            <div className="font-mono text-xs font-semibold">{shortOrderNumber(r.orderNumber)}</div>
            {r.itemsSummary && <div className="text-xs text-stone-500">{r.itemsSummary}</div>}
          </div>,
          <div key="t">
            <div>{orderTimeLabel(r.takenAt)}</div>
            <div className="text-xs text-stone-500">by {r.takenBy}</div>
          </div>,
          <div key="d">
            <div>{orderTimeLabel(r.deletedAt)}</div>
            <div className="text-xs text-stone-500">by {r.deletedBy}</div>
          </div>,
          r.reason ?? '—',
          formatCents(r.totalCents),
          deletedPaidWords(r),
          deletedStockWords(r),
        ])}
        empty={NO_DELETED_TESTS}
      />
      {page && page.rows.length < page.total && (
        <p className="mt-2 text-xs text-stone-500">
          Showing {page.rows.length} of {page.total}. The total above includes all of them.
        </p>
      )}
    </div>
  );
}
