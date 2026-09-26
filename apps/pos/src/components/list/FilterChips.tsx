import { cn } from '@cheeseoclock/ui';

export type ChipTone = 'default' | 'amber' | 'red' | 'green' | 'blue';

export interface ChipOption<T extends string> {
  id: T;
  label: string;
  /** Shown as a small number; a chip with 0 is dimmed but can still be picked. */
  count?: number;
  tone?: ChipTone;
}

const ACTIVE: Record<ChipTone, string> = {
  default: 'bg-stone-900 text-white ring-stone-900 dark:bg-amber-500 dark:text-stone-900 dark:ring-amber-500',
  amber: 'bg-amber-500 text-stone-900 ring-amber-500',
  red: 'bg-red-600 text-white ring-red-600',
  green: 'bg-emerald-600 text-white ring-emerald-600',
  blue: 'bg-blue-600 text-white ring-blue-600',
};

function chipClass(active: boolean, tone: ChipTone, empty: boolean): string {
  return cn(
    'inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-medium ring-1 transition-colors',
    active
      ? ACTIVE[tone]
      : 'bg-white text-stone-700 ring-stone-200 hover:bg-stone-50 hover:ring-stone-300 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-700 dark:hover:bg-stone-700',
    !active && empty && 'opacity-50',
  );
}

function Count({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={cn(
        'min-w-[1.5rem] rounded-full px-1.5 text-center text-xs font-semibold tabular-nums',
        active ? 'bg-black/15 dark:bg-black/20' : 'bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-300',
      )}
    >
      {n}
    </span>
  );
}

/** A row of chips where exactly one is picked ("All", "Cheese & Dairy (11)", …). */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: ReadonlyArray<ChipOption<T>>;
  value: T;
  onChange: (id: T) => void;
  /** Accessible name for the group, e.g. "Category". */
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            className={chipClass(active, o.tone ?? 'default', o.count === 0)}
          >
            {o.label}
            {o.count !== undefined && <Count n={o.count} active={active} />}
          </button>
        );
      })}
    </div>
  );
}

/** One on/off chip ("Low stock 12"). */
export function ToggleChip({
  active,
  onChange,
  label,
  count,
  tone = 'amber',
  icon,
}: {
  active: boolean;
  onChange: (active: boolean) => void;
  label: string;
  count?: number;
  tone?: ChipTone;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onChange(!active)}
      className={chipClass(active, tone, count === 0)}
    >
      {icon}
      {label}
      {count !== undefined && <Count n={count} active={active} />}
    </button>
  );
}
