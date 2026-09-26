import { useMemo } from 'react';
import { cn } from '@cheeseoclock/ui';
import { INGREDIENT_CATEGORIES } from '@cheeseoclock/pos-domain';
import type { Ingredient } from '@cheeseoclock/shared-types';
import { compareText } from '../../components/list';

/**
 * An ingredient pick grouped by shelf ("Cheese & Dairy", "Sauces & Dips"…),
 * A–Z inside each, so 120+ ingredients are findable in a plain drop-down.
 * Typing the first letters still jumps, as in any select.
 */
export function IngredientSelect({
  ingredients,
  value,
  onChange,
  placeholder = '— Pick an ingredient —',
  excludeIds,
  className,
  label = 'Ingredient',
}: {
  ingredients: readonly Ingredient[] | undefined;
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  /** Hidden from the list (e.g. the batch's own ingredient) unless it is the current value. */
  excludeIds?: ReadonlySet<string>;
  className?: string;
  label?: string;
}) {
  const groups = useMemo(() => {
    const visible = (ingredients ?? []).filter((i) => i.id === value || !excludeIds?.has(i.id));
    return INGREDIENT_CATEGORIES.map((c) => ({
      label: c.label,
      items: visible.filter((i) => i.category === c.id).sort((a, b) => compareText(a.name, b.name)),
    })).filter((g) => g.items.length > 0);
  }, [ingredients, excludeIds, value]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className={cn(
        'rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800',
        !value && 'text-stone-500',
        className,
      )}
    >
      <option value="">{placeholder}</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((i) => (
            <option key={i.id} value={i.id} className="text-stone-900 dark:text-stone-100">
              {i.name} ({i.unit})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
