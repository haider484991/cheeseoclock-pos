import {
  buy1Get1WindowWords,
  isBuy1Get1Category,
  partAmountCents,
  type Buy1Get1Rules,
  type PublishedMenuCategory,
  type PublishedMenuItem,
  type PublishedPickup,
} from '@cheeseoclock/shared-types';
import {
  anchorFor,
  drinkFlavourName,
  isDealSection,
  isPickupOnly,
  sectionTitle,
  sizeLabel,
  splitSizedName,
  withoutDrinkBrand,
} from './menu-view';
import { curatedDealWhat } from './signatures';

/**
 * The home hero's deals and offers (the user, 14 Oct 2026: "on the home page
 * in hero section there should be beautiful slider of our deals", then "i want
 * all the deals and offers on our website some how but in clean way burger
 * deals pizza offer regular 20 percent off and 1 to 7 pm offers and all" and
 * "the prices should be mention on 20 percent offer"). Everything from the
 * PUBLISHED menu and the owner's website offer (the stored settings block),
 * so a Publish or a Save moves it, in this order:
 *
 *  1. each burger deal, a slide of its own with its own photo (the burger
 *     meal photos the foodpanda chat made, 14 Oct) and its price;
 *  2. each category with its own website % (v0.7.50: "20% off regular
 *     pizzas"), with every size's price before and after — only while the
 *     owner's block says so, so the website charges what the slide says;
 *  3. the pizza deals (every other value deal: "Value deals" when one names
 *     no pizza), cheapest first, with what is in each;
 *  4. Buy 1 Get 1, while the owner has it on, with its hours;
 *  5. the website's % off the rest of the food (pick-up, and delivery when
 *     the owner ticked it), with each section's lowest price before and after
 *     — never on a value deal.
 *
 * Never a drink brand (drinkFlavourName, withoutDrinkBrand), never a zero
 * price, never a day the shop might be shut; an item the till set "Pick-up
 * only" says so. A kind the menu has none of has no slide; the menu unknown,
 * no slider. Pure: the database read is lib/site-facts (getHeroSlides).
 */

export type HeroSlideKind =
  | 'burger-deal'
  | 'category-offer'
  | 'pizza-deals'
  | 'buy-1-get-1'
  | 'online-offer';

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
  /** What is in a pizza deal ('2 Medium 9"'); null = nothing to add to the name. */
  what: string | null;
  /** The price to pay (an offer's: after its %). */
  priceCents: number;
  /** An offer's row: the menu's price before the %, struck through; null = the menu's price is the price. */
  wasCents: number | null;
  /** The row's items are not all at one price: the lowest is shown, "from". */
  from: boolean;
  pickupOnly: boolean;
}

