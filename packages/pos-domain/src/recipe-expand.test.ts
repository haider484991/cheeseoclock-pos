import { describe, expect, it } from 'vitest';
import { BASE_PART, expandRecipe, totalsByIngredient, type PickedChoice, type RecipeLine } from './recipe-expand.js';

// A made-up pizza: dough, cheese and onion on every one; the onion also comes
// back as a paid extra, and as a free veggie pick.
const line = (ingredientId: string, qtyPerUnit: number, modifierId: string | null = null): RecipeLine => ({
  ingredientId,
  qtyPerUnit,
  modifierId,
});
const pick = (modifierId: string, priceDeltaCents = 0, removesIngredientId: string | null = null): PickedChoice => ({
  modifierId,
  priceDeltaCents,
  removesIngredientId,
});
const RECIPE: RecipeLine[] = [
  line('dough', 300),
  line('cheese', 90),
  line('onion', 15),
  line('onion', 10, 'extraOnion'),
  line('onion', 10, 'pickOnion'),
  line('pepper', 10, 'pickPepper'),
  line('ranch', 25, 'dipRanch'),
  line('cup', 1, 'dipRanch'),
];
const NO_ONION = pick('noOnion', 0, 'onion');

describe('expandRecipe', () => {
  it('uses every line with no choice, times the quantity, as the base part', () => {
    expect(expandRecipe(RECIPE, [], 2)).toEqual([
      { ingredientId: 'dough', qty: 600, part: BASE_PART },
      { ingredientId: 'cheese', qty: 180, part: BASE_PART },
      { ingredientId: 'onion', qty: 30, part: BASE_PART },
    ]);
  });

  it('adds the lines of each choice picked, under that choice', () => {
    const out = expandRecipe(RECIPE, [pick('dipRanch'), pick('pickPepper')], 1);
    expect(out.filter((l) => l.part === 'dipRanch')).toEqual([
      { ingredientId: 'ranch', qty: 25, part: 'dipRanch' },
      { ingredientId: 'cup', qty: 1, part: 'dipRanch' },
    ]);
    expect(out.filter((l) => l.part === 'pickPepper')).toEqual([{ ingredientId: 'pepper', qty: 10, part: 'pickPepper' }]);
  });

  it('a choice picked twice on one line still counts once (the stock SQL uses EXISTS)', () => {
    expect(expandRecipe(RECIPE, [pick('dipRanch'), pick('dipRanch')], 1).filter((l) => l.ingredientId === 'ranch')).toHaveLength(1);
  });

  it('"No onion" takes the onion off the base and off a free pick', () => {
    const out = totalsByIngredient(expandRecipe(RECIPE, [NO_ONION, pick('pickOnion', 0)], 1));
    expect(out.get('onion')).toBeUndefined();
    expect(out.get('dough')).toBe(300);
  });

  it('…but a paid extra the customer asked for is still used', () => {
    const out = expandRecipe(RECIPE, [NO_ONION, pick('extraOnion', 10_000)], 1);
    expect(out.filter((l) => l.ingredientId === 'onion')).toEqual([{ ingredientId: 'onion', qty: 10, part: 'extraOnion' }]);
  });

  it('a leave-out on a deal: its free pizza picks lose the ingredient too', () => {
    const deal: RecipeLine[] = [line('dough', 450, 'slotFajita'), line('onion', 15, 'slotFajita'), line('dough', 450, 'slot2Veggie')];
    const out = totalsByIngredient(expandRecipe(deal, [pick('slotFajita'), pick('slot2Veggie'), NO_ONION], 1));
    expect(out).toEqual(new Map([['dough', 900]]));
  });

  it('sums per ingredient across parts (what one stock movement takes)', () => {
    const out = totalsByIngredient(expandRecipe(RECIPE, [pick('extraOnion', 10_000), pick('pickOnion')], 3));
    expect(out.get('onion')).toBe((15 + 10 + 10) * 3);
  });
});
