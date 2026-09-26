import { describe, expect, it } from 'vitest';
import { checkChoicePicks, type ChoiceGroupRule } from './choice-validation.js';

const flavour: ChoiceGroupRule = {
  id: 'g-flavour',
  label: 'Choose a flavour · 1 litre',
  selectionType: 'single',
  isRequired: true,
  minSelect: 1,
  maxSelect: 1,
  optionIds: ['pepsi', 'mirinda'],
};
const veggies: ChoiceGroupRule = {
  id: 'g-veg',
  label: 'Veggie Lovers — Choose up to 5 veggies',
  selectionType: 'multi',
  isRequired: true,
  minSelect: 1,
  maxSelect: 5,
  optionIds: ['onion', 'pepper', 'olive', 'mushroom', 'tomato', 'jalapeno'],
};
const dips: ChoiceGroupRule = {
  id: 'g-dips',
  label: 'Dips on the side',
  selectionType: 'multi',
  isRequired: false,
  minSelect: 0,
  maxSelect: 9,
  optionIds: ['side-ranch', 'side-bbq'],
};

describe('checkChoicePicks', () => {
  it('refuses a drink with no flavour and accepts one flavour', () => {
    expect(checkChoicePicks([flavour], [])).toBe('Choose a flavour · 1 litre: pick one');
    expect(checkChoicePicks([flavour], ['mirinda'])).toBeNull();
  });

  it('refuses two picks in a single-choice group', () => {
    expect(checkChoicePicks([flavour], ['pepsi', 'mirinda'])).toBe('Choose a flavour · 1 litre: pick only one');
  });

  it('takes 1 to 5 veggies, not 0 and not 6', () => {
    expect(checkChoicePicks([veggies], ['onion'])).toBeNull();
    expect(checkChoicePicks([veggies], ['onion', 'pepper', 'olive', 'mushroom', 'tomato'])).toBeNull();
    expect(checkChoicePicks([veggies], [])).toBe('Veggie Lovers — Choose up to 5 veggies: pick one');
    expect(checkChoicePicks([veggies], ['onion', 'pepper', 'olive', 'mushroom', 'tomato', 'jalapeno'])).toBe(
      'Veggie Lovers — Choose up to 5 veggies: pick at most 5',
    );
  });

  it('leaves optional groups optional and refuses a repeated pick', () => {
    expect(checkChoicePicks([dips], [])).toBeNull();
    expect(checkChoicePicks([dips], ['side-ranch', 'side-ranch'])).toBe('The same choice was picked twice');
  });

  it('asks for the minimum when a required group needs several', () => {
    expect(checkChoicePicks([{ ...veggies, minSelect: 5, maxSelect: 5 }], ['onion'])).toBe(
      'Veggie Lovers — Choose up to 5 veggies: pick 5',
    );
  });
});
