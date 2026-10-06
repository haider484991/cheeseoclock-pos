import { useEffect, useState } from 'react';
import type { MenuItem, Category } from '@cheeseoclock/shared-types';
import { BUY_1_GET_1_CLOSED_MESSAGE, BUY_1_GET_1_WINDOW, buy1Get1OpenAt, isBuy1Get1Category } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import { cn } from '@cheeseoclock/ui';
import { menuChoices, pizzaSize, type MenuChoice } from './pizzaChoices';

/** The clock, read again every 30 seconds: Buy 1 Get 1 tiles open at 1 PM and close at 7 PM by themselves. */
function useHalfMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

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
 * tile's size. A Buy 1 Get 1 deal outside its hours (1–7 PM) is greyed and
 * says so; the till refuses it there too (ipc/buy-1-get-1-hours.ts).
 */
export function ItemGrid({ items, categories, onAdd, onChooseSize }: Props) {
  const now = useHalfMinuteNow();
  const dealsOpen = buy1Get1OpenAt(now);
  const nameOf = new Map(categories.map((c) => [c.id, c.name] as const));
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
        const closed = !dealsOpen && isBuy1Get1Category(nameOf.get(item.categoryId) ?? '');
        return (
        <button
          key={choice.id}
          type="button"
          disabled={closed}
          title={closed ? BUY_1_GET_1_CLOSED_MESSAGE : undefined}
          onClick={() => choice.sizedPizza ? onChooseSize(choice) : onAdd(item)}
          // A tap adds the item without taking the keyboard away from the
          // search box, so the cashier can keep typing the next name.
          onMouseDown={(e) => e.preventDefault()}
          aria-label={
            closed
              ? `${choice.name}: ${BUY_1_GET_1_WINDOW} only`
              : choice.sizedPizza ? `Choose size for ${choice.name}` : `Add ${item.name}, ${formatCents(price)}`
          }
          aria-haspopup={choice.sizedPizza ? 'dialog' : undefined}
          className={cn('menu-tile', photo && 'has-photo', closed && 'menu-tile--closed')}
          style={{ '--cat': colourOf.get(item.categoryId) ?? '#a8a29e' } as React.CSSProperties}
        >
          {photo && (
            <img src={photo} alt="" className="menu-tile-photo" />
          )}
          <span className="menu-tile-name">{choice.name}</span>
          {choice.sizedPizza && <span className="menu-tile-sizes">{choice.variants.map(pizzaSize).join(' / ')}</span>}
          {closed && <span className="menu-tile-hours">{BUY_1_GET_1_WINDOW} only</span>}
          <span className="menu-tile-price">{choice.variants.length > 1 ? 'From ' : ''}{formatCents(price, { showSymbol: false })}</span>
        </button>
        );
      })}
    </div>
  );
}
