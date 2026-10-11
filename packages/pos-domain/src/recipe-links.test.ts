import { describe, expect, it } from 'vitest';
import type { RecipeLine } from './recipe-expand.js';
import { flattenRecipe, flattenRecipes, linkWouldLoop, MAX_LINK_DEPTH, type RecipeLink } from './recipe-links.js';

// Made-up items: a burger (with an extra-cheese choice), fries, a pizza with sizes, deals built from them.
const OWN = new Map<string, RecipeLine[]>([
  [
    'zinger',
    [
      { ingredientId: 'bun', qtyPerUnit: 1, modifierId: null },
      { ingredientId: 'fillet', qtyPerUnit: 120, modifierId: null },
      { ingredientId: 'mayo', qtyPerUnit: 20, modifierId: null },
      { ingredientId: 'cheese', qtyPerUnit: 25, modifierId: 'z-extra-cheese' },
    ],
  ],
  [
    'grilled',
    [
      { ingredientId: 'bun', qtyPerUnit: 1, modifierId: null },
      { ingredientId: 'fillet', qtyPerUnit: 130, modifierId: null },
    ],
  ],
  [
    'fries',
    [
      { ingredientId: 'potato', qtyPerUnit: 150, modifierId: null },
      { ingredientId: 'box', qtyPerUnit: 1, modifierId: null },
    ],
  ],
  [
    'pizza',
    [
      { ingredientId: 'dough', qtyPerUnit: 200, modifierId: null },
      { ingredientId: 'dough', qtyPerUnit: 100, modifierId: 'p-large' },
      { ingredientId: 'cheese', qtyPerUnit: 40, modifierId: 'p-large' },
    ],
  ],
  // The deal's own box for the whole meal.
  ['bigTwo', [{ ingredientId: 'box', qtyPerUnit: 1, modifierId: null }]],
]);

const link = (componentItemId: string, qtyPerUnit: number, modifierId: string | null = null, componentModifierIds: string[] = []): RecipeLink => ({
  componentItemId,
  qtyPerUnit,
  modifierId,
  componentModifierIds,
});

const LINKS = new Map<string, RecipeLink[]>([
  ['bigTwo', [link('zinger', 2), link('fries', 1)]],
  // A deal whose burger slot takes the item of the choice picked.
  ['burgerDeal', [link('zinger', 1, 'd-zinger'), link('grilled', 1, 'd-grilled'), link('fries', 1)]],
  // A large pizza, its size lines included.
  ['pizzaDeal', [link('pizza', 2, null, ['p-large'])]],
  // A deal of a deal.
  ['familyBox', [link('bigTwo', 2)]],
]);

const own = (id: string) => OWN.get(id);
const links = (id: string) => LINKS.get(id);

