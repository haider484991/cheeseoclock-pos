import { describe, expect, it } from 'vitest';
import {
  INGREDIENT_CATEGORIES,
  INGREDIENT_CATEGORY_IDS,
  guessIngredientCategory,
  ingredientCategoryLabel,
  isIngredientCategory,
} from './ingredient-category.js';

describe('INGREDIENT_CATEGORIES', () => {
  it('labels every category id exactly once', () => {
    expect(INGREDIENT_CATEGORIES.map((c) => c.id).sort()).toEqual([...INGREDIENT_CATEGORY_IDS].sort());
  });

  it('falls back to Other for an unknown id', () => {
    expect(ingredientCategoryLabel('cheese')).toBe('Cheese & Dairy');
    expect(ingredientCategoryLabel('nonsense')).toBe('Other');
    expect(ingredientCategoryLabel(null)).toBe('Other');
  });

  it('knows its own ids', () => {
    expect(isIngredientCategory('meat')).toBe(true);
    expect(isIngredientCategory('Meat')).toBe(false);
    expect(isIngredientCategory(3)).toBe(false);
  });
});

describe('guessIngredientCategory', () => {
  // Names as they appear in the shop's own menu import.
  const cases: Array<[string, string]> = [
    // dough & bases
    ['Pan Pizza Dough', 'dough'],
    ['Thin Crust Dough', 'dough'],
    ['Brioche Bun', 'dough'],
    ['Flour', 'dough'],
    ['Yeast', 'dough'],
    ['Baking Powder', 'dough'],
    // cheese & dairy
    ['Mozzarella (Accha)', 'cheese'],
    ['Cheddar Slice (Yellow)', 'cheese'],
    ['Pizza Cheese Mix', 'cheese'],
    ['Milk Powder', 'cheese'],
    ['Olper Cream', 'cheese'],
    ['Salted Butter', 'cheese'],
    ['Unsalted Butter', 'cheese'],
    ['Yogurt', 'cheese'],
    // meat & chicken
    ['Chicken Tikka', 'meat'],
    ['Chicken Malai', 'meat'],
    ['Zinger Thigh Fillet', 'meat'],
    ['Chicken Nuggets (frozen)', 'meat'],
    ['Beef Qeema', 'meat'],
    ['Qeema (Cooked)', 'meat'],
    ['Pepperoni', 'meat'],
    ['Seekh Kabab', 'meat'],
    // veg & toppings
    ['Green Bell Pepper', 'veg'],
    ['Jalapeño', 'veg'],
    ['Jalape�o', 'veg'], // a mangled accent from a spreadsheet export
    ['Black Olives', 'veg'],
    ['Iceberg Lettuce', 'veg'],
    ['Rocket Leaves', 'veg'],
    ['Basil Leaves (Fresh)', 'veg'],
    ['Peeled Garlic', 'veg'],
    ['Green Chilli', 'veg'],
    ['Mara Peeled Tomato', 'veg'],
    ['Pickled Cucumber', 'veg'],
    ['Nashville Coleslaw', 'veg'],
    ['Frozen Fries', 'veg'],
    ['Lemon', 'veg'],
    // sauces & dips
    ['Cheese Sauce', 'sauce'],
    ['Garlic Mayo', 'sauce'],
    ['Creme Sriracha Sauce', 'sauce'],
    ['Honey Mustard Sauce', 'sauce'],
    ['French Mustard', 'sauce'],
    ['Ketchup Sachet', 'sauce'],
    ['Tomato Paste', 'sauce'],
    ['Nashville Marinade', 'sauce'],
    ['Tabasco', 'sauce'],
    ['Soy Sauce', 'sauce'],
    // spices
    ['Garlic Powder', 'spice'],
    ['Chicken Powder', 'spice'],
    ['Cheese Powder', 'spice'],
    ['Mustard Powder', 'spice'],
    ['Cheetos Spice', 'spice'],
    ['Crushed Chilli', 'spice'],
    ['Basil Leaves (Dry)', 'spice'],
    ['Black Pepper', 'spice'],
    ['Cayenne Pepper', 'spice'],
    ['Lemon Salt', 'spice'],
    ['Salt', 'spice'],
    ['Kalonji', 'spice'],
    ['Sesame Seeds', 'spice'],
    ['Oregano', 'spice'],
    // oil & dry goods
    ['Olive Oil', 'dry'],
    ['Cooking Oil', 'dry'],
    ['Corn Flour', 'dry'],
    ['Breading Mix', 'dry'],
    ['Cheetos Crumb', 'dry'],
    ['Brown Sugar', 'dry'],
    ['Honey', 'dry'],
    ['White Vinegar', 'dry'],
    ['Lemon Juice', 'dry'],
    ['Food Colour', 'dry'],
    // drinks
    ['Soft Drink 1 Litre', 'drinks'],
    ['Mineral Water 500ml', 'drinks'],
    // packaging
    ['Pizza Box Large', 'packaging'],
    ['Burger Foil', 'packaging'],
    ['F1 Foil Tray', 'packaging'],
    ['Paper Bag', 'packaging'],
    ['Logo Sticker', 'packaging'],
    ['Fork', 'packaging'],
    // other
    ['P1', 'other'],
    ['Water', 'other'],
    ['', 'other'],
    ['   ', 'other'],
  ];

  it.each(cases)('%s → %s', (name, expected) => {
    expect(guessIngredientCategory(name)).toBe(expected);
  });

  it('ignores case and punctuation', () => {
    expect(guessIngredientCategory('MOZZARELLA')).toBe('cheese');
    expect(guessIngredientCategory('pizza-box (small)')).toBe('packaging');
  });

  it('matches whole words only', () => {
    // "salted" is not "salt", "pepperoni" is not "pepper", "steak" is not "tea"
    expect(guessIngredientCategory('Salted Butter')).toBe('cheese');
    expect(guessIngredientCategory('Pepperoni')).toBe('meat');
    expect(guessIngredientCategory('Beef Steak')).toBe('meat');
  });
});