export interface HeroSlide {
  /** Unique among the slides (React key, element ids). */
  key: string;
  kind: HeroSlideKind;
  /** The slides of one kind share a tab (each burger deal has a slide; one tab for them). */
  group: string;
  /** The tab's words under the slider. */
  tab: string;
  /** The slide's big heading. */
  title: string;
  /** The line under the heading; null = none holds. */
  line: string | null;
  /** A single deal's price, shown big (no rows). */
  price: { cents: number; pickupOnly: boolean } | null;
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
/** The website's % slide shows this many sections' prices. */
const ONLINE_ROWS_MAX = 3;

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

/**
 * The photos: the user's four (14 Oct), the three burger meals the foodpanda
 * chat made the same day, and the regular pizzas (the poster's cut-outs, a
 * Large and a Medium at 12:9).
 */
export const HERO_PHOTOS = Object.freeze({
  burgerMeal: photo(
    'crispy-burger',
    843,
    841,
    'A crispy chicken burger with melted cheese in a sesame brioche bun',
    '50% 46%',
  ),
  classicCrispyMeal: photo(
    'deal-classic-crispy-cola',
    1200,
    900,
    'A Classic Crispy burger with mayonnaise and lettuce, a cup of fries and a cold drink',
    '50% 55%',
  ),
  signatureCrispyMeal: photo(
    'deal-signature-crispy-cola',
    1200,
    900,
    'A Crispy Signature burger with orange signature sauce, a cup of fries and a cold drink',
    '50% 55%',
  ),
  cheeseDippedMeal: photo(
    'deal-cheese-dipped-cola',
    1200,
    900,
    'A Cheese Dipped burger in molten cheese with jalapeños, a cup of fries and a cold drink',
    '50% 55%',
  ),
  regularPizzas: photo('regular-pizzas', 1200, 900, 'A Medium and a Large regular pizza'),
  pizzaDeals: photo(
    'spread-dark',
    1200,
    878,
    'Pizzas in yellow boxes, with burgers, fries and wings',
  ),
  buy1Get1: photo(
    'spread-yellow',
    1200,
    878,
    'A pizza with a long cheese pull, with burgers, loaded fries and wings around it',
  ),
  onlineOffer: photo(
    'nashville-burger',
    1200,
    800,
    'A Nashville hot chicken burger with coleslaw in a sesame brioche bun',
  ),
} satisfies Record<string, HeroPhoto>);

/** A burger deal's own meal photo, by the burger in its name; another burger deal: the crispy burger. */
function burgerDealPhoto(item: PublishedMenuItem): HeroPhoto {
  const name = item.name.toLowerCase();
  if (/cheese\s*dip/.test(name)) return HERO_PHOTOS.cheeseDippedMeal;
  if (/classic/.test(name)) return HERO_PHOTOS.classicCrispyMeal;
  if (/signature/.test(name) && /cri(?:sp|ps)y/.test(name)) return HERO_PHOTOS.signatureCrispyMeal;
  return HERO_PHOTOS.burgerMeal;
}

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

/** "Classic Crispy Deal" in a list under "Pizza deals" reads "Classic Crispy". */
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

/** The menu's prices as rows (no %), cheapest first. */
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
      wasCents: null,
      from: false,
      pickupOnly: isPickupOnly(i),
    })),
    more: Math.max(0, all.length - HERO_ROWS_MAX),
  };
}

/** A price after the website's %: rounded once, as the till and the website round it. */
const afterPercent = (cents: number, percent: number) => cents - partAmountCents(cents, percent);

/**
 * A category's prices after its %: one row per size ('Medium 9"', 'Large 12"': the lowest at that size, "from"
 * when they differ), or, with no sizes, its cheapest items.
 */
function offerRows(
  items: readonly PublishedMenuItem[],
  percent: number,
): Pick<HeroSlide, 'rows' | 'more'> {
  const all = priced(items);
  const sized = all.filter((i) => splitSizedName(i.name).size !== null);
  if (sized.length === 0) {
    return {
      rows: all.slice(0, HERO_ROWS_MAX).map((i) => ({
        name: drinkFlavourName(i.name),
        what: null,
        priceCents: afterPercent(i.basePriceCents, percent),
        wasCents: i.basePriceCents,
        from: false,
        pickupOnly: isPickupOnly(i),
      })),
      more: Math.max(0, all.length - HERO_ROWS_MAX),
    };
  }
  const bySize = new Map<string, PublishedMenuItem[]>();
  for (const i of sized) {
    const { base, size } = splitSizedName(i.name);
    const label = sizeLabel(size, base) || size!;
    bySize.set(label, [...(bySize.get(label) ?? []), i]);
  }
  const rows = [...bySize.entries()].map(([label, list]) => {
    const low = list[0]!.basePriceCents;
    return {
      name: label,
      what: null,
      priceCents: afterPercent(low, percent),
      wasCents: low,
      from: list.some((i) => i.basePriceCents !== low),
      pickupOnly: list.every((i) => isPickupOnly(i)),
    };
  });
  return { rows: rows.slice(0, HERO_ROWS_MAX), more: Math.max(0, rows.length - HERO_ROWS_MAX) };
}

