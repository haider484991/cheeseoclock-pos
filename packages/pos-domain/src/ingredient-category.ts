/**
 * Ingredient categories — the shelves the store room is sorted by, so a
 * manager with 120+ ingredients can find "all the cheese" in one tap.
 *
 * A category a manager picks is stored. Until then it is guessed from the
 * name by `guessIngredientCategory`, which is pure and runs wherever an
 * ingredient is read, so every existing ingredient has a sensible shelf
 * without a mass rewrite, and a renamed one follows its new name.
 */

import { INGREDIENT_CATEGORY_IDS, type IngredientCategory } from '@cheeseoclock/shared-types';

export { INGREDIENT_CATEGORY_IDS, type IngredientCategory };

export interface IngredientCategoryInfo {
  id: IngredientCategory;
  label: string;
}

/** In the order the screen lists them. */
export const INGREDIENT_CATEGORIES: readonly IngredientCategoryInfo[] = [
  { id: 'dough', label: 'Dough & Bases' },
  { id: 'cheese', label: 'Cheese & Dairy' },
  { id: 'meat', label: 'Meat & Chicken' },
  { id: 'veg', label: 'Veg & Toppings' },
  { id: 'sauce', label: 'Sauces & Dips' },
  { id: 'spice', label: 'Spices & Seasoning' },
  { id: 'dry', label: 'Oil & Dry goods' },
  { id: 'drinks', label: 'Drinks' },
  { id: 'packaging', label: 'Packaging' },
  { id: 'other', label: 'Other' },
];

export function ingredientCategoryLabel(id: string | null | undefined): string {
  return INGREDIENT_CATEGORIES.find((c) => c.id === id)?.label ?? 'Other';
}

export function isIngredientCategory(value: unknown): value is IngredientCategory {
  return typeof value === 'string' && (INGREDIENT_CATEGORY_IDS as readonly string[]).includes(value);
}

/**
 * "Jalapeño (Sliced)" → "jalapeno sliced". Accents dropped, punctuation to
 * spaces, so the keyword rules below match whole words only.
 */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const w = (words: string): RegExp => new RegExp(`\\b(?:${words})\\b`);

/**
 * First match wins, so the order is the point: "Cheese Sauce" is a sauce
 * before it is cheese, "Garlic Powder" a spice before it is veg, "Olive Oil"
 * dry goods before "olive" makes it a topping, "Pizza Box" packaging before
 * "pizza" means anything.
 */
