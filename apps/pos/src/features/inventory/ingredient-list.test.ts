import { describe, expect, it } from 'vitest';
import type { Ingredient } from '@cheeseoclock/shared-types';
import {
  compareIngredients,
  ingredientSearchText,
  matchesStockFilter,
  nextSort,
  suggestReorderQty,
} from './ingredient-list';
import { matchesSearch } from '../../components/list/list-query';

// Made-up numbers: the repo is public, so no real supplier costs here.
function ing(p: Partial<Ingredient> & { name: string }): Ingredient {
  return {
    id: p.name as Ingredient['id'],
    category: 'other',
    categoryAuto: true,
    unit: 'g',
    currentQty: 1000,
    lowThreshold: 100,
    costPerUnitCents: 10,
    packSize: null,
    packPriceCents: null,
    batchYield: null,
    batchMethod: null,
    defaultSupplierId: null,
    sku: null,
    notes: null,
    isActive: true,
    ...p,
  };
}

const list = [
  ing({ name: 'Onion', currentQty: 5000, lowThreshold: 1000, costPerUnitCents: 1 }), // fine, worth 5,000
  ing({ name: 'cheddar', currentQty: 0, lowThreshold: 500, costPerUnitCents: 100 }), // out, worth 0
  ing({ name: 'Basil', currentQty: 50, lowThreshold: 100, costPerUnitCents: 20 }), // low, worth 1,000
  ing({ name: 'Box 10', currentQty: 300, lowThreshold: 0, unit: 'pcs', costPerUnitCents: 50 }), // fine, worth 15,000
  ing({ name: 'Box 2', currentQty: 300, lowThreshold: 0, unit: 'pcs', costPerUnitCents: 50 }), // fine, worth 15,000
];
const names = (xs: Ingredient[]) => xs.map((x) => x.name);

describe('compareIngredients', () => {
  it('sorts by name the way people read', () => {
    expect(names([...list].sort(compareIngredients({ key: 'name', dir: 'asc' })))).toEqual([
      'Basil',
      'Box 2',
      'Box 10',
      'cheddar',
      'Onion',
    ]);
    expect(names([...list].sort(compareIngredients({ key: 'name', dir: 'desc' })))[0]).toBe('Onion');
  });

  it('puts the most urgent stock first', () => {
    expect(names([...list].sort(compareIngredients({ key: 'stock', dir: 'asc' }))).slice(0, 2)).toEqual([
      'cheddar',
      'Basil',
    ]);
  });

  it('sorts by stock value, name breaking ties A–Z either way', () => {
    expect(names([...list].sort(compareIngredients({ key: 'value', dir: 'desc' })))).toEqual([
      'Box 2',
      'Box 10',
      'Onion',
      'Basil',
      'cheddar',
    ]);
  });
});

describe('nextSort', () => {
  it('flips the same column and starts a new one its natural way', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'value')).toEqual({ key: 'value', dir: 'desc' });
    expect(nextSort({ key: 'value', dir: 'desc' }, 'stock')).toEqual({ key: 'stock', dir: 'asc' });
  });
});

describe('matchesStockFilter', () => {
  it('counts out-of-stock as low too', () => {
    expect(names(list.filter((i) => matchesStockFilter(i, 'low')))).toEqual(['cheddar', 'Basil']);
    expect(names(list.filter((i) => matchesStockFilter(i, 'out')))).toEqual(['cheddar']);
    expect(list.filter((i) => matchesStockFilter(i, 'all'))).toHaveLength(5);
  });
});

describe('ingredientSearchText', () => {
  it('finds an ingredient by its category, supplier or SKU', () => {
    const moz = ing({ name: 'Mozzarella', category: 'cheese', sku: 'MZ-01' });
    const text = ingredientSearchText(moz, 'Test Dairy Co');
    expect(matchesSearch(text, 'dairy')).toBe(true);
    expect(matchesSearch(text, 'test co')).toBe(true);
    expect(matchesSearch(text, 'mz 01')).toBe(true);
    expect(matchesSearch(text, 'beef')).toBe(false);
  });
  it('finds made-in-house batches', () => {
    expect(matchesSearch(ingredientSearchText(ing({ name: 'Pizza Sauce', batchYield: 5000 }), undefined), 'batch')).toBe(
      true,
    );
  });
});

describe('suggestReorderQty', () => {
  it('fills up to three times the low level', () => {
    expect(suggestReorderQty({ currentQty: 200, lowThreshold: 500, packSize: null })).toBe(1300);
    expect(suggestReorderQty({ currentQty: -100, lowThreshold: 500, packSize: null })).toBe(1500);
  });
  it('rounds up to whole packs', () => {
    expect(suggestReorderQty({ currentQty: 200, lowThreshold: 500, packSize: 1000 })).toBe(2000);
  });
  it('always suggests something', () => {
    expect(suggestReorderQty({ currentQty: 5000, lowThreshold: 0, packSize: null })).toBe(1);
    expect(suggestReorderQty({ currentQty: 5000, lowThreshold: 0, packSize: 12 })).toBe(12);
  });
});
