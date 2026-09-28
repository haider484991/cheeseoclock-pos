import type {
  PublishedMenu,
  PublishedMenuItem,
  PublishedModifierGroup,
} from '@cheeseoclock/shared-types';
import { groupDisplayName, orderChoiceGroups } from '@cheeseoclock/shared-types';
import { feeItemIdsOf, isDeliveryChargeItem } from './delivery-zones';
import type { PublicMenu } from './public-menu';

/**
 * Turns the POS's published menu into what the ordering page shows.
 *
 * The till has no size concept: a pizza in two sizes is two items named
 * "Fajita Pizza — Medium" and "Fajita Pizza — Large" (the menu import's
 * sibling convention). Customers think in one pizza with a size picker, so
 * siblings in the same category fold into one card whose variants keep their
 * own posItemId — the cart and the order still carry the exact till item.
 *
 * Pure and unit-tested; the component only renders what comes out of here.
 */

export interface MenuVariant {
  /** "Medium", "Large", "345 ml" … or null for an item sold in one size. */
  size: string | null;
  item: PublishedMenuItem;
  /**
   * This size can't be delivered: the till set THIS item "Pick-up only"
   * (v0.7.30, `pickupOnly: true`), or the card's words say "pick-up only"
   * (today's rule, which has always covered the whole card). Each size is its
   * own till item, so one size set pick-up only leaves the others deliverable
   * — as the server has it (order-validation validateOrderable, per item).
   */
  pickupOnly: boolean;
}

export interface MenuCard {
  /** Stable React key: the first variant's till id. */
  key: string;
  name: string;
  description: string | null;
  /** The till's photo when it sent one, else a real shop photo, else null. */
  image: string | null;
  /** Cheapest first, so Medium sits left of Large. */
  variants: MenuVariant[];
  /**
   * EVERY size is pick-up only (the printed menu's "Pick up only", or the till
   * set each one so): the whole card is. One size of several set pick-up only
   * leaves this false — that size's own `pickupOnly` says it.
   */
  pickupOnly: boolean;
}

export interface MenuSectionView {
  id: string;
  name: string;
  /** Anchor for the category rail. */
  anchor: string;
  cards: MenuCard[];
}

const SIZE_SEPARATOR = /\s+[—–]\s+/;

/** "Fajita Pizza — Medium" → { base: "Fajita Pizza", size: "Medium" }. */
export function splitSizedName(name: string): { base: string; size: string | null } {
  const parts = name.split(SIZE_SEPARATOR);
  if (parts.length < 2) return { base: name.trim(), size: null };
  const size = parts.pop()!.trim();
  return { base: parts.join(' — ').trim(), size: size || null };
}

/**
 * Sized items that are not pizzas: fries come Regular / Large and drinks
 * 345 ml / 1 litre, with no inches (partner, 27 Sep 2026: the masala fries
 * read "Large 12"").
 */
const NOT_PIZZA = /\b(?:fries|drinks?|nuggets|wings|burgers?|dips?|shakes?|juices?|water)\b/i;

/** Is this base name ("Fajita Pizza", "Crown Crust", "Fries") a pizza? */
export function isPizzaName(base: string): boolean {
  return !NOT_PIZZA.test(base);
}

/** Inches only on pizzas, where the shop prints them (Medium 9", Large 12"). */
export function sizeLabel(size: string | null, base: string): string {
  if (!size) return '';
  if (!isPizzaName(base)) return size;
  const s = size.toLowerCase();
  if (s === 'medium') return 'Medium 9"';
  if (s === 'large') return 'Large 12"';
  return size;
}

/**
 * A card's size words: none for a one-size item that is not a pizza (the
 * printed menu shows the masala fries with no size), else sizeLabel.
 */
export function cardSizeLabel(card: Pick<MenuCard, 'name' | 'variants'>, size: string | null): string {
  if (card.variants.length === 1 && !isPizzaName(card.name)) return '';
  return sizeLabel(size, card.name);
}

/**
 * The till sells soft drinks by flavour under their brand names (owner
 * 2026-09-27: "Pepsi, Mirinda, Diet …") — fine on the till, the kitchen ticket
 * and the receipt. Customers never see a brand (owner 2026-09-25: "we are not
 * an affiliate of Pepsi"), so on the website each flavour reads as what it is.
 * Diet first, so "Diet Pepsi" is not read as "Pepsi". The menu import's
 * DRINK_FLAVOURS lists the till's flavours (DRINK_GENERIC there names each one's
 * word here): a new brand there needs a line here. Until it has one, a drink
 * choice with it reads "Soft drink" (drinkChoiceName), never the brand.
 */
