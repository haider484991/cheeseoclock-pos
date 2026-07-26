import { describe, expect, it } from 'vitest';
import type {
  PublishedMenuItem,
  PublishedModifierGroup,
} from '@cheeseoclock/shared-types';
import { validateModifierSelection } from './order-validation';

function group(
  over: Partial<PublishedModifierGroup> & { posGroupId: string },
): PublishedModifierGroup {
  return {
    name: over.posGroupId,
    selectionType: 'multi',
    minSelect: 0,
    maxSelect: 0,
    isRequired: false,
    sortOrder: 0,
    modifiers: [],
    ...over,
  };
}

function mod(id: string, priceDeltaCents = 0) {
  return {
    posModifierId: id,
    name: id,
    priceDeltaCents,
    isDefault: false,
    sortOrder: 0,
  };
}

/** A pizza with a required single-select size and an optional topping group. */
function pizza(): PublishedMenuItem {
  return {
    posItemId: 'pizza',
    name: 'Cheese Pizza',
    description: null,
    basePriceCents: 90_000,
    taxRateBps: 1600,
    imageUrl: null,
    sortOrder: 0,
    modifierGroups: [
      group({
        posGroupId: 'Size',
        selectionType: 'single',
        isRequired: true,
        minSelect: 1,
        maxSelect: 1,
        modifiers: [mod('small'), mod('large', 40_000)],
      }),
      group({
        posGroupId: 'Toppings',
        maxSelect: 2,
        modifiers: [mod('olives', 5_000), mod('corn', 5_000), mod('feta', 8_000)],
      }),
    ],
  };
}

describe('validateModifierSelection', () => {
  it('accepts a well-formed selection', () => {
    expect(validateModifierSelection(pizza(), ['large', 'olives'])).toBeNull();
  });

  it('accepts a required group satisfied with no optional extras', () => {
    expect(validateModifierSelection(pizza(), ['small'])).toBeNull();
  });

  it('rejects a missing required group', () => {
    // The kitchen would otherwise get a pizza ticket with no size on it.
    expect(validateModifierSelection(pizza(), ['olives'])).toMatch(/required/i);
  });

  it('rejects two choices from a single-select group', () => {
    expect(validateModifierSelection(pizza(), ['small', 'large'])).toMatch(
      /only one choice/i,
    );
  });

  it('rejects exceeding maxSelect on a multi-select group', () => {
    expect(
      validateModifierSelection(pizza(), ['small', 'olives', 'corn', 'feta']),
    ).toMatch(/at most 2/i);
  });

  it('allows exactly maxSelect', () => {
    expect(
      validateModifierSelection(pizza(), ['small', 'olives', 'corn']),
    ).toBeNull();
  });

  it('rejects a repeated modifier id', () => {
    // The price-manipulation vector: each repeat re-applied priceDeltaCents,
    // and a negative delta repeated enough times walks the total down.
    expect(validateModifierSelection(pizza(), ['small', 'olives', 'olives'])).toMatch(
      /duplicate/i,
    );
  });

  it('catches a repeated *discount* modifier before it can move the price', () => {
    const item = pizza();
    item.modifierGroups.push(
      group({
        posGroupId: 'Discounts',
        modifiers: [mod('no-cheese', -20_000)],
      }),
    );
    const many = ['small', ...Array.from({ length: 20 }, () => 'no-cheese')];
    expect(validateModifierSelection(item, many)).toMatch(/duplicate/i);
  });

  it('ignores maxSelect when it is 0 (meaning unlimited)', () => {
    const item = pizza();
    item.modifierGroups = [
      group({
        posGroupId: 'Sauces',
        maxSelect: 0,
        modifiers: [mod('a'), mod('b'), mod('c')],
      }),
    ];
    expect(validateModifierSelection(item, ['a', 'b', 'c'])).toBeNull();
  });

  it('treats a required group with minSelect 0 as needing at least one', () => {
    const item = pizza();
    item.modifierGroups = [
      group({
        posGroupId: 'Base',
        isRequired: true,
        minSelect: 0,
        modifiers: [mod('thin'), mod('thick')],
      }),
    ];
    expect(validateModifierSelection(item, [])).toMatch(/required/i);
    expect(validateModifierSelection(item, ['thin'])).toBeNull();
  });

  it('enforces minSelect above 1 on a required group', () => {
    const item = pizza();
    item.modifierGroups = [
      group({
        posGroupId: 'Pick two',
        isRequired: true,
        minSelect: 2,
        modifiers: [mod('a'), mod('b'), mod('c')],
      }),
    ];
    expect(validateModifierSelection(item, ['a'])).toMatch(/required/i);
    expect(validateModifierSelection(item, ['a', 'b'])).toBeNull();
  });

  it('accepts an item with no modifier groups at all', () => {
    const drink: PublishedMenuItem = { ...pizza(), modifierGroups: [] };
    expect(validateModifierSelection(drink, [])).toBeNull();
  });
});
