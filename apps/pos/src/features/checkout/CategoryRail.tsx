import type { Category } from '@cheeseoclock/shared-types';
import { cn } from '@cheeseoclock/ui';

interface Props {
  categories: Category[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function CategoryRail({ categories, selectedId, onSelect }: Props) {
  return (
    <nav className="checkout-categories" aria-label="Menu categories">
      <button type="button" aria-pressed={selectedId === null} onClick={() => onSelect(null)} className={cn('checkout-category', selectedId === null && 'is-active')}>All items</button>
      {categories.map((c) => {
        const active = selectedId === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            aria-pressed={active}
            className={cn(
              'checkout-category', active && 'is-active',
            )}
          >
            <span
              className={cn(
                'absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full transition-all',
                active ? 'h-8 w-1' : 'h-4 w-0.5',
              )}
              style={{ background: c.colorHex }}
              aria-hidden
            />
            <span className="ml-2 block leading-tight">{c.name}</span>
          </button>
        );
      })}
      {categories.length === 0 && (
        <div className="mt-4 text-center text-xs text-stone-500">No categories yet</div>
      )}
    </nav>
  );
}