describe('flattenRecipe: a recipe with its links opened up', () => {
  it('an item with no links reads exactly its own lines, in their order', () => {
    expect(flattenRecipe('zinger', own, links)).toEqual(OWN.get('zinger'));
    expect(flattenRecipe('nothing', own, links)).toEqual([]);
  });

  it('Big Two: its own box, two burgers’ every-sale lines and the fries — the boxes added together; the burger’s extra left out', () => {
    expect(flattenRecipe('bigTwo', own, links)).toEqual([
      { ingredientId: 'box', qtyPerUnit: 2, modifierId: null },
      { ingredientId: 'bun', qtyPerUnit: 2, modifierId: null },
      { ingredientId: 'fillet', qtyPerUnit: 240, modifierId: null },
      { ingredientId: 'mayo', qtyPerUnit: 40, modifierId: null },
      { ingredientId: 'potato', qtyPerUnit: 150, modifierId: null },
    ]);
  });

  it('a deal’s slot: each burger only with its choice; the fries every sale', () => {
    expect(flattenRecipe('burgerDeal', own, links)).toEqual([
      { ingredientId: 'bun', qtyPerUnit: 1, modifierId: 'd-zinger' },
      { ingredientId: 'fillet', qtyPerUnit: 120, modifierId: 'd-zinger' },
      { ingredientId: 'mayo', qtyPerUnit: 20, modifierId: 'd-zinger' },
      { ingredientId: 'bun', qtyPerUnit: 1, modifierId: 'd-grilled' },
      { ingredientId: 'fillet', qtyPerUnit: 130, modifierId: 'd-grilled' },
      { ingredientId: 'potato', qtyPerUnit: 150, modifierId: null },
      { ingredientId: 'box', qtyPerUnit: 1, modifierId: null },
    ]);
  });

  it('the component’s choices the link names come too (two large pizzas)', () => {
    expect(flattenRecipe('pizzaDeal', own, links)).toEqual([
      { ingredientId: 'dough', qtyPerUnit: 600, modifierId: null },
      { ingredientId: 'cheese', qtyPerUnit: 80, modifierId: null },
    ]);
  });

  it('links nest: a family box of two Big Twos', () => {
    expect(flattenRecipe('familyBox', own, links)).toEqual([
      { ingredientId: 'box', qtyPerUnit: 4, modifierId: null },
      { ingredientId: 'bun', qtyPerUnit: 4, modifierId: null },
      { ingredientId: 'fillet', qtyPerUnit: 480, modifierId: null },
      { ingredientId: 'mayo', qtyPerUnit: 80, modifierId: null },
      { ingredientId: 'potato', qtyPerUnit: 300, modifierId: null },
    ]);
  });

  it('the deal follows the burger: a change to the burger’s own lines is in the deal at once', () => {
    const moreFillet = (id: string) =>
      id === 'zinger' ? OWN.get('zinger')!.map((l) => (l.ingredientId === 'fillet' ? { ...l, qtyPerUnit: 150 } : l)) : OWN.get(id);
    expect(flattenRecipe('bigTwo', moreFillet, links).find((l) => l.ingredientId === 'fillet')).toEqual({ ingredientId: 'fillet', qtyPerUnit: 300, modifierId: null });
  });

  it('a loop or a link nested too deep adds nothing; never runs forever', () => {
    const loop = new Map<string, RecipeLink[]>([
      ['a', [link('b', 1)]],
      ['b', [link('a', 1)]],
    ]);
    const ownLoop = new Map<string, RecipeLine[]>([
      ['a', [{ ingredientId: 'x', qtyPerUnit: 1, modifierId: null }]],
      ['b', [{ ingredientId: 'y', qtyPerUnit: 1, modifierId: null }]],
    ]);
    expect(flattenRecipe('a', (id) => ownLoop.get(id), (id) => loop.get(id))).toEqual([
      { ingredientId: 'x', qtyPerUnit: 1, modifierId: null },
      { ingredientId: 'y', qtyPerUnit: 1, modifierId: null },
    ]);
    // A chain longer than MAX_LINK_DEPTH stops there.
    const chain = new Map<string, RecipeLink[]>();
    const chainOwn = new Map<string, RecipeLine[]>();
    for (let i = 0; i < MAX_LINK_DEPTH + 4; i++) {
      chain.set(`c${i}`, [link(`c${i + 1}`, 1)]);
      chainOwn.set(`c${i}`, [{ ingredientId: `i${i}`, qtyPerUnit: 1, modifierId: null }]);
    }
    const deep = flattenRecipe('c0', (id) => chainOwn.get(id), (id) => chain.get(id));
    expect(deep.length).toBeLessThanOrEqual(MAX_LINK_DEPTH + 1);
    expect(deep[0]).toEqual({ ingredientId: 'i0', qtyPerUnit: 1, modifierId: null });
  });
});

describe('flattenRecipes / linkWouldLoop', () => {
  it('every item with lines or links, once', () => {
    const all = flattenRecipes(OWN, LINKS);
    expect([...all.keys()].sort()).toEqual(['bigTwo', 'burgerDeal', 'familyBox', 'fries', 'grilled', 'pizza', 'pizzaDeal', 'zinger']);
    expect(all.get('zinger')).toEqual(OWN.get('zinger'));
  });

  it('a link back into itself, directly or through another item, is a loop', () => {
    expect(linkWouldLoop('zinger', 'zinger', links)).toBe(true);
    // Big Two into the Family Box is fine; the Family Box into Big Two would loop (it holds Big Two).
    expect(linkWouldLoop('familyBox', 'bigTwo', links)).toBe(false);
    expect(linkWouldLoop('bigTwo', 'familyBox', links)).toBe(true);
    expect(linkWouldLoop('zinger', 'bigTwo', links)).toBe(true);
    expect(linkWouldLoop('fries', 'grilled', links)).toBe(false);
  });
});