const RULES: ReadonlyArray<[IngredientCategory, RegExp]> = [
  // Exceptions that the broad rules further down would get wrong.
  ['cheese', w('milk powder|cream cheese|sour cream')],
  ['dough', w('baking powder|baking soda|yeast|instant yeast')],
  ['packaging', w(
    'box|boxes|bag|bags|foil|foils|tray|trays|fork|forks|spoon|spoons|knife|knives|cutlery|sticker|stickers|' +
      'napkin|napkins|tissue|tissues|cup|cups|lid|lids|straw|straws|wrapper|wrappers|butter paper|wrapping paper|' +
      'container|containers|carton|cartons|packaging|pouch|pouches|clamshell|toothpick|toothpicks|glove|gloves|' +
      'cling film|cling wrap|label|labels|takeaway|take away|parchment',
  )],
  ['dry', w('lemon juice|lime juice')],
  ['drinks', w(
    'drink|drinks|soft drink|cola|coke|soda|sprite|fanta|7 ?up|mirinda|mountain dew|dew|mineral water|' +
      'bottled water|water bottle|juice|juices|tea|coffee|lemonade|milkshake|shake|energy drink|syrup drink',
  )],
  ['spice', w('powder|spice|spices|seasoning|masala|dry rub|rub')],
  ['sauce', w(
    'sauce|sauces|dip|dips|mayo|mayonnaise|ketchup|mustard|dressing|dressings|marinade|marinades|sriracha|' +
      'tabasco|tahini|toum|aioli|chutney|raita|salsa|paste|pesto|vinaigrette|ranch|bbq|barbecue|sachet|sachets|' +
      'gravy|glaze',
  )],
  ['dry', w('corn ?flour|corn ?starch|starch|breading|bread ?crumbs?|crumbs?|panko|coating')],
  ['dough', w(
    'dough|doughs|bun|buns|bread|breads|base|bases|crust|crusts|tortilla|tortillas|pita|pitta|naan|roti|' +
      'paratha|wrap|wraps|flour|maida|atta|brioche|roll|rolls|bagel|bagels',
  )],
  ['cheese', w(
    'cheese|cheeses|cheddar|mozzarella|mozarella|mozzarela|parmesan|feta|gouda|provolone|cream|creme|milk|' +
      'butter|yogurt|yoghurt|dahi|curd|ghee|paneer|egg|eggs',
  )],
  ['meat', w(
    'chicken|beef|mutton|lamb|qeema|keema|kheema|mince|minced|pepperoni|sausage|sausages|salami|ham|bacon|' +
      'turkey|kabab|kebab|kababs|kebabs|seekh|tikka|fajita|boti|zinger|fillet|fillets|thigh|thighs|wing|wings|' +
      'nugget|nuggets|patty|patties|fish|prawn|prawns|shrimp|shrimps|tuna|meat|steak|drumstick|drumsticks|breast',
  )],
  ['veg', w('bell pepper|bell peppers|capsicum|capsicums|green pepper|green peppers|jalap[a-z]*')],
  ['spice', w(
    '(?:dry|dried) (?:basil|oregano|parsley|mint|thyme|rosemary|leaves|herbs?)|' +
      '(?:basil|oregano|parsley|mint|thyme|rosemary|leaves|herbs?) (?:dry|dried)',
  )],
  ['spice', w(
    'salt|pepper|peppercorns?|black pepper|white pepper|cayenne|paprika|oregano|thyme|rosemary|cumin|zeera|jeera|turmeric|' +
      'haldi|cinnamon|clove|cloves|cardamom|elaichi|nutmeg|kalonji|nigella|sesame|seeds?|flakes|crushed chill?i|' +
      'chill?i flakes|mixed herbs|italian herbs|msg|ajinomoto|bay leaf|bay leaves|garam|chaat|sumac|zaatar|za atar',
  )],
  ['dry', w(
    'oil|oils|vinegar|sugar|honey|syrup|rice|pasta|noodles|spaghetti|macaroni|food colou?r|colou?r|essence|' +
      'vanilla|cocoa|chocolate|nuts?|almonds?|cashews?|raisins?|gelatin|canned|tinned',
  )],
  ['veg', w(
    'onion|onions|tomato|tomatoes|lettuce|iceberg|cabbage|cabbages|carrot|carrots|olive|olives|mushroom|' +
      'mushrooms|corn|sweetcorn|cucumber|cucumbers|pickle|pickles|pickled|gherkin|gherkins|garlic|ginger|' +
      'chill?i|chill?ies|coriander|dhania|cilantro|mint|parsley|basil|rocket|arugula|spinach|lemon|lemons|lime|' +
      'limes|potato|potatoes|fries|chips|wedges|pineapple|coleslaw|slaw|salad|herb|herbs|vegetable|vegetables|' +
      'veg|veggies|leaves|avocado|beans|peas|brinjal|eggplant|zucchini|spring onion',
  )],
];

/**
 * The shelf an ingredient most likely sits on, from its name alone:
 * "Mozzarella (Accha)" → cheese, "Pizza Box Large" → packaging,
 * "Garlic Powder" → spice. Anything it cannot place is "other".
 */
export function guessIngredientCategory(name: string): IngredientCategory {
  const n = normalizeName(name);
  if (!n) return 'other';
  for (const [category, pattern] of RULES) {
    if (pattern.test(n)) return category;
  }
  return 'other';
}
