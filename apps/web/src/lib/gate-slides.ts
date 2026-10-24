import {
  buy1Get1WindowWords,
  isBuy1Get1Category,
  type Buy1Get1Rules,
  type PublishedMenuCategory,
  type PublishedMenuItem,
} from '@cheeseoclock/shared-types';
import { formatCents } from './format';
import { drinkFlavourName, isDealSection, sectionTitle } from './menu-view';

/**
 * The deals banner at the top of the landing location popup (components/location/LocationGate;
 * the user, 24 Oct 2026: "above that choose location it should be highly conversion and emotional
 * attacking deals banner"). Each slide opens on the customer's craving or problem (the user's rule:
 * a hook that attacks their problem, never a logo or a feature list), then the deal's name and price.
 *
 * Every deal and price comes from the PUBLISHED menu, so the banner sells only what the till sells,
 * at the till's price: a deal the menu does not have has no slide, the menu unknown has none at all.
 * The words are written for the owner's deals (the yellow deal menu, 24 Oct 2026) and matched by
 * name; a deal they don't name gets a plain hook. "The price you see is the price you pay" is said
 * only of a deal the menu marks tax-included. Buy 1 Get 1 only while the owner has it on, with its hours.
 * Never a drink brand. Pure: the database read is the root layout's (lib/site-facts).
 */

export type GateLang = 'en' | 'ur';
export type Words = Record<GateLang, string>;

/** A cut-out on the slide's dark stage, in % of the stage (left, top, width) and degrees. */
export interface GateCutout {
  src: string;
  left: number;
  top: number;
  width: number;
  rotate: number;
}

export interface GateSlide {
  key: string;
  /** The big first line: the customer's craving or problem. */
  hook: Words;
  /** The proof under it: what is in the deal (or the tax promise). */
  line: Words;
  /** The deal's name as the menu has it (no drink brand). */
  name: string;
  /** The price to pay; "from" = the lowest of several (Buy 1 Get 1). */
  priceCents: number;
  from: boolean;
  /** The menu's price includes the tax (the till's tax-included mark). */
  taxIncluded: boolean;
  /** When it is sold, when not all day ("Daily 12–7 PM only"); null = whenever the shop is open. */
  when: Words | null;
  cutouts: GateCutout[];
}

/** At most this many slides: the popup must still show its Confirm button on a phone's first screen. */
export const GATE_SLIDES_MAX = 8;

const IMG = (name: string) => `/images/gate/${name}.webp`;
const cut = (name: string, left: number, top: number, width: number, rotate = 0): GateCutout => ({
  src: IMG(name),
  left,
  top,
  width,
  rotate,
});

interface Recipe {
  id: string;
  match: RegExp;
  hook: Words;
  line: Words;
  cutouts: GateCutout[];
}

