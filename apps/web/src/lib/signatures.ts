/**
 * The home page's own words for the dishes it features today — the shop's
 * photographed signatures, worded as on the printed menu
 * (cheeseoclock-menu/menu.html) — keyed by the till's names.
 *
 * WHICH items the home page features is the owner's (Settings → Shop & logo
 * → Home page: 'website.home'; today's lineup with none saved) and what they
 * COST is the published menu's (sweep B2: lib/home-lineup.ts) — no price
 * or deal worth is written here any more. These words are used for a
 * featured item the owner gave no words of his own: the carousel line
 * (`hook`) and the card's description here, else the till's description.
 * The photos are lib/menu-view shopPhotoFor's, by the same names.
 */
export interface CuratedDish {
  /** One line under the name in the 3D hero. */
  hook: string;
  /** The signatures card's description. */
  description: string;
}

/** By the item's name without its size ("Cheesy Star — Large" → "Cheesy Star"). */
const DISHES: Readonly<Record<string, CuratedDish>> = {
  'Cheesy Star': {
    hook: 'Star-cut · Sriracha mayo dip',
    description:
      'Cut like a star, built for sharing. Fajita chicken, kabab pieces, bell pepper, onion, pickle and olives, with Sriracha mayo dip.',
  },
  'Crown Crust': {
    hook: 'Tikka & seekh kabab · pan dough',
    description:
      'Crowned with tikka chicken and seekh kabab, jalapeño, bell pepper, onion and olives, finished with creamy Sriracha.',
  },
  'Shawarma Pizza': {
    hook: 'Shawarma chicken, fries & pickle',
    description:
      'Made with shawarma chicken, crisp fries, pickle and olives, drizzled with shawarma sauce, with a Sriracha sauce.',
  },
  'Meat Lovers': {
    hook: 'Three meats · one pan crust',
    description:
      'Fajita chicken, Italian minced meat and pepperoni with onion, drizzled with creamy Sriracha sauce.',
  },
  Cheetos: {
    hook: 'Hot, tangy red spice kick',
    description:
      'Fajita chicken and jalapeño with creamy cheese and a hot, tangy red spice, with ranch dip.',
  },
  'Signature Cheese Dipped': {
    hook: 'Dunked in molten cheese',
    description:
      'Thigh-marinated crispy fillet dunked in molten cheese, with signature sauce, lettuce and jalapeño in a brioche bun.',
  },
};

/**
 * The printed menu's Value Deals (regular-menu pizzas only): what is in each,
 * by the deal's name. Its price and what it is worth bought one by one are
 * the menu's (menu-view dealWorthCents).
 */
const DEALS: Readonly<Record<string, string>> = {
  'Big Two': '2 Large 12" + 1 litre soft drink',
  'Family Feast': '1 Medium 9" + 1 Large 12" + 1 litre soft drink',
  'Perfect Pair': '2 Medium 9" + 1 litre soft drink',
};

/** Case, spaces and ’/' do not make two names differ. */
const fold = (s: string) => s.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

const byFolded = <T>(table: Readonly<Record<string, T>>): ReadonlyMap<string, T> =>
  new Map(Object.entries(table).map(([k, v]) => [fold(k), v]));

const DISH_BY_NAME = byFolded(DISHES);
const DEAL_BY_NAME = byFolded(DEALS);

/** The curated words for a dish, by its name without its size ("Cheesy Star"), or null. */
export function curatedDish(baseName: string): CuratedDish | null {
  return DISH_BY_NAME.get(fold(baseName)) ?? null;
}

/** What is in a value deal, in the home page's words, by the deal's name ("Big Two"), or null. */
export function curatedDealWhat(dealName: string): string | null {
  return DEAL_BY_NAME.get(fold(dealName)) ?? null;
}

/** The dishes that have curated words (and a shop photo: images.test.ts). */
export const CURATED_DISH_NAMES: readonly string[] = Object.freeze(Object.keys(DISHES));