function burgerDealLine(item: PublishedMenuItem): string | null {
  const items = [item];
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

/** The deals' hours from the owner's rules: "1–7 PM only", "All day". Never the days (the hours line says those). */
function buy1Get1Line(rules: Pick<Buy1Get1Rules, 'opensMinute' | 'closesMinute'>): string {
  const words = buy1Get1WindowWords(rules);
  return words === 'all day' ? 'All day' : `${words} only`;
}

/** Where the website's % comes off: "pick-up and delivery", "pick-up", "delivery". */
function whereWords(pickup: Pick<PublishedPickup, 'offered' | 'alsoDelivery'>): string {
  if (pickup.offered && pickup.alsoDelivery === true) return 'pick-up and delivery';
  return pickup.offered ? 'pick-up' : 'delivery';
}

/** A section the website's % slide prices: food, not a deal, not a delivery charge, not one with its own %. */
function takesTheMainPercent(c: PublishedMenuCategory, own: ReadonlySet<string>): boolean {
  if (own.has(c.posCategoryId) || isBuy1Get1Category(c.name) || isDealSection(sectionTitle(c.name)))
    return false;
  if (/\bdelivery\b/i.test(c.name)) return false;
  return c.items.some(
    (i) =>
      i.basePriceCents > 0 && i.noDiscount !== true && !/^delivery charge/i.test(i.name.trim()),
  );
}

/**
 * The slides for this menu (null = the menu unknown: no slider). `buy1Get1`:
 * the owner's rules (off = no Buy 1 Get 1 slide, as /menu sells none);
 * `pickup`: the owner's website offer from the stored block (null = no block:
 * no % slides — the till's heartbeat alone decides then).
 */
export function heroSlides(
  menu: { categories: readonly PublishedMenuCategory[] } | null,
  opts: {
    buy1Get1: Pick<Buy1Get1Rules, 'on' | 'opensMinute' | 'closesMinute'>;
    pickup?: Pick<
      PublishedPickup,
      'offered' | 'percent' | 'alsoDelivery' | 'categoryPercents'
    > | null;
  },
): HeroSlide[] {
  if (!menu) return [];
  const pickup = opts.pickup ?? null;
  // The website's % applies at all: pick-up offered, or the delivery % ticked.
  const offering = pickup !== null && (pickup.offered || pickup.alsoDelivery === true);
  const burgerDeals: PublishedMenuItem[] = [];
  const otherDeals: PublishedMenuItem[] = [];
  const buy1Get1: PublishedMenuItem[] = [];
  let dealsHref: string | null = null;
  let buy1Get1Href: string | null = null;
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
    }
  }

  const slides: HeroSlide[] = [];

  // 1. Each burger deal: its own slide, its own photo, its price.
  for (const item of priced(burgerDeals)) {
    slides.push({
      key: `burger-deal-${item.posItemId}`,
      kind: 'burger-deal',
      group: 'burger-deals',
      tab: 'Burger deals',
      title: drinkFlavourName(item.name.trim()),
      line: burgerDealLine(item),
      price: { cents: item.basePriceCents, pickupOnly: isPickupOnly(item) },
      rows: [],
      more: 0,
      cta: 'Order this deal',
      href: dealsHref ?? '/menu',
      photo: burgerDealPhoto(item),
      tone: 'ink',
    });
  }

  // 2. Each category with its own %, while the website prices it: every size's price before and after.
  const own = new Map<string, number>();
  if (offering)
    for (const c of pickup!.categoryPercents ?? [])
      if (c.percent > 0 && !own.has(c.categoryId)) own.set(c.categoryId, c.percent);
  for (const [categoryId, percent] of own) {
    const c = menu.categories.find((x) => x.posCategoryId === categoryId);
    if (!c || isBuy1Get1Category(c.name) || isDealSection(sectionTitle(c.name))) continue;
    const food = c.items.filter((i) => i.noDiscount !== true);
    const { rows, more } = offerRows(food, percent);
    if (rows.length === 0) continue;
    const title = sectionTitle(c.name);
    const pizzas = PIZZA_WORDS.test(title);
    const lastWord = title.trim().split(/\s+/).pop()!.toLowerCase();
    slides.push({
      key: `category-offer-${categoryId}`,
      kind: 'category-offer',
      group: `category-offer-${categoryId}`,
      tab: `${percent}% off ${lastWord}`,
      title: `${percent}% off ${title.toLowerCase()}`,
      line: `Online, on ${whereWords(pickup!)}`,
      price: null,
      rows,
      more,
      cta: pizzas ? 'Order a pizza' : 'Order now',
      href: `/menu#${anchorFor(title)}`,
      photo: pizzas ? HERO_PHOTOS.regularPizzas : HERO_PHOTOS.buy1Get1,
      tone: 'ink',
    });
  }

  // 3. The pizza deals (every other value deal), cheapest first, with what is in each.
  const pizzaDealRows = priced(otherDeals);
  const allPizza = every(
    pizzaDealRows,
    PIZZA_WORDS,
    (i) => `${curatedDealWhat(i.name) ?? ''} ${wordsOf(i)}`,
  );
  if (pizzaDealRows.length > 0) {
    slides.push({
      key: 'pizza-deals',
      kind: 'pizza-deals',
      group: 'pizza-deals',
      tab: allPizza ? 'Pizza deals' : 'Value deals',
      title: allPizza ? 'Pizza deals' : 'Value deals',
      line: allPizza ? pizzaDealsLine(pizzaDealRows) : null,
      price: null,
      ...rowsOf(pizzaDealRows, { dropDeal: true, contents: true }),
      cta: allPizza ? 'Order a pizza deal' : 'Order a value deal',
      href: dealsHref ?? '/menu',
      photo: HERO_PHOTOS.pizzaDeals,
      tone: 'cheese',
    });
  }

  // 4. Buy 1 Get 1, while the owner has it on, with its hours.
  if (priced(buy1Get1).length > 0) {
    slides.push({
      key: 'buy-1-get-1',
      kind: 'buy-1-get-1',
      group: 'buy-1-get-1',
      tab: 'Buy 1 Get 1',
      title: 'Buy 1 Get 1 free',
      line: buy1Get1Line(opts.buy1Get1),
      price: null,
      ...rowsOf(buy1Get1, { dropDeal: false, contents: false }),
      cta: 'Order Buy 1 Get 1',
      href: buy1Get1Href ?? '/menu',
      photo: HERO_PHOTOS.buy1Get1,
      tone: 'ink',
    });
  }

  // 5. The website's % off the rest of the food: each section's lowest price, before and after.
  if (offering && pickup!.percent > 0) {
    const ownIds = new Set(own.keys());
    const rows = menu.categories
      .filter((c) => takesTheMainPercent(c, ownIds))
      .slice(0, ONLINE_ROWS_MAX)
      .map((c): HeroRow => {
        const food = priced(
          c.items.filter((i) => i.noDiscount !== true && !/^delivery charge/i.test(i.name.trim())),
        );
        const low = food[0]!.basePriceCents;
        return {
          name: sectionTitle(c.name),
          what: null,
          priceCents: afterPercent(low, pickup!.percent),
          wasCents: low,
          from: food.some((i) => i.basePriceCents !== low),
          pickupOnly: food.every((i) => isPickupOnly(i)),
        };
      });
    if (rows.length > 0) {
      const where = whereWords(pickup!);
      slides.push({
        key: 'online-offer',
        kind: 'online-offer',
        group: 'online-offer',
        tab: `${pickup!.percent}% off online`,
        title:
          where === 'pick-up and delivery'
            ? `${pickup!.percent}% off online orders`
            : `${pickup!.percent}% off ${where} orders`,
        line:
          own.size > 0
            ? 'On the rest of the menu. Not on value deals.'
            : 'On the menu. Not on value deals.',
        price: null,
        rows,
        more: 0,
        cta: 'Order online',
        href: '/menu',
        photo: HERO_PHOTOS.onlineOffer,
        tone: 'ink',
      });
    }
  }
  return slides;
}
