import { cn } from '@cheeseoclock/ui';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

/**
 * A table header you can tap to sort by that column. The screen owns which
 * column and which way; this only draws it and says so to screen readers.
 */
export function SortHeader({
  label,
  active,
  direction = 'asc',
  onClick,
  align = 'left',
  className,
}: {
  label: string;
  active: boolean;
  direction?: 'asc' | 'desc';
  onClick: () => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className={cn('pb-2', align === 'right' && 'text-right', className)}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider hover:text-stone-900 dark:hover:text-stone-100',
          align === 'right' && 'flex-row-reverse',
          active && 'text-stone-900 dark:text-stone-100',
        )}
      >
        {label}
        <Icon className={cn('h-3 w-3', !active && 'opacity-40')} />
      </button>
    </th>
  );
}