const DRINK_FLAVOURS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdiet[\s-]*(?:pepsi|coke|coca[\s-]*cola)\b/gi, 'Diet cola'],
  [/\b(?:pepsi|coca[\s-]*cola|coke)\b/gi, 'Cola'],
  [/\b(?:7[\s-]*up|seven[\s-]*up|sprite)\b/gi, 'Lemon-lime'],
  [/\b(?:mirinda|fanta)\b/gi, 'Orange'],
  [/\b(?:mountain|mtn)[\s-]*dew\b/gi, 'Citrus'],
];

/**
 * A drink choice or item name as customers read it: "Pepsi" → "Cola",
 * "Diet Pepsi 1 litre" → "Diet cola 1 litre", "Mirinda 345 ml" → "Orange 345 ml",
 * "Add 7Up" → "Add lemon-lime". Any case; the size after it is kept as it is.
 */
export function drinkFlavourName(name: string): string {
  let out = name;
  for (const [brand, generic] of DRINK_FLAVOURS) {
    out = out.replace(brand, (_match: string, offset: number) => (offset === 0 ? generic : generic.toLowerCase()));
  }
  return out;
}

/** What a drink choice may read as: the flavours above, and plain words that name no brand. */
const GENERIC_DRINKS = new Set([
  ...DRINK_FLAVOURS.map(([, generic]) => generic.toLowerCase()),
  'soft drink',
  'diet',
  'diet soft drink',
  'water',
  'mineral water',
]);

/** The size at the end of a drink choice: "345 ml", "1 litre", "1.5L", "Can". */
const DRINK_SIZE_SUFFIX = /\s+(\d+(?:[.,]\d+)?\s*(?:ml|l|ltr|litres?|liters?)|cans?|bottles?)$/i;

/**
 * A choice in a drink group as customers read it, failing closed: "Mirinda
 * 345 ml" → "Orange 345 ml", but a flavour with no generic word above — a
 * brand the till started selling since ("Sting 345 ml") — reads "Soft drink
 * 345 ml", never its own name. The size is kept as the till wrote it.
 */
export function drinkChoiceName(name: string): string {
  const trimmed = name.trim();
  const size = DRINK_SIZE_SUFFIX.exec(trimmed);
  const flavour = drinkFlavourName(size ? trimmed.slice(0, size.index) : trimmed).trim();
  const label = GENERIC_DRINKS.has(flavour.toLowerCase()) ? flavour : 'Soft drink';
  return size ? `${label} ${size[1]!}` : label;
}

/**
 * Groups whose every choice is a drink, where an unknown flavour fails closed:
 * "Add a drink", a deal's "Deal: 1 litre drink", and a soft drink's own
 * flavour ("Choose a flavour · 345 ml" on "Soft Drink — 345 ml") — a required
 * or flavour group on a drink, or on an item in the drinks section.
 */
function isDrinkChoiceGroup(
  sectionName: string,
  itemName: string,
  group: Pick<PublishedModifierGroup, 'name' | 'isRequired'>,
): boolean {
  if (isDrinkGroup(group)) return true;
  const drinkItem =
    /\b(?:drinks?|beverages?)\b/i.test(sectionName) || /\bdrinks?\b/i.test(splitSizedName(itemName).base);
  return drinkItem && (group.isRequired || /\bflavou?rs?\b/i.test(groupDisplayName(group.name)));
}

/**
 * A drink group's choices by flavour (drinkChoiceName). Two that read the same
 * — two brands the site has no word for — are numbered, so the customer can
 * still tell them apart: "Soft drink 345 ml (1)", "Soft drink 345 ml (2)".
 */
function drinkChoices<M extends { name: string }>(modifiers: readonly M[]): M[] {
  const labels = modifiers.map((m) => drinkChoiceName(m.name));
  const total = new Map<string, number>();
  for (const l of labels) total.set(l.toLowerCase(), (total.get(l.toLowerCase()) ?? 0) + 1);
  const seen = new Map<string, number>();
  return modifiers.map((m, i) => {
    const label = labels[i]!;
    const key = label.toLowerCase();
    if ((total.get(key) ?? 0) < 2) return { ...m, name: label };
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { ...m, name: `${label} (${n})` };
  });
}

