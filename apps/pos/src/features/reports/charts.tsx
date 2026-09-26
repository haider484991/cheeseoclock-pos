/**
 * Small, dependency-free charts for the Reports page. Plain divs rather than
 * a stretched SVG: bars stay crisp at any width, labels stay readable, and
 * every bar carries its exact figure in a tooltip and in the table beside it.
 */
import { cn } from '@cheeseoclock/ui';

export interface ColumnBar {
  key: string;
  /** Short label under the bar ("8 pm", "26"). */
  label: string;
  /** Tooltip, e.g. "Sat 26 Sep: Rs 3,174 · 6 orders". */
  title: string;
  value: number;
}

/**
 * Vertical bars. The tallest bar is picked out in a stronger colour so the
 * busiest hour / best day jumps out. Labels thin out when there are many bars.
 */
export function ColumnChart({
  bars,
  ariaLabel,
  height = 'h-44',
}: {
  bars: ColumnBar[];
  ariaLabel: string;
  height?: string;
}) {
  if (bars.length === 0) return null;
  const max = Math.max(...bars.map((b) => b.value), 1);
  const best = bars.reduce((m, b, i) => (b.value > (bars[m]?.value ?? -Infinity) ? i : m), 0);
  const labelEvery = bars.length <= 16 ? 1 : Math.ceil(bars.length / 12);
  return (
    <div role="img" aria-label={ariaLabel}>
      <div className={cn('flex items-end gap-[3px] border-b border-stone-200 dark:border-stone-700', height)}>
        {bars.map((b, i) => {
          const pct = b.value > 0 ? Math.max((b.value / max) * 100, 1.5) : 0;
          return (
            <div key={b.key} className="group flex h-full min-w-0 flex-1 flex-col justify-end" title={b.title}>
              <div
                className={cn(
                  'w-full rounded-t-[3px] transition-colors',
                  i === best && b.value > 0
                    ? 'bg-amber-500 dark:bg-amber-400'
                    : 'bg-amber-200 group-hover:bg-amber-300 dark:bg-amber-900/70 dark:group-hover:bg-amber-700',
                )}
                style={{ height: `${pct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[3px]">
        {bars.map((b, i) => (
          <div key={b.key} className="min-w-0 flex-1 truncate text-center text-[10px] tabular-nums text-stone-500">
            {i % labelEvery === 0 ? b.label : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A thin share-of-total bar for table rows. */
export function ShareBar({ value, total, tone = 'amber' }: { value: number; total: number; tone?: 'amber' | 'emerald' | 'sky' }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800" aria-hidden>
      <div
        className={cn(
          'h-full rounded-full',
          tone === 'amber' && 'bg-amber-400',
          tone === 'emerald' && 'bg-emerald-500',
          tone === 'sky' && 'bg-sky-500',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
