import {
  buy1Get1WindowWords,
  isBuy1Get1Category,
  type Buy1Get1Rules,
  type PublishedMenuCategory,
  type PublishedMenuItem,
} from '@cheeseoclock/shared-types';
import {
  anchorFor,
  drinkFlavourName,
  isDealSection,
  isPickupOnly,
  sectionTitle,
  withoutDrinkBrand,
} from './menu-view';
import { curatedDealWhat } from './signatures';

/**
 * The home hero's deals slider (the user, 14 Oct 2026: "on the home page in
 * hero section there should be beautiful slider of our deals burgers deals
 * and all deals really modern but simple", with four photos for it): one
 * slide per kind of deal on the PUBLISHED menu — the burger deals, the pizza
 * deals, Buy 1 Get 1 (only while the owner has it on) and the burgers — each
 * with the menu's names and prices (a Publish moves them), the user's photo
 * and a link to its section on /menu. A kind the menu has none of has no
 * slide; the menu unknown, no slider.
 *
 *  - Kinds: the value deals section(s) split by their words (a burger deal
 *    names a burger and no pizza; every other value deal is a pizza deal —
 *    "Value deals" when one of them names no pizza); the Buy 1 Get 1 section;
 *    the section called Burgers.
 *  - Rows: cheapest first, at most HERO_ROWS_MAX (the rest counted: "and 2
 *    more on the menu"); a deal's trailing "Deal" dropped under its heading;
 *    never a drink brand (drinkFlavourName, withoutDrinkBrand); never at a zero price;
 *    an item the till set "Pick-up only" says so (menu-view isPickupOnly).
 *  - The line under a heading is said only when every row bears it out
 *    ("Burger, regular fries and a 345 ml drink" needs all three in every
 *    burger deal's description).
 *
 * Pure: the database read is lib/site-facts (getHeroSlides).
 */

export type HeroSlideKind = 'burger-deals' | 'pizza-deals' | 'buy-1-get-1' | 'burgers';

/** A slide's photo (public/images/hero, a 640px copy in sm/). */
export interface HeroPhoto {
  src: string;
  srcSet: string;
  width: number;
  height: number;
  alt: string;
  /** Where the food sits when the frame crops the photo (CSS object-position). */
  position: string;
}

export interface HeroRow {
  name: string;
  /** What is in a pizza deal ('2 Large 12"'); null = nothing to add to the name. */
  what: string | null;
  priceCents: number;
  pickupOnly: boolean;
}

export interface HeroSlide {
  kind: HeroSlideKind;
  /** The slide's big heading. */
  title: string;
  /** The tab's words under the slider. */
  tab: string;
  /** The line under the heading; null = none holds for every row. */
  line: string | null;
  rows: HeroRow[];
  /** How many more of this kind the menu has than the slide lists. */
  more: number;
  /** The button's words, and where it goes on /menu (the section's own anchor). */
  cta: string;
  href: string;
  photo: HeroPhoto;
  /** The words' panel: ink beside a yellow photo, cheese beside the dark one. */
  tone: 'ink' | 'cheese';
}

/** At most this many prices on one slide. */
export const HERO_ROWS_MAX = 4;

function photo(
  name: string,
  width: number,
  height: number,
  alt: string,
  position = '50% 50%',
): HeroPhoto {
  return {
    src: `/images/hero/${name}.webp`,
    srcSet: `/images/hero/sm/${name}.webp 640w, /images/hero/${name}.webp ${width}w`,
    width,
    height,
    alt,
    position,
  };
}

/** The user's four photos (14 Oct 2026), one per kind. */
export const HERO_PHOTOS: Readonly<Record<HeroSlideKind, HeroPhoto>> = Object.freeze({
  'burger-deals': photo(
    'crispy-burger',
    843,
    841,
    'A crispy chicken burger with melted cheese in a sesame brioche bun',
    '50% 46%',
  ),
  'pizza-deals': photo(
    'spread-dark',
    1200,
    878,
    'Pizzas in yellow boxes, with burgers, fries and wings',
  ),
  'buy-1-get-1': photo(
    'spread-yellow',
    1200,
    878,
    'A pizza with a long cheese pull, with burgers, loaded fries and wings around it',
  ),
  burgers: photo(
    'nashville-burger',
    1200,
    800,
    'A Nashville hot chicken burger with coleslaw in a sesame brioche bun',
  ),
});

