import { DEFAULT_BUY_1_GET_1_RULES, buy1Get1WindowWords, socialLabel, type Buy1Get1Rules } from '@cheeseoclock/shared-types';
import type { MenuCard, MenuSectionView } from './menu-view';
import { cardSizeLabel } from './menu-view';
import { percentDiscountCents } from './pricing';

/**
 * The offers the menu shows on every item (owner, 5 Oct 2026: "show discount offers on each item to
 * convert more", and the Buy 1 Get 1 poster: 1–7 PM, in-shop, pick-up, delivery and online, "delivery charges
 * and tax may apply" prominent). DISPLAY ONLY: nothing here changes a price. The % off a pick-up (and, once the
 * owner ticks it, a delivery) is still worked out by the cart, the server and the till (lib/pricing); the free
 * item of Buy 1 Get 1 is given the way it always was — the customer tags the shop, shows the post, and the shop
 * takes the free item off the bill. This file only says so, per card.
 *
 * Since 7 Oct 2026 the till sells the offer as Buy 1 Get 1 DEALS (a menu category of their own, shared-types
 * buy-1-get-1: the pizza you pay for with the free item as a choice at no charge). While the menu has them (`dealsOnMenu`),
 * each card's strip says the free item comes in a deal, and the banner has a button to them. The hours, and whether
 * the offer is on at all, are the owner's (Settings → Money & discounts on the till, carried in the settings block:
 * SiteFacts.buy1Get1): switched off, no strip and no banner; the hours print as the owner set them (1–7 PM until
 * changed).
 *
 * Pure and unit-tested (offers.test.ts). The words are one place (OFFER_*): the menu's banner, each card's strip
 * and the checkout's "tag us" hint all read them, so a change of terms is one edit here.
 *
 * Which items: the REGULAR pizzas (the poster's Medium and Large prices) are the "buy"; the
 * burgers (not the Nashville Burger) and the sides are what comes free with a Large; with a Medium only a side,
 * and never Loaded Fries. The Signature pizzas and the value deals carry no Buy 1 Get 1 strip (the poster's
 * prices are the regular ones; deals are never discounted again). Dips and drinks have none either.
 */

/** The offer's hours on the Karachi clock, as the poster prints them ("1–7 PM" until the owner changes them). */
export function offerWindow(rules: Buy1Get1Rules = DEFAULT_BUY_1_GET_1_RULES): string {
  return buy1Get1WindowWords(rules);
}
export const OFFER_HEADLINE = 'Buy 1 Get 1 FREE';
/** Prominent on the poster, and here. */
export const OFFER_FINE_PRINT = 'Delivery charges & tax may apply';
export const OFFER_TAG_LINE = 'Tag us on social media and show us the post to get the free item.';

/** A profile link as the hint names it: "Instagram @cheeseoclock_", "Facebook /cheeseoclock.karachi", else the label alone. */
function profileWords(url: string): string {
  const label = socialLabel(url);
  let first = '';
  try {
    first = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
  } catch {
    // not a link: the label alone
  }
  if (!first) return label;
  return label === 'Instagram' || label === 'TikTok' || label === 'X' ? `${label} @${first.replace(/^@/, '')}` : `${label} /${first}`;
}

/**
 * Under the checkout's social field: how the Tag-us free item is earned, naming the shop's own profiles (the owner's
 * social links) so the customer tags the right account; with none, the shop's name. While the owner has the offer
 * switched off it promises nothing: post and tag us.
 */
export function tagUsHint(shopName: string, socialLinks: readonly string[], rules: Buy1Get1Rules = DEFAULT_BUY_1_GET_1_RULES): string {
  const where = socialLinks.length > 0 ? `tag us (${socialLinks.map(profileWords).join(' · ')})` : `tag ${shopName} on Instagram or Facebook`;
  if (!rules.on) return `Post your meal and ${where}.`;
  return `Post your meal, ${where} and show us the post: your Buy 1 Get 1 item is free (${offerWindow(rules)}).`;
}
/** Offers 01 and 02, then 03, as the poster words them. */
export const OFFER_RULES: readonly string[] = [
  'Buy 1 Large pizza → any burger or any side FREE (not the Nashville Burger), or any Medium pizza FREE',
  'Buy 1 Medium pizza → any side FREE (not Loaded Fries)',
];

export type OfferSection = 'pizza' | 'signature' | 'burger' | 'side' | 'deal' | 'other';

/** Which kind of menu section a card sits in, by the section's name (the till's own category names). */
export function offerSectionOf(sectionName: string): OfferSection {
  if (/\bdeals?\b/i.test(sectionName)) return 'deal';
  if (/signature/i.test(sectionName)) return 'signature';
  if (/burger/i.test(sectionName)) return 'burger';
  if (/side|fries/i.test(sectionName)) return 'side';
  if (/pizza|regular/i.test(sectionName)) return 'pizza';
  return 'other';
}

export interface CardOffer {
  /** The gold strip: a title ("BUY 1 GET 1 FREE · 1–7 PM", "FREE · 1–7 PM") and what it means for this card; null = none. */
  bogo: { title: string; detail: string } | null;
  /**
   * The % off ("10% off with pick-up") and each size's price before and after it (the card shows the old one struck
   * out); prices null when two different percents are on offer (no single price to show). null = no % off.
   */
  discount: { label: string; prices: OfferPrice[] | null } | null;
}

/** One size's price before and after the % off, paisa ("" size = an item sold in one size). */
export interface OfferPrice {
  size: string;
  wasCents: number;
  nowCents: number;
}

