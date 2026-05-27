import type { MenuItem } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import { cn } from '@cheeseoclock/ui';
import { Plus } from 'lucide-react';

interface Props {
  items: MenuItem[];
  onAdd: (item: MenuItem) => void;
}

/**
 * Touch-friendly menu item grid. Each tile:
 *   - Square photo area (image if set, else a colored gradient with the first letter).
 *   - Item name + description below.
 *   - Price pill in the corner.
 *   - Hover lift + scale on tap.
 */
export function ItemGrid({ items, onAdd }: Props) {
  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-stone-100 text-stone-400 dark:bg-stone-800">
            <Plus className="h-7 w-7" />
          </div>
          <div className="text-sm font-medium text-stone-500">No items in this category</div>
          <div className="mt-1 text-xs text-stone-400">Add some in the Menu page.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
      {items.map((item) => (
        <ItemTile key={item.id} item={item} onAdd={() => onAdd(item)} />
      ))}
    </div>
  );
}

function ItemTile({ item, onAdd }: { item: MenuItem; onAdd: () => void }) {
  const initial = item.name.trim().charAt(0).toUpperCase() || '·';
  const tone = pickTone(item.id);

  return (
    <button
      type="button"
      onClick={onAdd}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl bg-white text-left shadow-soft ring-1 ring-stone-200/60 transition-all',
        'hover:-translate-y-0.5 hover:shadow-soft-md hover:ring-amber-300',
        'active:translate-y-0 active:shadow-soft-sm',
        'dark:bg-stone-900 dark:ring-stone-800/80',
      )}
    >
      {/* Photo / fallback */}
      <div className="relative aspect-[5/4] w-full overflow-hidden">
        {item.imageUrl ? (
          /* eslint-disable-next-line jsx-a11y/alt-text */
          <img
            src={item.imageUrl}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div
            className={cn(
              'flex h-full w-full items-center justify-center bg-gradient-to-br text-5xl font-bold text-white/90',
              tone,
            )}
          >
            {initial}
          </div>
        )}
        {/* Price pill */}
        <div className="absolute bottom-2 right-2 rounded-full bg-white/95 px-2.5 py-1 text-xs font-bold text-stone-900 shadow-soft-sm backdrop-blur dark:bg-stone-900/95 dark:text-stone-100">
          {formatCents(item.basePriceCents)}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-0.5 p-3">
        <div className="line-clamp-1 text-sm font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          {item.name}
        </div>
        {item.description && (
          <div className="line-clamp-2 text-[11px] leading-tight text-stone-500">
            {item.description}
          </div>
        )}
      </div>

      {/* Plus indicator on hover */}
      <div className="pointer-events-none absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-amber-500 text-stone-900 opacity-0 shadow-lift transition-opacity group-hover:opacity-100">
        <Plus className="h-4 w-4" />
      </div>
    </button>
  );
}

/** Deterministic gradient color per item id — same item always renders the same tone. */
function pickTone(id: string): string {
  const tones = [
    'from-amber-400 to-orange-500',
    'from-rose-400 to-pink-500',
    'from-emerald-400 to-teal-500',
    'from-sky-400 to-blue-500',
    'from-violet-400 to-purple-500',
    'from-fuchsia-400 to-pink-500',
    'from-lime-400 to-green-500',
    'from-stone-400 to-stone-600',
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return tones[Math.abs(hash) % tones.length]!;
}
