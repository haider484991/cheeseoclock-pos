import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, cn } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import type { StockMovementReason } from '@cheeseoclock/shared-types';

const REASONS: Array<{ id: StockMovementReason | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'sale', label: 'Sales' },
  { id: 'delivery', label: 'Deliveries' },
  { id: 'waste', label: 'Waste' },
  { id: 'count', label: 'Stock takes' },
  { id: 'adjustment', label: 'Adjustments' },
];

const REASON_COLOR: Record<StockMovementReason, string> = {
  sale: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  delivery: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  waste: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  count: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  transfer: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200',
  adjustment: 'bg-stone-200 text-stone-800 dark:bg-stone-700 dark:text-stone-200',
};

export function MovementsTab() {
  const [reasonFilter, setReasonFilter] = useState<StockMovementReason | 'all'>('all');
  const movementsQ = useQuery({
    queryKey: ['inventory', 'movements', reasonFilter],
    queryFn: () =>
      ipc.inventory.listMovements({
        ...(reasonFilter !== 'all' ? { reason: reasonFilter } : {}),
        limit: 200,
      }),
    refetchInterval: 30_000,
  });
  const ingredientsQ = useQuery({
    queryKey: ['inventory', 'ingredients', 'all'],
    queryFn: () => ipc.inventory.listIngredients(),
  });
  const ingredient = (id: string) => ingredientsQ.data?.find((i) => i.id === id);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {REASONS.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setReasonFilter(r.id)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-semibold',
              reasonFilter === r.id
                ? 'bg-amber-500 text-stone-900'
                : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-2">When</th>
            <th className="pb-2">Reason</th>
            <th className="pb-2">Ingredient</th>
            <th className="pb-2 text-right">Change</th>
            <th className="pb-2 text-right">After</th>
            <th className="pb-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {(movementsQ.data ?? []).map((m) => {
            const ing = ingredient(m.ingredientId);
            return (
              <tr key={m.id} className="border-t border-stone-100 dark:border-stone-800">
                <td className="py-2 text-stone-500">
                  {new Date(m.occurredAt).toLocaleString()}
                </td>
                <td className="py-2">
                  <span className={cn('rounded px-2 py-0.5 text-xs', REASON_COLOR[m.reason])}>
                    {m.reason}
                  </span>
                </td>
                <td className="py-2 font-medium">{ing?.name ?? m.ingredientId.slice(0, 8)}</td>
                <td
                  className={cn(
                    'py-2 text-right font-mono',
                    m.deltaQty > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300',
                  )}
                >
                  {m.deltaQty > 0 ? '+' : ''}
                  {m.deltaQty} {ing?.unit ?? ''}
                </td>
                <td className="py-2 text-right font-mono text-stone-500">
                  {m.resultingQty} {ing?.unit ?? ''}
                </td>
                <td className="py-2 text-xs text-stone-500">{m.notes ?? ''}</td>
              </tr>
            );
          })}
          {(!movementsQ.data || movementsQ.data.length === 0) && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-stone-500">
                No movements yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}
