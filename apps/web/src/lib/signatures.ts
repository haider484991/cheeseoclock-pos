/**
 * The food the home page shows — the shop's own photographed dishes, worded as
 * on the printed menu (cheeseoclock-menu/menu.html). The ordering page reads
 * live prices from the POS; the home page is static, so these prices are a
 * copy: when the till's price changes, change it here too.
 */
export interface Showcase {
  name: string;
  /** One line under the name in the 3D hero. */
  hook: string;
  description: string;
  image: string;
  /** e.g. 'Large 12"' */
  size: string;
  priceRs: number;
}

export const SIGNATURE_PIZZAS: readonly Showcase[] = [
  {
    name: 'Cheesy Star',
    hook: 'Star-cut · Sriracha mayo dip',
    description:
      'Cut like a star, built for sharing. Fajita chicken, kabab pieces, bell pepper, onion, pickle and olives, with Sriracha mayo dip.',
    image: '/images/menu/cheesy-star.webp',
    size: 'Large 12"',
    priceRs: 2200,
  },
  {
    name: 'Crown Crust',
    hook: 'Tikka & seekh kabab · pan dough',
    description:
      'Crowned with tikka chicken and seekh kabab, jalapeño, bell pepper, onion and olives, finished with creamy Sriracha.',
    image: '/images/menu/crown-crust.webp',
    size: 'Large 12"',
    priceRs: 2200,
  },
  {
    name: 'Shawarma Pizza',
    hook: 'Shawarma chicken, fries & pickle',
    description:
      'Made with shawarma chicken, crisp fries, pickle and olives, drizzled with shawarma sauce, with a Sriracha sauce.',
    image: '/images/menu/shawarma-pizza.webp',
    size: 'Large 12"',
    priceRs: 2200,
  },
  {
    name: 'Meat Lovers',
    hook: 'Three meats · one pan crust',
    description:
      'Fajita chicken, Italian minced meat and pepperoni with onion, drizzled with creamy Sriracha sauce.',
    image: '/images/menu/meat-lovers.webp',
    size: 'Large 12"',
    priceRs: 2200,
  },
  {
    name: 'Cheetos',
    hook: 'Hot, tangy red spice kick',
    description:
      'Fajita chicken and jalapeño with creamy cheese and a hot, tangy red spice, with ranch dip.',
    image: '/images/menu/cheetos.webp',
    size: 'Large 12"',
    priceRs: 2200,
  },
];

export const SIGNATURE_BURGER: Showcase = {
  name: 'Signature Cheese Dipped',
  hook: 'Dunked in molten cheese',
  description:
    'Thigh-marinated crispy fillet dunked in molten cheese, with signature sauce, lettuce and jalapeño in a brioche bun.',
  image: '/images/menu/signature-cheese-dipped.webp',
  size: 'Burger',
  priceRs: 900,
};

/**
 * Printed menu's Value Deals (regular-menu pizzas only). `worthRs` is the same
 * food bought one by one (Medium Rs 1,500, Large Rs 2,000, 1 litre Rs 250) —
 * the ordering page works this out from live prices (menu-view dealWorthCents).
 */
export const VALUE_DEALS = [
  { name: 'Big Two', what: '2 Large 12" + 1 litre soft drink', priceRs: 3600, worthRs: 4250 },
  { name: 'Family Feast', what: '1 Medium 9" + 1 Large 12" + 1 litre soft drink', priceRs: 3100, worthRs: 3750 },
  { name: 'Perfect Pair', what: '2 Medium 9" + 1 litre soft drink', priceRs: 2600, worthRs: 3250 },
] as const;
