import { homeLineup, type HomeEntry, type PublishedMenuCategory, type PublishedWebsiteHome } from '@cheeseoclock/shared-types';
import {
  anchorFor,
  dealWorthCents,
  drinkFlavourName,
  isPickupOnly,
  sectionTitle,
  shopPhotoFor,
  sizeLabel,
  splitSizedName,
  withoutDrinkBrand,
} from './menu-view';
import { curatedDealWhat, curatedDish } from './signatures';

/**
 * The home page's featured items (sweep B2): the owner's lineup (Settings →
 * Shop & logo → Home page, 'website.home'; today's five signature pizzas,
 * the Signature Cheese Dipped and the three value deals with none saved)
 * found on the published menu, with the menu's prices and deal worth.
 *
 *  - Found as the till's Home page card finds them (shared-types homeLineup:
 *    the till's id, else the name — case, spaces and ’/' folded — never a
 *    delivery charge). One NOT on the menu (renamed, deleted, off the
 *    website, priced at 0) is left out — its card, its carousel slide, its
 *    deal — never shown at a zero price (the till is told: homeMissing).
 *  - Words: the owner's own (`headline` = the carousel line, `text` = the
 *    card's description / what is in a deal), else the curated words for
 *    today's dishes (lib/signatures), else the till's description. Never a
 *    drink brand (withoutDrinkBrand, drinkFlavourName).
 *  - Pick-up only: an item the till set "Pick-up only" (or whose
 *    description says so: menu-view isPickupOnly, /menu's own rule) says so
 *    on its card, its carousel slide and its deal, in /menu's words
 *    (PICKUP_ONLY_WORDS) — never shown as if it were delivered.
 *  - Photo: the shop's own cut-out photo of today's dishes (menu-view
 *    shopPhotoFor), else the till's photo of the item (served by
 *    api/menu-photo — never inlined into the page), else none (the page
 *    draws a plain panel).
 *  - The menu UNKNOWN (no database, nothing published, a database error with
 *    nothing read yet) is not "missing": the lineup shows with its words and
 *    photos and NO price (there is no price typed anywhere to fall back on).
 *
 * Pure: the database read is lib/site-facts (getHomeView).
 */

/** What the lineup needs of the published menu: its categories without photos, and which items have one. */
export interface LineupMenu {
  categories: readonly PublishedMenuCategory[];
  /** posItemId → a short version of the till's photo (lib/site-facts), for the items that have one. */
  photos?: Readonly<Record<string, string>>;
}

/** A featured pizza or burger as the home page shows it. */
export interface HomeDish {
  /** React key: the name, unique in the lineup. */
  key: string;
  /** "Cheesy Star" (the till's name without its size). */
  name: string;
  /** 'Large 12"' ('' = none). */
  size: string;
  /** The card's small line: 'Signature · Large 12"', 'Signature burger'; another section's item: 'Regular Pizzas · Large 12"'. */
  label: string;
  /** The carousel's word before the size: 'Signature', else the item's /menu section ('Regular Pizzas'). */
  kind: string;
  /** The carousel's line under the name ('' = none). */
  hook: string;
  description: string | null;
  /** The photo's src, or null (a plain panel). */
  image: string | null;
  /** The shop's own cut-out photo (a 400px copy beside it; drawn as it is). */
  shopPhoto: boolean;
  /** The menu's price; null = the menu unknown (no badge). */
  priceCents: number | null;
  /** The item can't be delivered (menu-view isPickupOnly): its card and slide say "Pick-up only". False with the menu unknown. */
  pickupOnly: boolean;
  /** Where "Order it →" goes on /menu: the item's own section there. */
  href: string;
}

/**
 * Where a featured item sits on /menu, and whether it is a signature: its
 * section's anchor (the same one /menu gives it: menu-view sectionTitle +
 * anchorFor), and "signature" when its section or its name says so. Today's
 * lineup reads as always (the Signature Pizzas section; the Signature Cheese
 * Dipped in Burgers); an owner's pick from another section is labelled and
 * linked by that section ("Regular Pizzas · Large 12"", #regular-pizzas),
 * never called a signature. The menu unknown (no item): today's places.
 */
