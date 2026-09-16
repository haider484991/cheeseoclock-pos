import type { Category } from '@cheeseoclock/shared-types';
import { cn } from '@cheeseoclock/ui';

interface Props {
  categories: Category[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/** One row of category tabs; the colour dot is the same colour as the tile bar. */
export function CategoryRail({ categories, selectedId, onSelect }: Props) {
  return (
    <nav className="menu-tabs" aria-label="Menu categories">
      <button
        type="button"
        aria-pressed={selectedId === null}
        onClick={() => onSelect(null)}
        className={cn('menu-tab', selectedId === null && 'is-active')}
      >
        All
      </button>
      {categories.map((c) => {
        const active = selectedId === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            aria-pressed={active}
            className={cn('menu-tab', active && 'is-active')}
          >
            <span className="menu-tab-dot" style={{ background: c.colorHex }} aria-hidden="true" />
            {c.name}
          </button>
        );
      })}
    </nav>
  );
}
