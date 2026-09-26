/**
 * Building blocks shared by the Reports page sections: a section card with a
 * plain heading, a table that right-aligns money, a KPI tile with its change
 * against the comparison period, and a "show all" toggle.
 */
import { useState, type ReactNode } from 'react';
import { Card, cn } from '@cheeseoclock/ui';
import type { LucideIcon } from 'lucide-react';
import type { Change } from './reportFormat';

export function Section({
  id,
  icon: Icon,
  title,
  subtitle,
  action,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <Icon className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Panel({ title, note, children, className }: { title?: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('min-w-0', className)}>
      {title && <h3 className="mb-3 text-sm font-semibold tracking-tight text-stone-700 dark:text-stone-200">{title}</h3>}
      {children}
      {note && <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">{note}</p>}
    </Card>
  );
}

export interface Column {
  label: string;
  /** Right-align (numbers, money). */
  right?: boolean;
  className?: string;
}

export function DataTable({
  columns,
  rows,
  empty,
  footer,
}: {
  columns: Column[];
  rows: ReactNode[][];
  empty: string;
  /** A bold totals row. */
  footer?: ReactNode[];
}) {
  if (rows.length === 0) {
    return <p className="py-4 text-center text-sm text-stone-500 dark:text-stone-400">{empty}</p>;
  }
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-stone-500">
            {columns.map((c, i) => (
              <th key={i} className={cn('px-1 pb-2 font-semibold', c.right && 'text-right', c.className)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-stone-100 dark:border-stone-800">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={cn(
                    'px-1 py-2 align-top',
                    columns[ci]?.right && 'whitespace-nowrap text-right tabular-nums',
                    columns[ci]?.className,
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="border-t-2 border-stone-200 font-semibold dark:border-stone-700">
              {footer.map((cell, ci) => (
                <td
                  key={ci}
                  className={cn('px-1 py-2', columns[ci]?.right && 'whitespace-nowrap text-right tabular-nums', columns[ci]?.className)}
                >
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Whether a rise is good news (sales), bad news (refunds) or neither. */
export type GoodWhen = 'up' | 'down' | 'neutral';

/** "▲ 10% · was Rs 151,103" — the comparison period itself is named once, above the tiles. */
export function ChangeText({ change, goodWhen, was }: { change: Change; goodWhen: GoodWhen; was?: string }) {
  if (change.direction === 'none') return null;
  const good =
    goodWhen === 'neutral' || change.direction === 'flat'
      ? null
      : (change.direction === 'up') === (goodWhen === 'up');
  return (
    <span className="text-xs">
      <span
        className={cn(
          'font-semibold',
          good === null && 'text-stone-500 dark:text-stone-400',
          good === true && 'text-emerald-700 dark:text-emerald-400',
          good === false && (goodWhen === 'down' ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400'),
        )}
      >
        {change.text}
      </span>
      {was && <span className="text-stone-500 dark:text-stone-400"> · was {was}</span>}
    </span>
  );
}

export function Kpi({
  label,
  value,
  sub,
  change,
  goodWhen,
  was,
  big,
  loading,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  change?: Change;
  goodWhen?: GoodWhen;
  /** The comparison period's figure, formatted. */
  was?: string;
  big?: boolean;
  loading?: boolean;
}) {
  return (
    <Card className={cn('flex min-w-0 flex-col gap-1', big && 'ring-2 ring-amber-300/70 dark:ring-amber-700/60')}>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">{label}</div>
      {/* Never truncated: a number cut to "Rs 166,0…" is worse than no number. */}
      <div
        className={cn(
          'break-words font-bold tabular-nums tracking-tight',
          big ? 'text-4xl' : 'text-3xl',
          loading && 'text-stone-300 dark:text-stone-700',
        )}
      >
        {value}
      </div>
      {change && goodWhen && <ChangeText change={change} goodWhen={goodWhen} was={was} />}
      {sub && <div className="text-xs text-stone-500 dark:text-stone-400">{sub}</div>}
    </Card>
  );
}

/** First `limit` rows, and a button to see the rest. */
export function useShowAll<T>(rows: T[], limit: number): { shown: T[]; toggle: ReactNode } {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, limit);
  const toggle =
    rows.length > limit ? (
      <button
        type="button"
        onClick={() => setAll((v) => !v)}
        className="mt-2 w-full rounded-lg py-2 text-sm font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
      >
        {all ? 'Show fewer' : `Show all ${rows.length}`}
      </button>
    ) : null;
  return { shown, toggle };
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-xl px-4 py-3 text-sm',
        tone === 'info' && 'bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
        tone === 'warn' && 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
      )}
    >
      {children}
    </div>
  );
}