/**
 * The shop sells soft drinks, not a brand (owner 2026-09-25: "we are not an
 * affiliate of Pepsi"). Deals the till published before then read "+ 1 litre
 * Pepsi"; whatever the till sends, the site never names the brand.
 */
export function withoutDrinkBrand(text: string | null): string | null {
  return text === null ? null : drinkFlavourName(text.replace(/\bpepsi\b/gi, 'soft drink'));
}

/**
 * The whole published menu without a brand — names of sections, items, choice
 * groups and choices, and descriptions — for anything that ships it to a
 * browser (the ordering page's props, /api/menu, the JSON-LD) and for what an
 * order stores. A drink group's choices fail closed (drinkChoiceName). Ids and
 * prices are untouched, so an order still names the till's own items and choices.
 */
export function menuWithoutDrinkBrand<M extends Pick<PublishedMenu, 'categories'>>(menu: M): M {
  return {
    ...menu,
    categories: menu.categories.map((c) => ({
      ...c,
      name: drinkFlavourName(c.name),
      items: c.items.map((i) => ({
        ...i,
        name: drinkFlavourName(i.name),
        description: withoutDrinkBrand(i.description),
        modifierGroups: i.modifierGroups.map((g) => ({
          ...g,
          name: drinkFlavourName(g.name),
          modifiers: isDrinkChoiceGroup(c.name, i.name, g)
            ? drinkChoices(g.modifiers)
            : g.modifiers.map((m) => ({ ...m, name: drinkFlavourName(m.name) })),
        })),
      })),
    })),
  };
}

/**
 * A placed order's lines without a brand, for the tracking page. An order
 * placed while the till's menu named brands keeps those names (the till reads
 * an order by its ids); what goes back to the customer reads as the menu did.
 * Anything that is not an order line is passed through untouched.
 */
export function orderItemsWithoutDrinkBrand(items: unknown): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((line: unknown) => {
    if (!line || typeof line !== 'object') return line;
    const l = line as { name?: unknown; modifiers?: unknown };
    return {
      ...l,
      ...(typeof l.name === 'string' ? { name: drinkFlavourName(l.name) } : {}),
      ...(Array.isArray(l.modifiers)
        ? {
            modifiers: l.modifiers.map((m: unknown) =>
              m && typeof m === 'object' && typeof (m as { name?: unknown }).name === 'string'
                ? { ...m, name: drinkFlavourName((m as { name: string }).name) }
                : m,
            ),
          }
        : {}),
    };
  });
}

/**
 * The item can't be delivered: the till set it "Pick-up only" (v0.7.30,
 * `pickupOnly: true` in the publish), or — today's rule, kept as the
 * fallback for a till that does not send the flag — its description says
 * "pick-up only" (the printed menu's words).
 */
export function isPickupOnly(item: Pick<PublishedMenuItem, 'description' | 'pickupOnly'>): boolean {
  return item.pickupOnly === true || saysPickupOnly(item.description);
}

/** The printed menu's words: the description says "pick-up only" ("Pick up only.", "pickup only"). */
function saysPickupOnly(description: string | null | undefined): boolean {
  return /\bpick[\s-]?up only\b/i.test(description ?? '');
}

/**
 * Can this size go in the cart now? A pick-up-only size only while online
 * pick-up is on. The one rule for the card's size buttons, the choices
 * sheet's sizes and its Add, and the add to the cart; the checkout and the
 * server still refuse a delivery with it (checkout-validation, the order
 * route).
 */
export function sizeOrderable(variant: Pick<MenuVariant, 'pickupOnly'>, canPickup: boolean): boolean {
  return !variant.pickupOnly || canPickup;
}

/**
 * The card's "pick-up only" words beside its size buttons: 'Pick-up only'
 * when the whole card is (as before), the sizes that are when only some are
 * ('Large 12" pick-up only'), else null.
 */
export function pickupOnlyNote(card: Pick<MenuCard, 'name' | 'variants' | 'pickupOnly'>): string | null {
  if (card.pickupOnly) return 'Pick-up only';
  const sizes = card.variants.filter((v) => v.pickupOnly).map((v) => cardSizeLabel(card, v.size) || v.item.name);
  if (sizes.length === 0) return null;
  return `${sizes.join(', ')} pick-up only`;
}

/**
 * Real photos of the shop's own food (public/images/menu), keyed by the base
 * item name in lower case. Only items that were actually photographed — a
 * regular pizza gets no stand-in picture of a different pizza.
 */