/** The owner's deals, the most emotional first. A deal matches the first recipe whose name test it passes. */
const RECIPES: readonly Recipe[] = [
  {
    id: 'mega',
    match: /\bmega\b/i,
    hook: { en: 'Whole family starving?', ur: 'Poori family bhooki hai?' },
    line: { en: '2 pizzas, 2 burgers, fries & a 1 litre drink', ur: '2 pizza, 2 burger, fries aur 1 litre drink' },
    cutouts: [cut('pizza', 2, 4, 58, -8), cut('burger-cheese', 40, 46, 34, -4), cut('burger-crispy', 64, 50, 32, 5), cut('bottle-1l', 82, 2, 14, 8)],
  },
  {
    id: 'partners',
    match: /\bpartners?\b/i,
    hook: { en: 'Two of you. One craving.', ur: 'Do log, ek craving.' },
    line: { en: 'A medium pizza and 2 cold drinks', ur: 'Medium pizza aur 2 cold drinks' },
    cutouts: [cut('pizza', 8, 8, 62, 20), cut('bottle', 70, 6, 11, -8), cut('bottle', 81, 8, 11, 8)],
  },
  {
    id: 'chilled',
    match: /\bchilled\b/i,
    hook: { en: 'Large pizza. Cold drink. Sorted.', ur: 'Bari pizza, thanda drink — bas!' },
    line: { en: 'A large 12″ pizza, 1 litre drink and a dip', ur: 'Large 12″ pizza, 1 litre drink aur dip' },
    cutouts: [cut('pizza', 6, 4, 66, -6), cut('bottle-1l', 74, 6, 17, 6)],
  },
  {
    id: 'double',
    match: /\bdouble\b/i,
    hook: { en: 'One pizza is never enough.', ur: 'Ek pizza se kabhi kaam chala hai?' },
    line: { en: 'Two large pizzas and a 1 litre drink', ur: 'Do large pizza aur 1 litre drink' },
    cutouts: [cut('pizza-star', 0, 8, 52, 0), cut('pizza', 42, 6, 46, 130), cut('bottle-1l', 84, 4, 13, 8)],
  },
  {
    id: 'nuggets',
    match: /\bnuggets?\b/i,
    hook: { en: 'Kids want nuggets. You want pizza.', ur: 'Bachon ko nuggets, aap ko pizza?' },
    line: { en: 'Large + medium pizza, nuggets & a 1 litre drink', ur: 'Large + medium pizza, nuggets aur 1 litre drink' },
    cutouts: [cut('pizza', 0, 6, 50, -10), cut('pizza', 38, 4, 38, 140), cut('nuggets', 42, 54, 44, 0), cut('bottle-1l', 84, 4, 13, 8)],
  },
  {
    id: 'loaded',
    match: /\bloaded\b/i,
    hook: { en: 'Craving something loaded?', ur: 'Aaj kuch loaded ho jaye?' },
    line: { en: 'A medium pizza, loaded fries and a drink', ur: 'Medium pizza, loaded fries aur drink' },
    cutouts: [cut('pizza', 2, 6, 54, -6), cut('loaded-fries', 46, 48, 46, 0), cut('bottle-1l', 84, 4, 13, 8)],
  },
  {
    id: 'duo',
    match: /\bduo\b/i,
    hook: { en: 'Burger night for two?', ur: 'Dost ke saath burger night?' },
    line: { en: '2 burgers, fries and 2 drinks', ur: '2 burger, fries aur 2 drinks' },
    cutouts: [cut('burger-cheese', 4, 14, 44, -4), cut('burger-crispy', 42, 22, 42, 5), cut('fries', 10, 58, 30, 0), cut('bottle', 84, 6, 11, 6)],
  },
  {
    id: 'burger-meal',
    // The till's own spellings too ("Signature Cripsy Deal"), and the foodpanda names of the same meals.
    match: /\b(classic\s*cri\w*|signature\s*cri\w*|cheese\s*dip\w*|burger\s*meal|crunch\s*time|golden\s*hour|cheese\s*dive)\b/i,
    hook: { en: 'Long day? You’ve earned this.', ur: 'Lamba din? Ab burger banta hai.' },
    line: { en: 'A crispy burger, fries and a drink', ur: 'Crispy burger, fries aur drink' },
    cutouts: [cut('meal-classic', 14, 2, 70, 0)],
  },
];

/** A deal the recipes don't name: still a deal, with a plain hook. */
const PLAIN = {
  hook: { en: 'Hungry? This one’s for you.', ur: 'Bhook lagi hai? Yeh aap ke liye.' },
  cutouts: [cut('pizza', 14, 4, 66, -6)],
};

const BUY_1_GET_1 = {
  hook: { en: 'Lunch hunger? Get two for one.', ur: 'Dopahar ki bhook? Ek ki price mein do.' },
  cutouts: [cut('pizza-pepperoni', 2, 6, 54, -8), cut('pizza', 46, 18, 44, 30)],
};

/** The till's tax-included mark (24 Oct 2026), under either name it may carry; absent = tax on top. */
function taxIncluded(item: PublishedMenuItem): boolean {
  const it = item as PublishedMenuItem & { taxIncluded?: unknown; priceIncludesTax?: unknown };
  return it.taxIncluded === true || it.priceIncludesTax === true;
}

/** A price as the hook writes it: formatCents without its currency word, just the number. */
const rupees = (cents: number) => formatCents(cents).replace(/^Rs\.?\s*/i, '');

