import { describe, expect, it } from 'vitest';
import {
  compareText,
  countBy,
  matchesSearch,
  normalizeSearchText,
  paginate,
  searchWords,
  withinOneEdit,
} from './list-query';

describe('normalizeSearchText', () => {
  it('drops case, accents and punctuation', () => {
    expect(normalizeSearchText('Jalapeño (Sliced)!')).toBe('jalapeno sliced');
    expect(normalizeSearchText('  F1   Foil-Tray ')).toBe('f1 foil tray');
    expect(normalizeSearchText('')).toBe('');
  });
  it('splits a search box into words', () => {
    expect(searchWords('  Pizza   BOX ')).toEqual(['pizza', 'box']);
    expect(searchWords('   ')).toEqual([]);
  });
});

describe('withinOneEdit', () => {
  it('allows one added, dropped, changed or swapped letter', () => {
    expect(withinOneEdit('chedar', 'cheddar')).toBe(true); // dropped
    expect(withinOneEdit('mozzzarella', 'mozzarella')).toBe(true); // added
    expect(withinOneEdit('sause', 'sauce')).toBe(true); // changed
    expect(withinOneEdit('onoin', 'onion')).toBe(true); // swapped
    expect(withinOneEdit('same', 'same')).toBe(true);
  });
  it('refuses two', () => {
    expect(withinOneEdit('chdar', 'cheddar')).toBe(false);
    expect(withinOneEdit('abcd', 'badc')).toBe(false);
    expect(withinOneEdit('milk', 'mint')).toBe(false);
  });
});

describe('matchesSearch', () => {
  const row = 'Mozzarella (Accha) · Cheese & Dairy · Metro Foods';

  it('matches everything on an empty box', () => {
    expect(matchesSearch(row, '')).toBe(true);
    expect(matchesSearch(row, '   ')).toBe(true);
  });
  it('needs every word, in any order, anywhere in the row', () => {
    expect(matchesSearch(row, 'accha mozz')).toBe(true);
    expect(matchesSearch(row, 'metro cheese')).toBe(true);
    expect(matchesSearch(row, 'mozz beef')).toBe(false);
  });
  it('forgives one typo in a longer word', () => {
    expect(matchesSearch(row, 'mozarella')).toBe(true);
    expect(matchesSearch('Cheddar Block', 'chedar')).toBe(true);
    expect(matchesSearch('Pizza Sauce', 'piza sause')).toBe(false); // "piza" is short: must be typed right
    expect(matchesSearch('Pizza Sauce', 'pizza sause')).toBe(true);
    expect(matchesSearch('Onion', 'onoin')).toBe(true);
  });
  it('forgives a typo in the first letters of a word', () => {
    expect(matchesSearch('Mozzarella (Adam)', 'mozar')).toBe(true);
  });
  it('does not guess wildly', () => {
    expect(matchesSearch('Mince', 'mint')).toBe(false);
    expect(matchesSearch('Chicken Tikka', 'cheese')).toBe(false);
  });
  it('ignores accents both ways', () => {
    expect(matchesSearch('Jalapeño', 'jalapeno')).toBe(true);
    expect(matchesSearch('Jalapeno', 'jalapeño')).toBe(true);
  });
  it('takes pre-split words too', () => {
    expect(matchesSearch(row, ['dairy'])).toBe(true);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 23 }, (_, i) => i + 1);

  it('returns one page with its position', () => {
    expect(paginate(items, 1, 10)).toMatchObject({ items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], page: 1, pageCount: 3, total: 23, from: 1, to: 10 });
    expect(paginate(items, 3, 10)).toMatchObject({ items: [21, 22, 23], page: 3, from: 21, to: 23 });
  });
  it('clamps a page past either end', () => {
    expect(paginate(items, 9, 10).page).toBe(3);
    expect(paginate(items, 0, 10).page).toBe(1);
    expect(paginate(items, Number.NaN, 10).page).toBe(1);
  });
  it('handles an empty list', () => {
    expect(paginate([], 1, 10)).toEqual({ items: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0 });
  });
});

describe('countBy', () => {
  it('counts rows per key', () => {
    expect(countBy(['a', 'b', 'a'], (x) => x)).toEqual({ a: 2, b: 1 });
    expect(countBy([], (x: string) => x)).toEqual({});
  });
});

describe('compareText', () => {
  it('sorts names the way people read them', () => {
    expect(['Box 10', 'box 2', 'Apple'].sort(compareText)).toEqual(['Apple', 'box 2', 'Box 10']);
  });
});