const SHOP_PHOTOS: Record<string, string> = {
  'shawarma pizza': '/images/menu/shawarma-pizza.webp',
  'crown crust': '/images/menu/crown-crust.webp',
  'cheesy star': '/images/menu/cheesy-star.webp',
  'meat lovers': '/images/menu/meat-lovers.webp',
  cheetos: '/images/menu/cheetos.webp',
  'signature cheese dipped': '/images/menu/signature-cheese-dipped.webp',
};

export function shopPhotoFor(baseName: string): string | null {
  return SHOP_PHOTOS[baseName.trim().toLowerCase()] ?? null;
}

/**
 * The till's category names are short ("Pizza"); the website uses the printed
 * menu's headings so the deals line "choice of pizzas only from the regular
 * menu" points at a section actually called that.
 */
const SECTION_TITLES: Record<string, string> = {
  pizza: 'Regular Pizzas',
  pizzas: 'Regular Pizzas',
};

export function sectionTitle(categoryName: string): string {
  return SECTION_TITLES[categoryName.trim().toLowerCase()] ?? categoryName;
}

function anchorFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The value deals section, whatever the till calls it ("Value Deals", "Deals"). */
export function isDealSection(sectionName: string): boolean {
  return /\bdeals?\b/i.test(sectionName);
}

/**
 * The value deals lead the ordering page (owner 2026-09-25: "deals should be
 * prominent"); every other section keeps the till's order.
 */
export function buildMenuView(menu: PublicMenu): MenuSectionView[] {
  const sections = buildSections(menu);
  return [...sections.filter((s) => isDealSection(s.name)), ...sections.filter((s) => !isDealSection(s.name))];
}

function buildSections(menu: PublicMenu): MenuSectionView[] {
  const feeItemIds = feeItemIdsOf(menu);
  return [...menu.categories]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((c) => {
      const byBase = new Map<string, MenuCard>();
      const items = [...c.items]
        .filter((i) => !isDeliveryChargeItem(i, feeItemIds))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      for (const item of items) {
        const { base, size } = splitSizedName(item.name);
        const existing = byBase.get(base.toLowerCase());
        if (existing) {
          existing.variants.push({ size, item, pickupOnly: false });
          existing.description ??= withoutDrinkBrand(item.description);
          existing.image ??= item.imageUrl;
          continue;
        }
        byBase.set(base.toLowerCase(), {
          key: item.posItemId,
          name: base,
          description: withoutDrinkBrand(item.description),
          image: item.imageUrl ?? shopPhotoFor(base),
          variants: [{ size, item, pickupOnly: false }],
          pickupOnly: false,
        });
      }
      const cards = [...byBase.values()];
      for (const card of cards) {
        card.variants.sort((a, b) => a.item.basePriceCents - b.item.basePriceCents);
        // The words cover the whole card, as they always have; the till's flag only its own size.
        const saysIt = card.variants.some((v) => saysPickupOnly(v.item.description));
        for (const v of card.variants) v.pickupOnly = saysIt || v.item.pickupOnly === true;
        card.pickupOnly = card.variants.every((v) => v.pickupOnly);
      }
      const name = sectionTitle(c.name);
      return { id: c.posCategoryId, name, anchor: anchorFor(name), cards };
    })
    .filter((s) => s.cards.length > 0);
}

/**
 * Deal slots name their options "Large: Fajita Pizza" so every option stays
 * unique across the deal's groups (a POS import rule). Inside a group already
 * titled "Large pizza" the prefix is noise — show "Fajita Pizza". A drink
 * reads as its flavour, never its brand ("Pepsi 345 ml" → "Cola 345 ml").
 */
export function optionLabel(optionName: string): string {
  const m = /^(?:2nd\s+)?(?:medium|large):\s*(.+)$/i.exec(optionName.trim());
  return drinkFlavourName(m ? m[1]!.trim() : optionName);
}

/**
 * "Deal: 2nd Large pizza" → "2nd Large pizza"; "Leave out · Fajita Pizza" →
 * "Leave out" (till group names are unique, so each item's leave-outs carry its
 * name after " · "); "Choose 5 veggies" that takes 1–5 → "Choose up to 5
 * veggies"; "Choose a flavour · 345 ml" → "Choose a flavour"; other groups
 * unchanged, never with a drink brand in them.
 */