/** The tax promise, in numbers: what the same price comes to elsewhere with the tax on top. */
function taxWords(item: PublishedMenuItem): { hook: Words; line: Words } | null {
  const bps = item.taxRateBps > 0 ? item.taxRateBps : 1500;
  const withTax = Math.round((item.basePriceCents * (10_000 + bps)) / 10_000 / 100) * 100;
  if (withTax <= item.basePriceCents) return null;
  const p = rupees(item.basePriceCents);
  const t = rupees(withTax);
  return {
    hook: { en: `Menu says ${p}. Bill says ${t}?`, ur: `Menu pe ${p}… bill pe ${t}?` },
    line: { en: 'Not here: the price you see is the price you pay.', ur: 'Yahan nahi: jo price dekho, wohi do.' },
  };
}

export function gateSlides(
  menu: { categories: readonly PublishedMenuCategory[] } | null,
  opts: { buy1Get1: Pick<Buy1Get1Rules, 'on' | 'opensMinute' | 'closesMinute'> },
): GateSlide[] {
  if (!menu) return [];
  const deals: PublishedMenuItem[] = [];
  const buy1Get1: PublishedMenuItem[] = [];
  for (const c of menu.categories) {
    if (isBuy1Get1Category(c.name)) {
      if (opts.buy1Get1.on) buy1Get1.push(...c.items.filter((i) => i.basePriceCents > 0));
    } else if (isDealSection(sectionTitle(c.name))) {
      deals.push(...c.items.filter((i) => i.basePriceCents > 0));
    }
  }

  const named: Array<{ order: number; slide: GateSlide }> = [];
  const plain: GateSlide[] = [];
  let burgerMeal: { order: number; slide: GateSlide } | null = null;
  let burgerMeals = 0;
  for (const item of deals) {
    const name = drinkFlavourName(item.name.trim());
    const at = RECIPES.findIndex((r) => r.match.test(item.name));
    const included = taxIncluded(item);
    if (at === -1) {
      plain.push({
        key: `deal-${item.posItemId}`,
        hook: PLAIN.hook,
        line: { en: name, ur: name },
        name,
        priceCents: item.basePriceCents,
        from: false,
        taxIncluded: included,
        when: null,
        cutouts: PLAIN.cutouts,
      });
      continue;
    }
    const recipe = RECIPES[at]!;
    // The tax promise leads the Large & Chilled slide, and only when the till charges exactly its price.
    const tax = recipe.id === 'chilled' && included ? taxWords(item) : null;
    const slide: GateSlide = {
      key: `deal-${item.posItemId}`,
      hook: tax?.hook ?? recipe.hook,
      line: tax?.line ?? recipe.line,
      name,
      priceCents: item.basePriceCents,
      from: false,
      taxIncluded: included,
      when: null,
      cutouts: recipe.cutouts,
    };
    if (recipe.id === 'burger-meal') {
      // One slide for the burger meals: the cheapest, "from" its price when there are more.
      burgerMeals++;
      if (!burgerMeal || item.basePriceCents < burgerMeal.slide.priceCents) burgerMeal = { order: at, slide };
      continue;
    }
    named.push({ order: at, slide });
  }
  if (burgerMeal) named.push({ order: burgerMeal.order, slide: { ...burgerMeal.slide, from: burgerMeals > 1 } });
  // The menu's order breaks ties between deals of one recipe.
  named.sort((a, b) => a.order - b.order);

  const slides = named.map((n) => n.slide);
  if (buy1Get1.length > 0) {
    const lowest = Math.min(...buy1Get1.map((i) => i.basePriceCents));
    const hours = buy1Get1WindowWords(opts.buy1Get1);
    const allDay = hours === 'all day';
    slides.splice(Math.min(2, slides.length), 0, {
      key: 'buy-1-get-1',
      hook: BUY_1_GET_1.hook,
      line: { en: 'Buy 1 Get 1 FREE on regular pizzas', ur: 'Regular pizza pe Buy 1 Get 1 FREE' },
      name: 'Buy 1 Get 1 FREE',
      priceCents: lowest,
      from: buy1Get1.length > 1,
      taxIncluded: buy1Get1.every(taxIncluded),
      when: allDay ? null : { en: `${hours} only`, ur: `Sirf ${hours}` },
      cutouts: BUY_1_GET_1.cutouts,
    });
  }
  return [...slides, ...plain].slice(0, GATE_SLIDES_MAX);
}
