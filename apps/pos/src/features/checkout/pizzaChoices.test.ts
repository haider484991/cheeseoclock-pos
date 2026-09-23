import { describe, expect, it } from 'vitest';
import type { Category, MenuItem } from '@cheeseoclock/shared-types';
import { menuChoices } from './pizzaChoices';

const categories = [
  { id: 'pizza', name: 'Pizza' }, { id: 'signature', name: 'Signature Pizzas' }, { id: 'sides', name: 'Sides' },
] as Category[];
const item = (id: string, name: string, categoryId = 'pizza', basePriceCents = 170000) =>
  ({ id, name, categoryId, basePriceCents }) as MenuItem;

describe('pizza size choices', () => {
  it('shows one flavour while retaining the exact size IDs and prices', () => {
    const medium = item('m', 'Fajita — Medium');
    const large = item('l', 'Fajita — Large', 'pizza', 200000);
    const choices = menuChoices([large, item('s', 'Fajita — Small'), medium], categories);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.name).toBe('Fajita');
    expect(choices[0]?.variants).toEqual([medium, large]);
  });
  it('never combines different categories or removes sizes from non-pizza products', () => {
    const choices = menuChoices([
      item('p', 'Cheese — Large'), item('s', 'Cheese — Large', 'signature'),
      item('f1', 'Fries — Small', 'sides'), item('f2', 'Fries — Large', 'sides'),
    ], categories);
    expect(choices).toHaveLength(4);
    expect(choices[2]?.name).toBe('Fries — Small');
    expect(choices[2]?.sizedPizza).toBe(false);
  });
  it('keeps large-only signature pizzas and unsized items available without inventing variants', () => {
    const large = item('c', 'Crown Crust — Large', 'signature', 220000);
    const choices = menuChoices([large, item('u', 'Pizza special')], categories);
    expect(choices[0]?.variants).toEqual([large]);
    expect(choices[1]?.sizedPizza).toBe(false);
  });
});