export function groupLabel(
  group: Pick<PublishedModifierGroup, 'name'> & Partial<Pick<PublishedModifierGroup, 'minSelect' | 'maxSelect'>>,
): string {
  const limits =
    group.minSelect !== undefined && group.maxSelect !== undefined
      ? { minSelect: group.minSelect, maxSelect: group.maxSelect }
      : undefined;
  return drinkFlavourName(
    groupDisplayName(group.name, limits).replace(/^deal:\s*/i, '').replace(/^.+?\s+[—–]\s+/, '').trim(),
  );
}

/** A deal's drink ("Deal: 1 litre drink"), which its description prices — not a pizza slot. */
function isDrinkGroup(group: Pick<PublishedModifierGroup, 'name'>): boolean {
  return /\b(?:drinks?|beverages?)\b/i.test(groupDisplayName(group.name));
}

/**
 * What customers read about allergies (owner 2026-09-26). It names no
 * allergen on purpose: a list the kitchen does not keep up to date is worse
 * than none. Same words as the printed menu.
 */
export const ALLERGY_NOTICE =
  'Allergy? Tell us in the item\u2019s \u201cAllergy or special request\u201d box and we\u2019ll leave ingredients out. Our kitchen shares equipment, so we can\u2019t guarantee any dish is allergen-free.';

/**
 * What a value deal's contents cost bought one by one, from the live menu, so
 * the page can say "Save Rs 650" without a hard-coded number: each pizza slot
 * at the cheapest regular pizza of its size ("Large: Fajita Pizza" → the
 * "Fajita Pizza — Large" item), plus the drink its description promises
 * ("… + 1 litre soft drink" → the 1 litre drink item). Null when anything can't be
 * priced — then the page shows no saving rather than a wrong one.
 */
export function dealWorthCents(menu: PublicMenu, deal: PublishedMenuItem): number | null {
  if (deal.modifierGroups.length === 0) return null;
  const all = menu.categories.flatMap((c) => c.items);
  const priceOf = new Map<string, number>();
  for (const it of all) {
    const { base, size } = splitSizedName(it.name);
    if (size) priceOf.set(`${base}|${size}`.toLowerCase(), it.basePriceCents);
  }

  let worth = 0;
  let slots = 0;
  for (const group of deal.modifierGroups) {
    // Only the pizza slots are the deal's contents. Optional groups the till
    // hangs on every item ("Dips on the side", paid extras) are add-ons, and
    // counting them made every deal unpriceable — the Save badge vanished.
    if (requiredCount(group) === 0) continue;
    // The deal's drink flavour (owner 2026-09-27) costs nothing extra: the drink
    // itself is priced below, from the description's "1 litre".
    if (isDrinkGroup(group)) continue;
    slots++;
    let cheapest: number | null = null;
    for (const m of group.modifiers) {
      const slot = /^(?:2nd\s+)?(medium|large):\s*(.+)$/i.exec(m.name.trim());
      const price = slot ? priceOf.get(`${slot[2]!.trim()}|${slot[1]}`.toLowerCase()) : undefined;
      if (price !== undefined) cheapest = cheapest === null ? price : Math.min(cheapest, price);
    }
    if (cheapest === null) return null;
    worth += cheapest;
  }
  if (slots === 0) return null;

  if (/\b1\s*lit(?:re|er)\b/i.test(deal.description ?? '')) {
    const drink = all.find((it) => /^1\s*lit(?:re|er)$/i.test(splitSizedName(it.name).size ?? ''));
    if (!drink) return null;
    worth += drink.basePriceCents;
  }
  return worth;
}

/**
 * The item sheet's choice groups, in the order the till asks them too (owner
 * 2026-09-27): what the item cannot be sold without (a deal's pizzas and drink,
 * the dip, the veggies, a drink's flavour), then dips on the side, extras,
 * "Add a drink" and leave-outs. Groups of one
 * kind keep the till's order. The size sits above them all and the allergy
 * note below.
 */
export function sheetGroups(item: Pick<PublishedMenuItem, 'modifierGroups'>): PublishedModifierGroup[] {
  return orderChoiceGroups(item.modifierGroups.slice().sort((a, b) => a.sortOrder - b.sortOrder));
}

/** How many choices a group needs before the item can go in the cart. */
export function requiredCount(group: PublishedModifierGroup): number {
  if (!group.isRequired) return 0;
  return Math.max(1, group.minSelect);
}
