/**
 * The 24 Oct 2026 deals (menu file deals_2026_10_24.py) label their slots so every option is unique across
 * one item's groups: the website shows the option without the label, and a drink without its brand.
 */
import { describe, expect, it } from 'vitest';
import { drinkChoiceName, optionLabel } from './menu-view';

describe('deal slot labels', () => {
  it('a second drink reads as the drink, by its flavour', () => {
    expect(drinkChoiceName('2nd: Pepsi 345 ml')).toBe('Cola 345 ml');
    expect(drinkChoiceName('2nd: Diet Pepsi 345 ml')).toBe('Diet cola 345 ml');
    expect(optionLabel('2nd: Mirinda 345 ml')).toBe('Orange 345 ml');
    // As before: the first drink, and an unknown brand fails closed.
    expect(drinkChoiceName('Pepsi 345 ml')).toBe('Cola 345 ml');
    expect(drinkChoiceName('2nd: Sting 345 ml')).toBe('Soft drink 345 ml');
  });

  it('a signature pizza, a burger and a second dip read without their slot', () => {
    expect(optionLabel('Signature: Shawarma Pizza')).toBe('Shawarma Pizza');
    expect(optionLabel('Burger: Nashville Authentic (Hot)')).toBe('Nashville Authentic (Hot)');
    expect(optionLabel('2nd dip: Garlic Mayo')).toBe('Garlic Mayo');
    // The value deals' own slots, as before.
    expect(optionLabel('2nd Large: Fajita Pizza')).toBe('Fajita Pizza');
    expect(optionLabel('Medium: Cheesalious')).toBe('Cheesalious');
    expect(optionLabel('Ranch')).toBe('Ranch');
  });
});
