import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useDebouncedValue } from '../../components/list';
import { COSTING_KEY, useCanSeeCosts } from './costingQueries';
import { FoodCostChip } from './CostChip';
import { formatBps, noPriceText } from './costingFormat';

type Line = { ingredientId: string; qtyPerUnit: number; modifierId: string | null };

/**
 * The recipe editor's live footer (costing spec Phase 1): the recipe as
 * typed — not yet saved — costed at today's prices: "This costs Rs 388 to
 * make — 25.9% of its Rs 1,500 price". Only for logins that may see costs.
 */
export function RecipeCostFooter({ menuItemId, lines }: { menuItemId: string; lines: readonly Line[] }) {
  const canCost = useCanSeeCosts();
  // Debounced as text, so an unchanged recipe is the same value between renders.
  const typedText = useDebouncedValue(
    JSON.stringify(lines.filter((l) => l.ingredientId && l.qtyPerUnit > 0)),
    300,
  );
  const typed = useMemo(() => JSON.parse(typedText) as Line[], [typedText]);
  const q = useQuery({
    queryKey: [...COSTING_KEY, 'recipeCost', menuItemId, typed],
    queryFn: () => ipc.costing.recipeCost({ menuItemId, lines: typed }),
    enabled: canCost,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  if (!canCost) return null;
  const c = q.data;
  if (!c) return <div className="text-xs text-stone-400">Working out the cost…</div>;
  if (!c.hasRecipe) return <div className="text-xs text-stone-500">Add ingredients to see what it costs to make.</div>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
      {c.missingLines > 0 ? (
        <span className="text-stone-600 dark:text-stone-300">
          {noPriceText(c.missingIngredients)}: at least <b>{formatCents(c.costCents)}</b> to make.
        </span>
      ) : (
        <span className="text-stone-600 dark:text-stone-300">
          This costs <b className="text-stone-900 dark:text-stone-100">{formatCents(c.costCents)}</b> to make
          {c.foodCostBps !== null && (
            <>
              {' '}
              — {formatBps(c.foodCostBps)} of its {formatCents(c.priceCents)} price
            </>
          )}
          .
        </span>
      )}
      <FoodCostChip flag={c.flag} bps={c.foodCostBps} targetBps={c.targetBps} />
      {c.estimateLines > 0 && c.missingLines === 0 && <span className="text-xs text-amber-700 dark:text-amber-300">includes a guessed price</span>}
    </div>
  );
}
