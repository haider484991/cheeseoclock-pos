import type {
  PublishedMenu,
  PublishedMenuItem,
  PublishedModifierGroup,
} from '@cheeseoclock/shared-types';
import { isDeliveryChargeItem } from './delivery-zones';

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
  /** Printed menu says "Pick up only" — the website only delivers. */
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

/** Inches only where the shop prints them (Medium 9", Large 12"). */
export function sizeLabel(size: string | null): string {
  if (!size) return '';
  const s = size.toLowerCase();
  if (s === 'medium') return 'Medium 9"';
  if (s === 'large') return 'Large 12"';
  return size;
}

export function isPickupOnly(item: Pick<PublishedMenuItem, 'description'>): boolean {
  return /\bpick[\s-]?up only\b/i.test(item.description ?? '');
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
export function buildMenuView(menu: PublishedMenu): MenuSectionView[] {
  const sections = buildSections(menu);
  return [...sections.filter((s) => isDealSection(s.name)), ...sections.filter((s) => !isDealSection(s.name))];
}

function buildSections(menu: PublishedMenu): MenuSectionView[] {
  return [...menu.categories]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((c) => {
      const byBase = new Map<string, MenuCard>();
      const items = [...c.items]
        .filter((i) => !isDeliveryChargeItem(i))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      for (const item of items) {
        const { base, size } = splitSizedName(item.name);
        const existing = byBase.get(base.toLowerCase());
        if (existing) {
          existing.variants.push({ size, item });
          existing.description ??= item.description;
          existing.image ??= item.imageUrl;
          existing.pickupOnly ||= isPickupOnly(item);
          continue;
        }
        byBase.set(base.toLowerCase(), {
          key: item.posItemId,
          name: base,
          description: item.description,
          image: item.imageUrl ?? shopPhotoFor(base),
          variants: [{ size, item }],
          pickupOnly: isPickupOnly(item),
        });
      }
      const cards = [...byBase.values()];
      for (const card of cards) {
        card.variants.sort((a, b) => a.item.basePriceCents - b.item.basePriceCents);
      }
      const name = sectionTitle(c.name);
      return { id: c.posCategoryId, name, anchor: anchorFor(name), cards };
    })
    .filter((s) => s.cards.length > 0);
}

/**
 * Deal slots name their options "Large: Fajita Pizza" so every option stays
 * unique across the deal's groups (a POS import rule). Inside a group already
 * titled "Large pizza" the prefix is noise — show "Fajita Pizza".
 */
export function optionLabel(optionName: string): string {
  const m = /^(?:2nd\s+)?(?:medium|large):\s*(.+)$/i.exec(optionName.trim());
  return m ? m[1]!.trim() : optionName;
}

/** "Deal: 2nd Large pizza" → "2nd Large pizza"; other groups unchanged. */
export function groupLabel(group: Pick<PublishedModifierGroup, 'name'>): string {
  return group.name.replace(/^deal:\s*/i, '').replace(/^.+?\s+[—–]\s+/, '').trim();
}

/**
 * What a value deal's contents cost bought one by one, from the live menu, so
 * the page can say "Save Rs 650" without a hard-coded number: each pizza slot
 * at the cheapest regular pizza of its size ("Large: Fajita Pizza" → the
 * "Fajita Pizza — Large" item), plus the drink its description promises
 * ("… + 1 litre Pepsi" → the 1 litre soft drink). Null when anything can't be
 * priced — then the page shows no saving rather than a wrong one.
 */
export function dealWorthCents(menu: PublishedMenu, deal: PublishedMenuItem): number | null {
  if (deal.modifierGroups.length === 0) return null;
  const all = menu.categories.flatMap((c) => c.items);
  const priceOf = new Map<string, number>();
  for (const it of all) {
    const { base, size } = splitSizedName(it.name);
    if (size) priceOf.set(`${base}|${size}`.toLowerCase(), it.basePriceCents);
  }

  let worth = 0;
  for (const group of deal.modifierGroups) {
    let cheapest: number | null = null;
    for (const m of group.modifiers) {
      const slot = /^(?:2nd\s+)?(medium|large):\s*(.+)$/i.exec(m.name.trim());
      const price = slot ? priceOf.get(`${slot[2]!.trim()}|${slot[1]}`.toLowerCase()) : undefined;
      if (price !== undefined) cheapest = cheapest === null ? price : Math.min(cheapest, price);
    }
    if (cheapest === null) return null;
    worth += cheapest;
  }

  if (/\b1\s*lit(?:re|er)\b/i.test(deal.description ?? '')) {
    const drink = all.find((it) => /^1\s*lit(?:re|er)$/i.test(splitSizedName(it.name).size ?? ''));
    if (!drink) return null;
    worth += drink.basePriceCents;
  }
  return worth;
}

/** How many choices a group needs before the item can go in the cart. */
export function requiredCount(group: PublishedModifierGroup): number {
  if (!group.isRequired) return 0;
  return Math.max(1, group.minSelect);
}