export interface OfferPercents {
  /** The % off an online pick-up (0 = none, or pick-up is off). */
  pickupPct: number;
  /** The % off a delivery's food (0 = none: today, until the owner ticks "Also on delivery orders"). */
  deliveryPct: number;
  /** Online pick-up is on offer right now. */
  canPickup: boolean;
}

/** The % line for a card whose items take a discount: its words, and the one percent its prices are worked at (null = ambiguous). */
function discountWords(p: OfferPercents): { label: string; pct: number | null } | null {
  const pick = p.canPickup ? p.pickupPct : 0;
  const deliver = p.deliveryPct;
  if (pick > 0 && deliver > 0) {
    return pick === deliver
      ? { label: `${pick}% off online orders`, pct: pick }
      : { label: `${pick}% off pick-up · ${deliver}% off delivery`, pct: null };
  }
  if (pick > 0) return { label: `${pick}% off with pick-up`, pct: pick };
  if (deliver > 0) return { label: `${deliver}% off delivery`, pct: deliver };
  return null;
}

/** Each size's price before and after `pct` (the till's own rounding: lib/pricing percentDiscountCents). */
function pricesAt(card: Pick<MenuCard, 'name' | 'variants'>, pct: number): OfferPrice[] {
  return card.variants.map((v) => ({
    size: cardSizeLabel(card, v.size),
    wasCents: v.item.basePriceCents,
    nowCents: v.item.basePriceCents - percentDiscountCents(v.item.basePriceCents, pct),
  }));
}

const hasSize = (card: Pick<MenuCard, 'variants'>, size: RegExp) => card.variants.some((v) => size.test(v.size ?? ''));

function bogoFor(
  section: OfferSection,
  card: Pick<MenuCard, 'name' | 'variants'>,
  dealsOnMenu: boolean,
  rules: Buy1Get1Rules,
): CardOffer['bogo'] {
  // Switched off by the owner: no strip anywhere.
  if (!rules.on) return null;
  const window = offerWindow(rules);
  // With the deals on the menu the free item comes in one ("…in a Buy 1 Get 1 deal"); before that, the poster's words.
  const inDeal = (words: string) => (dealsOnMenu ? `${words} in a Buy 1 Get 1 deal` : words);
  switch (section) {
    case 'pizza': {
      const medium = hasSize(card, /medium/i);
      const large = hasSize(card, /large/i);
      const title = `BUY 1 GET 1 FREE · ${window}`;
      if (dealsOnMenu) {
        if (large && medium) return { title, detail: 'In a Buy 1 Get 1 deal: Large + free burger, side or Medium · Medium + free side' };
        if (large) return { title, detail: 'In a Buy 1 Get 1 deal: + a free burger, side or Medium pizza' };
        if (medium) return { title, detail: 'In a Buy 1 Get 1 deal: + a free side' };
        return null;
      }
      if (large && medium) return { title, detail: 'Large: any burger, side or Medium FREE · Medium: any side FREE' };
      if (large) return { title, detail: 'Any burger, side or Medium pizza FREE' };
      if (medium) return { title, detail: 'Any side FREE' };
      return null;
    }
    case 'burger':
      return /nashville/i.test(card.name) ? null : { title: `FREE · ${window}`, detail: inDeal('With any Large pizza') };
    case 'side':
      return {
        title: `FREE · ${window}`,
        detail: inDeal(/loaded/i.test(card.name) ? 'With any Large pizza' : 'With any Large or Medium pizza'),
      };
    default:
      return null;
  }
}

/**
 * What a card shows. `section` is the name of the menu section the card sits in. A value deal (or any card whose
 * every item the till marked "no discount") takes no % off, so it shows none and no strip: its own "Save Rs …"
 * badge is its offer.
 */
export function cardOffer(
  sectionName: string,
  card: MenuCard,
  percents: OfferPercents,
  opts: {
    /** The menu has Buy 1 Get 1 deals (their own section): the strips say the free item comes in one. */
    dealsOnMenu?: boolean;
    /** The owner's Buy 1 Get 1 rules (SiteFacts.buy1Get1): off = no strip; the hours in the strip. Default: the poster's. */
    buy1Get1?: Buy1Get1Rules;
  } = {},
): CardOffer {
  const section = offerSectionOf(sectionName);
  if (section === 'deal') return { bogo: null, discount: null };
  const taking = card.variants.length > 0 && card.variants.some((v) => v.item.noDiscount !== true);
  const words = taking ? discountWords(percents) : null;
  return {
    bogo: bogoFor(section, card, opts.dealsOnMenu === true, opts.buy1Get1 ?? DEFAULT_BUY_1_GET_1_RULES),
    discount: words ? { label: words.label, prices: words.pct === null ? null : pricesAt(card, words.pct) } : null,
  };
}

/** The regular pizzas' Medium and Large prices (the cheapest of each across the section), for the banner's rules. */
export function regularPizzaPrices(sections: ReadonlyArray<Pick<MenuSectionView, 'name' | 'cards'>>): {
  mediumCents: number | null;
  largeCents: number | null;
} {
  let mediumCents: number | null = null;
  let largeCents: number | null = null;
  for (const s of sections) {
    if (offerSectionOf(s.name) !== 'pizza') continue;
    for (const c of s.cards) {
      for (const v of c.variants) {
        const price = v.item.basePriceCents;
        if (/medium/i.test(v.size ?? '') && (mediumCents === null || price < mediumCents)) mediumCents = price;
        if (/large/i.test(v.size ?? '') && (largeCents === null || price < largeCents)) largeCents = price;
      }
    }
  }
  return { mediumCents, largeCents };
}
