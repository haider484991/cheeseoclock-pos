import type { MenuItem, Category } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import { cn } from '@cheeseoclock/ui';
import { menuChoices, pizzaSize, type MenuChoice } from './pizzaChoices';

interface Props {
  items: MenuItem[];
  categories: Category[];
  onAdd: (item: MenuItem) => void;
  onChooseSize: (choice: MenuChoice) => void;
}

/**
 * The menu as a cashier reads it: name and price, five across, every tile the
 * same height so the eye can scan rows. The category's colour is a thin bar,
 * not a fill — a menu of eighty items must not be eighty coloured blocks. A
 * photo, when the shop has one, sits small at the side; it never decides the
 * tile's size.
 */
export function ItemGrid({ items, categories, onAdd, onChooseSize }: Props) {
  const choices = menuChoices(items, categories);
  if (choices.length === 0) {
    return (
      <div className="menu-empty">
        <p>No items here yet.</p>
        <p>Add them under Menu, or pick another category.</p>
      </div>
    );
  }
  const colourOf = new Map(categories.map((c) => [c.id, c.colorHex] as const));
  return (
    <div className="menu-grid" role="group" aria-label="Menu items">
      {choices.map((choice) => {
        const item = choice.variants[0]!;
        const price = Math.min(...choice.variants.map((variant) => variant.basePriceCents));
        const photo = choice.variants.find((variant) => variant.imageUrl)?.imageUrl;
        return (
        <button
          key={choice.id}
          type="button"
          onClick={() => choice.sizedPizza ? onChooseSize(choice) : onAdd(item)}
          aria-label={choice.sizedPizza ? `Choose size for ${choice.name}` : `Add ${item.name}, ${formatCents(price)}`}
          aria-haspopup={choice.sizedPizza ? 'dialog' : undefined}
          className={cn('menu-tile', photo && 'has-photo')}
          style={{ '--cat': colourOf.get(item.categoryId) ?? '#a8a29e' } as React.CSSProperties}
        >
          {photo && (
            <img src={photo} alt="" className="menu-tile-photo" />
          )}
          <span className="menu-tile-name">{choice.name}</span>
          {choice.sizedPizza && <span className="menu-tile-sizes">{choice.variants.map(pizzaSize).join(' / ')}</span>}
          <span className="menu-tile-price">{choice.variants.length > 1 ? 'From ' : ''}{formatCents(price, { showSymbol: false })}</span>
        </button>
        );
      })}
    </div>
  );
}