function placeOf(slot: Slot, itemName: string | null, categoryName: string | null): { signature: boolean; section: string; href: string } {
  if (itemName === null || categoryName === null) {
    return slot === 'burger'
      ? { signature: true, section: 'Burgers', href: '/menu#burgers' }
      : { signature: true, section: 'Signature Pizzas', href: '/menu#signature-pizzas' };
  }
  const section = sectionTitle(categoryName);
  const signature = /\bsignature\b/i.test(categoryName) || /\bsignature\b/i.test(itemName);
  return { signature, section, href: `/menu#${anchorFor(section)}` };
}

/** A featured value deal as the home page shows it. */
export interface HomeDeal {
  key: string;
  name: string;
  /** What is in it ("2 Large 12" + 1 litre soft drink"); null = none to say. */
  what: string | null;
  /** The menu's price; null = the menu unknown. */
  priceCents: number | null;
  /** The same food bought one by one (menu-view dealWorthCents); null = can't be priced. */
  worthCents: number | null;
  /** The deal can't be delivered (menu-view isPickupOnly): its card says "Pick-up only". False with the menu unknown. */
  pickupOnly: boolean;
}

export interface HomeView {
  /** The published menu was read (prices shown); false = unknown (no prices). */
  menuKnown: boolean;
  pizzas: HomeDish[];
  burger: HomeDish | null;
  deals: HomeDeal[];
}

/** The till's photo of an item, as the page links it (api/menu-photo; `v` changes with the photo). */
export function tillPhotoSrc(posItemId: string, version: string): string {
  return `/api/menu-photo/${encodeURIComponent(posItemId)}?v=${encodeURIComponent(version)}`;
}

type Slot = 'pizza' | 'burger';

/** Owner's words, never with a drink brand; '' or absent = none. */
function ownWords(text: string | undefined): string | null {
  if (text === undefined) return null;
  const t = withoutDrinkBrand(text.trim());
  return t ? t : null;
}

function dish(
  entry: HomeEntry,
  slot: Slot,
  item: { posItemId: string; name: string; description: string | null; basePriceCents: number; pickupOnly?: boolean } | null,
  photos: Readonly<Record<string, string>> | undefined,
  categoryName: string | null = null,
): Omit<HomeDish, 'key'> {
  const { base, size } = splitSizedName(item ? item.name : entry.itemRef.name);
  const curated = curatedDish(base);
  const shopPhoto = shopPhotoFor(base);
  const photoVersion = item ? photos?.[item.posItemId] : undefined;
  const sizeWords = sizeLabel(size, base);
  const place = placeOf(slot, item ? item.name : null, categoryName);
  const kind = place.signature ? 'Signature' : place.section;
  return {
    name: drinkFlavourName(base),
    size: sizeWords,
    label: slot === 'burger' && place.signature ? 'Signature burger' : sizeWords ? `${kind} · ${sizeWords}` : kind,
    kind,
    hook: ownWords(entry.headline) ?? curated?.hook ?? '',
    description: ownWords(entry.text) ?? curated?.description ?? (item ? withoutDrinkBrand(item.description) : null),
    image: shopPhoto ?? (item && photoVersion ? tillPhotoSrc(item.posItemId, photoVersion) : null),
    shopPhoto: shopPhoto !== null,
    priceCents: item ? item.basePriceCents : null,
    pickupOnly: item ? isPickupOnly(item) : false,
    href: place.href,
  };
}

/** Keys unique within a list: a repeated name takes its size too, then a number. */
function withKeys<T extends { name: string; size?: string }>(list: T[]): Array<T & { key: string }> {
  const seen = new Set<string>();
  return list.map((x) => {
    let key = x.name;
    if (seen.has(key) && x.size) key = `${x.name} · ${x.size}`;
    for (let n = 2; seen.has(key); n++) key = `${x.name} (${n})`;
    seen.add(key);
    return { ...x, key };
  });
}

