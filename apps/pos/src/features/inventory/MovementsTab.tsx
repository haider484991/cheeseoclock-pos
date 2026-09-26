import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatQty } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import type { Ingredient, StockMovementEntry, StockMovementReason } from '@cheeseoclock/shared-types';
import { X } from 'lucide-react';
import {
  FilterChips,
  Pagination,
  SearchBox,
  useDebouncedValue,
  useSessionState,
  type ChipOption,
} from '../../components/list';
import { DATE_RANGES, formatWhen, movementLabel, rangeSinceIso, type DateRange, type MovementTone } from './movement-view';

type ReasonFilter = StockMovementReason | 'all';

const REASONS: ReadonlyArray<{ id: StockMovementReason; label: string }> = [
  { id: 'sale', label: 'Sales' },
  { id: 'delivery', label: 'Deliveries' },
  { id: 'waste', label: 'Waste' },
  { id: 'count', label: 'Stock takes' },
  { id: 'adjustment', label: 'Fixes & batches' },
  { id: 'transfer', label: 'Transfers' },
];

const TONE: Record<MovementTone, string> = {
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200',
  stone: 'bg-stone-200 text-stone-800 dark:bg-stone-700 dark:text-stone-200',
};

/**
 * Every change to stock, newest first: sales, deliveries, waste, stock
 * takes, batches. Paged in the database — a busy day writes a movement per
 * ingredient per order, so this list is far too long to load whole.
 */
export function MovementsTab({
  ingredient,
  onClearIngredient,
}: {
  /** Show one ingredient's history (opened from the Ingredients list). */
  ingredient?: Pick<Ingredient, 'id' | 'name'> | null;
  onClearIngredient?: () => void;
}) {
  const [only, setOnly] = useState<Pick<Ingredient, 'id' | 'name'> | null>(ingredient ?? null);
  useEffect(() => setOnly(ingredient ?? null), [ingredient]);

  const [search, setSearch] = useSessionState('inv.mv.q', '');
  const [reason, setReason] = useSessionState<ReasonFilter>('inv.mv.reason', 'all');
  const [range, setRange] = useSessionState<DateRange>('inv.mv.range', '7d');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useSessionState('inv.mv.size', 50);
  const debounced = useDebouncedValue(search.trim(), 250);

  // Any filter change starts again from the newest.
  useEffect(() => setPage(1), [debounced, reason, range, only?.id, pageSize]);

  const filters = {
    search: debounced || undefined,
    reason: reason === 'all' ? undefined : reason,
    ingredientId: only?.id,
    sinceIso: rangeSinceIso(range),
  };
  const q = useQuery({
    queryKey: ['inventory', 'movements', 'search', { ...filters, range, page, pageSize }],
    queryFn: () => ipc.inventory.searchMovements({ ...filters, offset: (page - 1) * pageSize, limit: pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const counts = q.data?.reasonCounts ?? {};
  const allCount = Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);
  const reasonOptions: ChipOption<ReasonFilter>[] = [
    { id: 'all', label: 'All', count: allCount },
    ...REASONS.filter((r) => r.id !== 'transfer' || (counts.transfer ?? 0) > 0 || reason === 'transfer').map((r) => ({
      id: r.id as ReasonFilter,
      label: r.label,
      count: counts[r.id] ?? 0,
    })),
  ];

  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rows = q.data?.rows ?? [];
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search ingredient, note, order number…"
          label="Search stock history"
        />
        <FilterChips
          label="When"
          options={DATE_RANGES.map((r) => ({ id: r.id, label: r.label }))}
          value={range}
          onChange={setRange}
        />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {only && (
          <span className="inline-flex h-9 items-center gap-1 rounded-full bg-amber-500 pl-3 pr-1 text-sm font-medium text-stone-900">
            Only {only.name}
            <button
              type="button"
              aria-label={`Show every ingredient, not just ${only.name}`}
              onClick={() => {
                setOnly(null);
                onClearIngredient?.();
              }}
              className="rounded-full p-1 hover:bg-black/10"
            >
              <X className="h-4 w-4" />
            </button>
          </span>
        )}
        <FilterChips label="What happened" options={reasonOptions} value={reason} onChange={setReason} />
      </div>

      <div className={cn('overflow-x-auto transition-opacity', q.isPlaceholderData && 'opacity-60')}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              <th className="pb-2">When</th>
              <th className="pb-2">What</th>
              <th className="pb-2">Ingredient</th>
              <th className="pb-2 text-right">Change</th>
              <th className="pb-2 text-right">Stock after</th>
              <th className="pb-2 pl-4">By</th>
              <th className="pb-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <MovementRow
                key={m.id}
                m={m}
                onPickIngredient={only ? undefined : () => setOnly({ id: m.ingredientId, name: m.ingredientName })}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-stone-500">
                  {q.isLoading ? (
                    'Loading…'
                  ) : (
                    <div className="space-y-2">
                      <div>
                        No stock changes {range === 'today' ? 'today' : range === 'all' ? 'yet' : 'in this time'}
                        {debounced || reason !== 'all' || only ? ' that match' : ''}.
                      </div>
                      {range !== 'all' && (
                        <Button variant="secondary" size="sm" onClick={() => setRange('all')}>
                          Look through all time
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        pageCount={pageCount}
        total={total}
        from={from}
        to={from === 0 ? 0 : from + rows.length - 1}
        onPage={(p) => setPage(Math.min(Math.max(1, p), pageCount))}
        pageSize={pageSize}
        onPageSize={setPageSize}
        noun={total === 1 ? 'change' : 'changes'}
      />
    </Card>
  );
}

function MovementRow({ m, onPickIngredient }: { m: StockMovementEntry; onPickIngredient?: () => void }) {
  const { label, tone } = movementLabel(m);
  const details = [
    m.orderNumber ? `Order #${m.orderNumber}` : null,
    m.refPurchaseOrderId && !(m.notes ?? '').startsWith('PO ') ? `PO ${m.purchaseOrderRef ?? m.refPurchaseOrderId.slice(0, 8)}` : null,
    m.notes,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <tr className="border-t border-stone-100 dark:border-stone-800">
      <td className="whitespace-nowrap py-2 pr-3 text-stone-500" title={new Date(m.occurredAt).toLocaleString()}>
        {formatWhen(m.occurredAt)}
      </td>
      <td className="py-2 pr-3">
        <span className={cn('whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium', TONE[tone])}>{label}</span>
      </td>
      <td className="py-2 pr-3 font-medium">
        {onPickIngredient ? (
          <button
            type="button"
            onClick={onPickIngredient}
            className="text-left hover:text-amber-700 hover:underline dark:hover:text-amber-300"
            title={`Show only ${m.ingredientName}`}
          >
            {m.ingredientName}
          </button>
        ) : (
          m.ingredientName
        )}
      </td>
      <td
        className={cn(
          'whitespace-nowrap py-2 text-right font-mono',
          m.deltaQty > 0 ? 'text-emerald-700 dark:text-emerald-300' : m.deltaQty < 0 ? 'text-red-700 dark:text-red-300' : 'text-stone-500',
        )}
      >
        {m.deltaQty > 0 ? '+' : ''}
        {formatQty(m.deltaQty, m.unit)}
      </td>
      <td className="whitespace-nowrap py-2 text-right font-mono text-stone-500">{formatQty(m.resultingQty, m.unit)}</td>
      <td className="whitespace-nowrap py-2 pl-4 text-stone-600 dark:text-stone-400">{m.actorName ?? '—'}</td>
      <td className="py-2 text-xs text-stone-500">{details}</td>
    </tr>
  );
}
