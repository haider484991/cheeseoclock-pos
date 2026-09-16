import type { MenuItem, Category } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import { cn } from '@cheeseoclock/ui';

interface Props {
  items: MenuItem[];
  categories: Category[];
  onAdd: (item: MenuItem) => void;
}

/**
 * The menu as a cashier reads it: name and price, five across, every tile the
 * same height so the eye can scan rows. The category's colour is a thin bar,
 * not a fill — a menu of eighty items must not be eighty coloured blocks. A
 * photo, when the shop has one, sits small at the side; it never decides the
 * tile's size.
 */
export function ItemGrid({ items, categories, onAdd }: Props) {
  if (items.length === 0) {
    return (
      <div className="menu-empty">
        <p>No items here yet.</p>
        <p>Add them under Menu, or pick another category.</p>
      </div>
    );
  }
  const colourOf = new Map(categories.map((c) => [c.id, c.colorHex] as const));
  return (
    <div className="menu-grid" role="list">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="listitem"
          onClick={() => onAdd(item)}
          aria-label={`Add ${item.name}, ${formatCents(item.basePriceCents)}`}
          className={cn('menu-tile', item.imageUrl && 'has-photo')}
          style={{ '--cat': colourOf.get(item.categoryId) ?? '#a8a29e' } as React.CSSProperties}
        >
          {item.imageUrl && (
            <img src={item.imageUrl} alt="" className="menu-tile-photo" />
          )}
          <span className="menu-tile-name">{item.name}</span>
          <span className="menu-tile-price">{formatCents(item.basePriceCents, { showSymbol: false })}</span>
        </button>
      ))}
    </div>
  );
}
