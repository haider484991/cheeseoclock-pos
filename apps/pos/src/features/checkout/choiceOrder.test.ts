import { describe, expect, it } from 'vitest';
import {
  choiceGroupKind,
  orderChoiceGroups,
  type ChoiceGroupLike,
} from '@cheeseoclock/shared-types';

/**
 * The shared order both the till's choices popup and the website's item sheet
 * ask an item's choice groups in — tested with the shop's real group names
 * (the menu import's cheeseoclock-menu-import.json).
 */

function group(
  name: string,
  options: string[],
  over: Partial<ChoiceGroupLike> & { removes?: boolean } = {},
): ChoiceGroupLike & { id: string } {
  const { removes, ...rest } = over;
  return {
    id: `g:${name}`,
    name,
    isRequired: false,
    minSelect: 0,
    modifiers: options.map((o) => ({ name: o, ...(removes ? { removesIngredientId: `ing:${o}` } : {}) })),
    ...rest,
  };
}

const required = { isRequired: true, minSelect: 1 };
const DEAL_LARGE = group('Deal: Large pizza', ['Large: Fajita Pizza', 'Large: Classic Supreme'], required);
const DEAL_2ND_LARGE = group('Deal: 2nd Large pizza', ['2nd Large: Fajita Pizza', '2nd Large: Classic Supreme'], required);
const DEAL_MEDIUM = group('Deal: Medium pizza', ['Medium: Fajita Pizza', 'Medium: Classic Supreme'], required);
const CHOOSE_DIP = group('Choose your dip', ['Signature Orange Dip', 'Sriracha', 'Ranch', 'Cheese'], required);
const VEGGIES = group('Veggie Lovers — Choose 5 veggies', ['Onion', 'Green bell pepper', 'Olives'], required);
const LEAVE_OUT_FAJITA = group('Leave out · Fajita Pizza', ['No onion', 'No bell pepper', 'No chicken'], { removes: true });
const LEAVE_OUT_VEGGIE = group('Leave out · Veggie Lovers', ['No garlic powder', 'No sauce', 'No cheese'], { removes: true });
const LEAVE_OUT_BURGER = group('Leave out · Crispy Signature', ['No lettuce', 'No orange sauce', 'No butter'], { removes: true });
const LEAVE_OUT_DEALS = group('Leave out · Deals', ['No onion', 'No bell pepper', 'No olives'], { removes: true });
const EXTRA_TOPPINGS = group('Extra toppings', ['Extra cheese', 'Extra onion', 'Extra bell pepper']);
const BURGER_EXTRAS = group('Extras · Burgers', ['Add cheese']);
const SIDE_DIPS = group('Dips on the side', ['Side of Signature Orange Dip', 'Side of Sriracha', 'Side of Ranch']);
const ADD_DRINK = group('Add a drink', ['Pepsi 345 ml', 'Pepsi 1 litre', 'Mirinda 345 ml', 'Mirinda 1 litre']);
const FLAVOUR_345 = group('Choose a flavour · 345 ml', ['Pepsi', 'Diet Pepsi', '7Up', 'Mirinda', 'Mountain Dew'], required);
const DEAL_DRINK = group('Deal: 1 litre drink', ['Pepsi 1 litre', 'Diet Pepsi 1 litre', 'Mirinda 1 litre'], required);

const names = (gs: readonly ChoiceGroupLike[]) => gs.map((g) => g.name);

describe('choiceGroupKind', () => {
  it('reads the shop’s groups', () => {
    expect(choiceGroupKind(DEAL_LARGE)).toBe('required');
    expect(choiceGroupKind(CHOOSE_DIP)).toBe('required');
    expect(choiceGroupKind(VEGGIES)).toBe('required');
    expect(choiceGroupKind(SIDE_DIPS)).toBe('dips');
    expect(choiceGroupKind(EXTRA_TOPPINGS)).toBe('extras');
    expect(choiceGroupKind(BURGER_EXTRAS)).toBe('extras');
    expect(choiceGroupKind(LEAVE_OUT_FAJITA)).toBe('leave-out');
    expect(choiceGroupKind(LEAVE_OUT_DEALS)).toBe('leave-out');
  });

  it('counts a minimum as required even when the flag is off', () => {
    expect(choiceGroupKind(group('Choose 5 veggies', ['Onion'], { minSelect: 1 }))).toBe('required');
  });

  it('goes by the options when the name says nothing', () => {
    expect(choiceGroupKind(group('Sauces', ['Side of Ranch', 'Side of BBQ Sauce']))).toBe('dips');
    expect(choiceGroupKind(group('Toppings', ['Extra olives', 'Extra mushrooms']))).toBe('extras');
    expect(choiceGroupKind(group('Burger', ['Add cheese']))).toBe('extras');
    expect(choiceGroupKind(group('Hold', ['No onion', 'No pickles']))).toBe('leave-out');
    // The till's leave-out choices name the ingredient they take off.
    expect(choiceGroupKind(group('Allergies', ['Onion', 'Garlic'], { removes: true }))).toBe('leave-out');
  });

  it('keeps the menu import’s old names for the side dips as dips, not extras', () => {
    expect(choiceGroupKind(group('Extra dips', ['Side of Ranch']))).toBe('dips');
    expect(choiceGroupKind(group('Dips', ['Ranch', 'BBQ Sauce']))).toBe('dips');
    expect(choiceGroupKind(group('Pizza extras', ['Olives']))).toBe('extras');
  });

  it('puts anything else last', () => {
    expect(choiceGroupKind(group('Crust', ['Thin', 'Pan']))).toBe('other');
    expect(choiceGroupKind(group('Empty', []))).toBe('other');
  });

  it('an optional drink is a drink, though "Add a drink" starts like "Add cheese"', () => {
    expect(choiceGroupKind(ADD_DRINK)).toBe('drinks');
    expect(choiceGroupKind(group('Drinks', ['Pepsi 345 ml']))).toBe('drinks');
    expect(choiceGroupKind(group('Extra drink', ['7Up 1 litre']))).toBe('drinks');
    expect(choiceGroupKind(group('Beverages', ['Mirinda 345 ml']))).toBe('drinks');
    // "Add cheese" is still an extra; a word that merely contains "drink" is not a drink.
    expect(choiceGroupKind(BURGER_EXTRAS)).toBe('extras');
    expect(choiceGroupKind(group('Drinkable yoghurt sauces', ['Side of Ranch']))).toBe('dips');
  });

  it('a drink the item cannot go without is required: a soft drink’s flavour, a deal’s drink', () => {
    expect(choiceGroupKind(FLAVOUR_345)).toBe('required');
    expect(choiceGroupKind(DEAL_DRINK)).toBe('required');
    expect(choiceGroupKind(group('Add a drink', ['Pepsi 345 ml'], { minSelect: 1 }))).toBe('required');
  });
});

