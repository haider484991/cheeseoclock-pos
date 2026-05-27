import type { Category } from '@cheeseoclock/shared-types';
import { cn } from '@cheeseoclock/ui';

interface Props {
  categories: Category[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function CategoryRail({ categories, selectedId, onSelect }: Props) {
  return (
    <aside className="flex w-44 flex-col gap-1.5 overflow-auto border-r border-stone-200/70 bg-white/60 p-3 backdrop-blur-md dark:border-stone-800/70 dark:bg-stone-900/60">
      {categories.map((c) => {
        const active = selectedId === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={cn(
              'group relative overflow-hidden rounded-xl px-3 py-3 text-left text-sm font-semibold transition-all',
              active
                ? 'bg-white shadow-soft-md ring-1 ring-stone-200/80 dark:bg-stone-800 dark:ring-stone-700'
                : 'bg-transparent hover:bg-white/70 dark:hover:bg-stone-800/60',
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
    </aside>
  );
}