const BURGER_WORDS = /\b(?:burgers?|crispy|cripsy|zinger|nashville|fillet|cheese\s*dip(?:ped)?)\b/i;
const PIZZA_WORDS = /\bpizzas?\b/i;
const DRINK_WORDS = /\b(?:drinks?|litres?|liters?|ml|cola|soft)\b/i;

const wordsOf = (item: PublishedMenuItem) =>
  `${item.name} ${withoutDrinkBrand(item.description) ?? ''}`;
const every = (
  items: readonly PublishedMenuItem[],
  re: RegExp,
  text: (i: PublishedMenuItem) => string = wordsOf,
) => items.length > 0 && items.every((i) => re.test(text(i)));

/** Cheapest first (the till's own order among equal prices); never one at a zero price. */
function priced(items: readonly PublishedMenuItem[]): PublishedMenuItem[] {
  return items
    .map((item, at) => ({ item, at }))
    .filter(({ item }) => item.basePriceCents > 0)
    .sort(
      (a, b) =>
        a.item.basePriceCents - b.item.basePriceCents ||
        a.item.sortOrder - b.item.sortOrder ||
        a.at - b.at,
    )
    .map(({ item }) => item);
}

/** "Classic Crispy Deal" under "Burger deals" reads "Classic Crispy". */
function rowName(name: string, dropDeal: boolean): string {
  const shown = drinkFlavourName(name.trim());
  const without = dropDeal ? shown.replace(/\s+deal$/i, '').trim() : shown;
  return without || shown;
}

/** What is in a pizza deal, without its drink: the curated words for today's deals, else the till's description. */
function dealContents(item: PublishedMenuItem): string | null {
  const words = curatedDealWhat(item.name) ?? withoutDrinkBrand(item.description) ?? '';
  const parts = words
    .split('+')
    .map((p) => p.trim().replace(/\.$/, ''))
    .filter((p) => p !== '' && !DRINK_WORDS.test(p));
  return parts.length > 0 ? parts.join(' + ') : null;
}

function rowsOf(
  items: readonly PublishedMenuItem[],
  opts: { dropDeal: boolean; contents: boolean },
): Pick<HeroSlide, 'rows' | 'more'> {
  const all = priced(items);
  return {
    rows: all.slice(0, HERO_ROWS_MAX).map((i) => ({
      name: rowName(i.name, opts.dropDeal),
      what: opts.contents ? dealContents(i) : null,
      priceCents: i.basePriceCents,
      pickupOnly: isPickupOnly(i),
    })),
    more: Math.max(0, all.length - HERO_ROWS_MAX),
  };
}

function burgerDealsLine(items: readonly PublishedMenuItem[]): string | null {
  if (!every(items, /\bfries\b/i) || !every(items, /\bdrinks?\b/i)) return null;
  const fries = every(items, /\bregular\s+fries\b/i) ? 'regular fries' : 'fries';
  const drink = every(items, /\b345\s*ml\b/i)
    ? 'a 345 ml drink'
    : every(items, /\b1\s*lit(?:re|er)\b/i)
      ? 'a 1 litre drink'
      : 'a drink';
  return `Burger, ${fries} and ${drink}`;
}

function pizzaDealsLine(items: readonly PublishedMenuItem[]): string | null {
  const text = (i: PublishedMenuItem) => `${curatedDealWhat(i.name) ?? ''} ${wordsOf(i)}`;
  const regular = every(items, /\bregular\b/i, text);
  const litre = every(items, /\b1\s*lit(?:re|er)\b/i, text);
  if (regular && litre) return 'Your choice of regular pizzas, with a 1 litre soft drink';
  if (regular) return 'Your choice of regular pizzas';
  return litre ? 'Every deal comes with a 1 litre soft drink' : null;
}

function burgersLine(items: readonly PublishedMenuItem[]): string | null {
  return every(items, /\bbrioche\b/i) && every(items, /\b(?:crispy|fillet)\b/i)
    ? 'Crispy chicken fillet in a brioche bun'
    : null;
}