describe('orderChoiceGroups', () => {
  it('a pizza: dips on the side, then extras, then leave-outs — whatever order the till stored', () => {
    // The shop's till imported them leave-outs first; an import never reorders them.
    expect(names(orderChoiceGroups([LEAVE_OUT_FAJITA, EXTRA_TOPPINGS, SIDE_DIPS]))).toEqual([
      'Dips on the side',
      'Extra toppings',
      'Leave out · Fajita Pizza',
    ]);
  });

  it('Veggie Lovers asks its five veggies first', () => {
    expect(names(orderChoiceGroups([VEGGIES, LEAVE_OUT_VEGGIE, EXTRA_TOPPINGS, SIDE_DIPS]))).toEqual([
      'Veggie Lovers — Choose 5 veggies',
      'Dips on the side',
      'Extra toppings',
      'Leave out · Veggie Lovers',
    ]);
  });

  it('a burger with a dip of its choice', () => {
    expect(names(orderChoiceGroups([CHOOSE_DIP, LEAVE_OUT_BURGER, BURGER_EXTRAS, SIDE_DIPS]))).toEqual([
      'Choose your dip',
      'Dips on the side',
      'Extras · Burgers',
      'Leave out · Crispy Signature',
    ]);
  });

  it('a deal: its pizzas in slot order, then dips, then leave-outs', () => {
    expect(names(orderChoiceGroups([DEAL_LARGE, DEAL_2ND_LARGE, LEAVE_OUT_DEALS, SIDE_DIPS]))).toEqual([
      'Deal: Large pizza',
      'Deal: 2nd Large pizza',
      'Dips on the side',
      'Leave out · Deals',
    ]);
    // Family Feast: Medium then Large, as the deal lists them.
    expect(names(orderChoiceGroups([SIDE_DIPS, LEAVE_OUT_DEALS, DEAL_MEDIUM, DEAL_LARGE]))).toEqual([
      'Deal: Medium pizza',
      'Deal: Large pizza',
      'Dips on the side',
      'Leave out · Deals',
    ]);
  });

  it('asks "Add a drink" after the extras and before the leave-outs (owner 2026-09-27)', () => {
    // A till that already had the groups gets "Add a drink" attached last by the import.
    expect(names(orderChoiceGroups([LEAVE_OUT_FAJITA, EXTRA_TOPPINGS, SIDE_DIPS, ADD_DRINK]))).toEqual([
      'Dips on the side',
      'Extra toppings',
      'Add a drink',
      'Leave out · Fajita Pizza',
    ]);
    expect(names(orderChoiceGroups([CHOOSE_DIP, LEAVE_OUT_BURGER, BURGER_EXTRAS, SIDE_DIPS, ADD_DRINK]))).toEqual([
      'Choose your dip',
      'Dips on the side',
      'Extras · Burgers',
      'Add a drink',
      'Leave out · Crispy Signature',
    ]);
  });

  it('a deal asks its drink with its pizzas, after them', () => {
    expect(names(orderChoiceGroups([DEAL_LARGE, DEAL_2ND_LARGE, LEAVE_OUT_DEALS, SIDE_DIPS, DEAL_DRINK]))).toEqual([
      'Deal: Large pizza',
      'Deal: 2nd Large pizza',
      'Deal: 1 litre drink',
      'Dips on the side',
      'Leave out · Deals',
    ]);
    // A soft drink asks only its flavour.
    expect(names(orderChoiceGroups([FLAVOUR_345]))).toEqual(['Choose a flavour · 345 ml']);
  });

  it('keeps groups of one kind in the order given, and anything else last', () => {
    const crust = group('Crust', ['Thin', 'Pan']);
    expect(names(orderChoiceGroups([crust, BURGER_EXTRAS, EXTRA_TOPPINGS, LEAVE_OUT_FAJITA, LEAVE_OUT_DEALS]))).toEqual([
      'Extras · Burgers',
      'Extra toppings',
      'Leave out · Fajita Pizza',
      'Leave out · Deals',
      'Crust',
    ]);
  });

  it('returns the same group objects in a new array, leaving the input alone', () => {
    const input = [LEAVE_OUT_FAJITA, SIDE_DIPS];
    const out = orderChoiceGroups(input);
    expect(out[0]).toBe(SIDE_DIPS);
    expect(out[0]!.id).toBe('g:Dips on the side');
    expect(names(input)).toEqual(['Leave out · Fajita Pizza', 'Dips on the side']);
    expect(orderChoiceGroups([])).toEqual([]);
  });
});
