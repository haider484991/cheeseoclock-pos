import { cn } from '@cheeseoclock/ui';
import type { FoodCostFlag } from '@cheeseoclock/shared-types';
import { FLAG_LABEL, formatBps } from './costingFormat';

const TONE: Record<FoodCostFlag, string> = {
  green: 'bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900',
  amber: 'bg-amber-100 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900',
  red: 'bg-red-100 text-red-800 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900',
  grey: 'bg-stone-100 text-stone-500 ring-stone-200 dark:bg-stone-800 dark:text-stone-400 dark:ring-stone-700',
  neutral: 'bg-white text-stone-700 ring-stone-300 dark:bg-stone-900 dark:text-stone-200 dark:ring-stone-600',
  nonfood: 'bg-transparent text-stone-400 ring-transparent',
};

/**
 * The food-cost chip: the % in the colour of its target (green on target,
 * amber close, red over), uncoloured while the target is only a suggestion,
 * grey when the item can't be costed yet.
 */
export function FoodCostChip({
  flag,
  bps,
  targetBps,
  className,
}: {
  flag: FoodCostFlag;
  bps: number | null;
  targetBps?: number;
  className?: string;
}) {
  const text = flag === 'grey' ? "can't cost" : flag === 'nonfood' ? '—' : formatBps(bps);
  const title =
    flag === 'nonfood'
      ? 'Not food: no food cost'
      : `${FLAG_LABEL[flag]}${targetBps !== undefined && flag !== 'grey' ? ` (target ${formatBps(targetBps)})` : ''}`;
  return (
    <span
      title={title}
      className={cn(
        'inline-flex min-w-[4.25rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1',
        TONE[flag],
        className,
      )}
    >
      {text}
    </span>
  );
}