/**
 * The deals' hours from the owner's rules: "1–7 PM only", "All day". Never the days: the deals are sold
 * whenever the shop is open, and the hours line says which days that is.
 */
function buy1Get1Line(rules: Pick<Buy1Get1Rules, 'opensMinute' | 'closesMinute'>): string {
  const words = buy1Get1WindowWords(rules);
  return words === 'all day' ? 'All day' : `${words} only`;
}

const isBurgersSection = (name: string) => /^(?:chicken\s+|crispy\s+)?burgers?$/i.test(name.trim());

/**
 * The slides for this menu (null = the menu unknown: no slider). `buy1Get1`:
 * the owner's rules (off = no Buy 1 Get 1 slide, as /menu sells none).
 */
export function heroSlides(
  menu: { categories: readonly PublishedMenuCategory[] } | null,
  opts: { buy1Get1: Pick<Buy1Get1Rules, 'on' | 'opensMinute' | 'closesMinute'> },
): HeroSlide[] {
  if (!menu) return [];
  const burgerDeals: PublishedMenuItem[] = [];
  const otherDeals: PublishedMenuItem[] = [];
  const buy1Get1: PublishedMenuItem[] = [];
  const burgers: PublishedMenuItem[] = [];
  let dealsHref: string | null = null;
  let buy1Get1Href: string | null = null;
  let burgersHref: string | null = null;
  for (const c of menu.categories) {
    const title = sectionTitle(c.name);
    const href = `/menu#${anchorFor(title)}`;
    if (isBuy1Get1Category(c.name)) {
      if (!opts.buy1Get1.on) continue;
      buy1Get1.push(...c.items);
      buy1Get1Href ??= href;
    } else if (isDealSection(title)) {
      for (const item of c.items)
        (BURGER_WORDS.test(wordsOf(item)) && !PIZZA_WORDS.test(wordsOf(item))
          ? burgerDeals
          : otherDeals
        ).push(item);
      dealsHref ??= href;
    } else if (isBurgersSection(c.name)) {
      burgers.push(...c.items);
      burgersHref ??= href;
    }
  }

  const slides: HeroSlide[] = [];
  const add = (slide: Omit<HeroSlide, 'photo'>) => {
    if (slide.rows.length > 0) slides.push({ ...slide, photo: HERO_PHOTOS[slide.kind] });
  };
  const burgerDealRows = priced(burgerDeals);
  add({
    kind: 'burger-deals',
    title: 'Burger deals',
    tab: 'Burger deals',
    line: burgerDealsLine(burgerDealRows),
    ...rowsOf(burgerDealRows, { dropDeal: true, contents: false }),
    cta: 'Order a burger deal',
    href: dealsHref ?? '/menu',
    tone: 'ink',
  });
  const pizzaDealRows = priced(otherDeals);
  const allPizza = every(
    pizzaDealRows,
    PIZZA_WORDS,
    (i) => `${curatedDealWhat(i.name) ?? ''} ${wordsOf(i)}`,
  );
  add({
    kind: 'pizza-deals',
    title: allPizza ? 'Pizza deals' : 'Value deals',
    tab: allPizza ? 'Pizza deals' : 'Value deals',
    line: allPizza ? pizzaDealsLine(pizzaDealRows) : null,
    ...rowsOf(pizzaDealRows, { dropDeal: true, contents: true }),
    cta: allPizza ? 'Order a pizza deal' : 'Order a value deal',
    href: dealsHref ?? '/menu',
    tone: 'cheese',
  });
  add({
    kind: 'buy-1-get-1',
    title: 'Buy 1 Get 1 free',
    tab: 'Buy 1 Get 1',
    line: buy1Get1Line(opts.buy1Get1),
    ...rowsOf(buy1Get1, { dropDeal: false, contents: false }),
    cta: 'Order Buy 1 Get 1',
    href: buy1Get1Href ?? '/menu',
    tone: 'ink',
  });
  const burgerRows = priced(burgers);
  add({
    kind: 'burgers',
    title: 'Burgers',
    tab: 'Burgers',
    line: burgersLine(burgerRows),
    ...rowsOf(burgerRows, { dropDeal: false, contents: false }),
    cta: 'Order a burger',
    href: burgersHref ?? '/menu',
    tone: 'ink',
  });
  return slides;
}