/**
 * The home page's lineup on this menu (null = the menu unknown). `feeItemIds`:
 * the settings block's delivery charge items (a charge is never featured).
 */
export function resolveHome(
  home: Pick<PublishedWebsiteHome, 'pizzas' | 'burger' | 'deals'>,
  menu: LineupMenu | null,
  feeItemIds?: ReadonlySet<string> | null,
): HomeView {
  if (!menu) {
    const all = withKeys([
      ...home.pizzas.map((e) => dish(e, 'pizza', null, undefined)),
      ...(home.burger ? [dish(home.burger, 'burger', null, undefined)] : []),
    ]);
    return {
      menuKnown: false,
      pizzas: all.slice(0, home.pizzas.length),
      burger: home.burger ? all[home.pizzas.length]! : null,
      deals: withKeys(
        home.deals.map((e) => ({
          name: drinkFlavourName(e.itemRef.name),
          what: ownWords(e.text) ?? curatedDealWhat(e.itemRef.name),
          priceCents: null,
          worthCents: null,
          pickupOnly: false,
        })),
      ),
    };
  }
  const lineup = homeLineup(home, menu, feeItemIds);
  // Each item's section on the menu (its label and its link on /menu).
  const categoryOf = new Map<string, string>();
  for (const c of menu.categories) for (const i of c.items) if (!categoryOf.has(i.posItemId)) categoryOf.set(i.posItemId, c.name);
  const sectionOf = (id: string) => categoryOf.get(id) ?? null;
  const pizzas = lineup.pizzas.flatMap((l) => (l.item ? [dish(l.entry, 'pizza', l.item, menu.photos, sectionOf(l.item.posItemId))] : []));
  const burger = lineup.burger?.item
    ? dish(lineup.burger.entry, 'burger', lineup.burger.item, menu.photos, sectionOf(lineup.burger.item.posItemId))
    : null;
  const dishes = withKeys([...pizzas, ...(burger ? [burger] : [])]);
  return {
    menuKnown: true,
    pizzas: dishes.slice(0, pizzas.length),
    burger: burger ? dishes[pizzas.length]! : null,
    deals: withKeys(
      lineup.deals.flatMap((l) => {
        const item = l.item;
        if (!item) return [];
        return [
          {
            name: drinkFlavourName(item.name),
            what: ownWords(l.entry.text) ?? curatedDealWhat(item.name) ?? withoutDrinkBrand(item.description),
            priceCents: item.basePriceCents,
            worthCents: dealWorthCents(menu, item),
            pickupOnly: isPickupOnly(item),
          },
        ];
      }),
    ),
  };
}

/** The signatures grid: the pizzas, then the burger. */
export function homeDishes(view: HomeView): HomeDish[] {
  return [...view.pizzas, ...(view.burger ? [view.burger] : [])];
}

/**
 * The deals section's two fixed lines ("Every deal comes with a 1 litre soft
 * drink", "Choice of pizzas only from the regular menu") are facts of
 * today's three deals (lib/signatures): they print only while every deal
 * shown is one of them.
 */
export function dealsAreTodays(view: HomeView): boolean {
  return view.deals.every((d) => curatedDealWhat(d.name) !== null);
}

/** The hero's "Value deals from …": the cheapest deal shown with a price, or null. */
export function dealsFromCents(view: HomeView): number | null {
  const prices = view.deals.flatMap((d) => (d.priceCents === null ? [] : [d.priceCents]));
  return prices.length > 0 ? Math.min(...prices) : null;
}

/** A deal's saving: what it is worth one by one less its price — only when that is more than 0. */
export function dealSaveCents(deal: Pick<HomeDeal, 'priceCents' | 'worthCents'>): number | null {
  if (deal.priceCents === null || deal.worthCents === null) return null;
  return deal.worthCents > deal.priceCents ? deal.worthCents - deal.priceCents : null;
}
