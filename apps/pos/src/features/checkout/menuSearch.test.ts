import { describe, expect, it } from 'vitest';
import type { Category, MenuItem } from '@cheeseoclock/shared-types';
import { searchMenu } from './menuSearch';

const categories = [
  { id: 'pizza', name: 'Pizza' },
  { id: 'drinks', name: 'Drinks' },
  { id: 'sides', name: 'Sides' },
] as Category[];
const item = (id: string, name: string, categoryId: string, description: string | null = null) =>
  ({ id, name, categoryId, description, basePriceCents: 10_000 }) as MenuItem;

const menu = [
  item('1', 'Chicken Tikka — Medium', 'pizza', 'Tikka chunks, onion'),
  item('2', 'Chicken Fajita — Large', 'pizza'),
  item('3', 'Soft Drink 500ml', 'drinks'),
  item('4', 'Garlic Bread', 'sides', 'With cheese'),
  item('5', 'Cheese Sticks', 'sides'),
  item('6', 'Tikka Wings', 'sides'),
];

const ids = (list: MenuItem[]) => list.map((i) => i.id);

describe('searchMenu', () => {
  it('returns the whole menu for an empty search', () => {
    expect(ids(searchMenu(menu, categories, '  '))).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('needs every word, in any order, ignoring case and dashes', () => {
    expect(ids(searchMenu(menu, categories, 'fajita large'))).toEqual(['2']);
    expect(ids(searchMenu(menu, categories, 'LARGE chicken'))).toEqual(['2']);
    expect(ids(searchMenu(menu, categories, 'tikka-medium'))).toEqual(['1']);
  });

  it('searches descriptions and category names too', () => {
    expect(ids(searchMenu(menu, categories, 'drinks'))).toEqual(['3']);
    expect(ids(searchMenu(menu, categories, 'onion'))).toEqual(['1']);
  });

  it('puts names that start with the search first', () => {
    // "Cheese Sticks" starts with it; "Garlic Bread" only mentions cheese.
    expect(ids(searchMenu(menu, categories, 'chees'))).toEqual(['5', '4']);
    // Tikka Wings starts with "tikka"; Chicken Tikka has it as a later word.
    expect(ids(searchMenu(menu, categories, 'tikka'))).toEqual(['6', '1']);
  });

  it('finds nothing for a word that is nowhere', () => {
    expect(searchMenu(menu, categories, 'sushi')).toEqual([]);
  });
});
