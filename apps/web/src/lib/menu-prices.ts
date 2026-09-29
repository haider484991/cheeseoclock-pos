import { matchHomeItem } from '@cheeseoclock/shared-types';
import { formatCents } from './format';
import { isPickupOnly } from './menu-view';

/**
 * The prices the landing pages name (the value deals "from" the cheapest,
 * the four burgers cheapest to dearest, the cheese extra "for" its price),
 * from the published menu (sweep B2): the till's price is the website's,
 * with no copy to keep in step. Page copy
 * writes a token — {price:deals} — and delivery-facts fillFees fills it from
 * here. Which ITEMS a line prices stays in code (the pages' own words name
 * them); what they cost never does (site-copy.test.ts fails on a rupee
 * amount typed by hand).
 *
 * An item is found as the home page finds its featured items (shared-types
 * matchHomeItem: the name — case, spaces and ’/' folded — the first in the
 * menu's order priced above 0, never a delivery charge). A line whose items
 * are all missing, or the menu unknown (no database, nothing published),
 * has no words: its token can't print and the copy takes its `otherwise` —
 * never a zero price, never a stale one.
 *
 * Pure and safe in the browser.
 */

/** What a price line needs of a menu. */
export interface PriceMenu {
  categories: ReadonlyArray<{
    displayOrder: number;
    items: ReadonlyArray<{
      posItemId: string;
      name: string;
      basePriceCents: number;
      sortOrder: number;
      /** A pick-up-only item (the till's flag, or its description says so) is not a delivery price. */
      description?: string | null;
      pickupOnly?: boolean;
      modifierGroups: ReadonlyArray<{ name: string; modifiers: ReadonlyArray<{ name: string; priceDeltaCents: number }> }>;
    }>;
  }>;
}

type PriceLine =
  /** The cheapest of these items, formatCents (the copy says "From …"). */
  | { kind: 'from'; items: readonly string[] }
  /** The cheapest to the dearest of these items, "<low> – <high>" with "Rs" on both (one price: just it). */
  | { kind: 'range'; items: readonly string[] }
  /**
   * The one price of the choices in these groups (`modifier`: only the
   * choices of that name), formatCents. Choices at more than one price have no
   * words (the copy says it another way) — never a wrong "each".
   */
  | { kind: 'each'; group: RegExp; modifier?: string };

/**
 * Every price the pages name, by key ({price:<key>}). The item names are the
 * till's (the menu file import's), as the pages' words name them.
 */
export const PRICE_LINES = {
  /** The pizza page's value deals card. */
  deals: { kind: 'from', items: ['Big Two', 'Family Feast', 'Perfect Pair'] },
  /** The burger page's "4 burgers" card. */
  burgers: {
    kind: 'range',
    items: ['Classic Crispy Chicken', 'Crispy Signature', 'Signature Cheese Dipped', 'Nashville Authentic (Hot)'],
  },
  /** The burger page's sides card (the pick-up-only loaded fries are not a delivery side). */
  sides: {
    kind: 'from',
    items: [
      'Fries — Regular',
      'Fries — Large',
      'Signature Masala Fries — Large',
      'Signature Mayo Masala Fries — Large',
      'Nuggets',
      'Baked Wings',
    ],
  },
  /** The late-night page's masala fries card. */
  masalaFries: { kind: 'from', items: ['Signature Masala Fries — Large', 'Signature Mayo Masala Fries — Large'] },
  /** "Add cheese to any burger for …": the burgers' extra. */
  burgerCheese: { kind: 'each', group: /^extras\b.*\bburgers?\b/i, modifier: 'Add cheese' },
  /** "dips are … each": every choice of the dips on the side. */
  dip: { kind: 'each', group: /^dips on the side\b/i },
} as const satisfies Record<string, PriceLine>;

export type PriceKey = keyof typeof PRICE_LINES;

export function isPriceKey(key: string): key is PriceKey {
  return Object.prototype.hasOwnProperty.call(PRICE_LINES, key);
}

const fold = (s: string) => s.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The prices of the line's items that are on the menu for DELIVERY: every
 * page that names them is a delivery page, so an item the till made
 * pick-up only (menu-view isPickupOnly) does not count, nor does a delivery
 * charge.
 */
function itemPrices(names: readonly string[], menu: PriceMenu, feeItemIds: ReadonlySet<string> | null | undefined): number[] {
  const out: number[] = [];
  for (const name of names) {
    const item = matchHomeItem({ posItemId: null, name }, menu, feeItemIds);
    if (item && !isPickupOnly({ description: item.description ?? null, pickupOnly: item.pickupOnly })) out.push(item.basePriceCents);
  }
  return out;
}

/** The distinct prices of the matching choices, above 0. */
function choicePrices(line: { group: RegExp; modifier?: string }, menu: PriceMenu): Set<number> {
  const want = line.modifier === undefined ? null : fold(line.modifier);
  const prices = new Set<number>();
  for (const c of menu.categories) {
    for (const i of c.items) {
      for (const g of i.modifierGroups) {
        if (!line.group.test(g.name.trim())) continue;
        for (const m of g.modifiers) if (want === null || fold(m.name) === want) prices.add(m.priceDeltaCents);
      }
    }
  }
  return prices;
}

/**
 * A price line's words from this menu (formatCents: a price, or a spaced
 * "low – high" range) — or null when the menu can't say: unknown (null), none of the
 * line's items on it, or its choices at more than one price (or at none
 * above 0). An unknown key throws: a typo in page copy must fail the tests
 * and the build, never print a wrong price.
 */
export function priceWords(
  key: string,
  menu: PriceMenu | null | undefined,
  feeItemIds?: ReadonlySet<string> | null,
): string | null {
  if (!isPriceKey(key)) throw new Error(`Unknown price {price:${key}}`);
  if (!menu) return null;
  const line: PriceLine = PRICE_LINES[key];
  if (line.kind === 'each') {
    const prices = [...choicePrices(line, menu)];
    return prices.length === 1 && prices[0]! > 0 ? formatCents(prices[0]!) : null;
  }
  const prices = itemPrices(line.items, menu, feeItemIds);
  if (prices.length === 0) return null;
  const low = Math.min(...prices);
  if (line.kind === 'from') return formatCents(low);
  const high = Math.max(...prices);
  // Spaced dash, "Rs" on both sides, as the page has always printed it.
  return low === high ? formatCents(low) : `${formatCents(low)} – ${formatCents(high)}`;
}
