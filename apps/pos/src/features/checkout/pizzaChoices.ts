import type { Category, MenuItem } from '@cheeseoclock/shared-types';

export interface MenuChoice {
  id: string;
  name: string;
  variants: MenuItem[];
  sizedPizza: boolean;
}

export function pizzaSize(item: MenuItem): 'Medium' | 'Large' | null {
  const size = item.name.match(/\s+[—–-]\s*(Medium|Large)$/i)?.[1];
  return size ? (size.toLowerCase() === 'medium' ? 'Medium' : 'Large') : null;
}

/** Keep the actual menu IDs: each size has its own price, recipe and receipt name. */
export function menuChoices(items: MenuItem[], categories: Category[]): MenuChoice[] {
  const pizzaCategories = new Set(categories.filter((c) => /\bpizzas?\b/i.test(c.name)).map((c) => c.id));
  const choices = new Map<string, MenuChoice>();
  for (const item of items) {
    const isPizza = pizzaCategories.has(item.categoryId);
    if (isPizza && /\s+[—–-]\s*Small$/i.test(item.name)) continue;
    const sizedPizza = isPizza && pizzaSize(item) !== null;
    const name = sizedPizza ? item.name.replace(/\s+[—–-]\s*(Medium|Large)$/i, '').trim() : item.name;
    const key = sizedPizza ? `${item.categoryId}:${name.toLowerCase()}` : item.id;
    const existing = choices.get(key);
    if (existing) existing.variants.push(item);
    else choices.set(key, { id: key, name, variants: [item], sizedPizza });
  }
  for (const choice of choices.values()) {
    choice.variants.sort((a, b) => (pizzaSize(a) === 'Medium' ? 0 : 1) - (pizzaSize(b) === 'Medium' ? 0 : 1));
  }
  return [...choices.values()];
}
