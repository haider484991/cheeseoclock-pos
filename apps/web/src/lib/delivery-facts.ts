import {
  DELIVERY_ZONES,
  FEE_SUMMARY,
  announcementInForce,
  canonicalPayments,
  cashOnly,
  closesAfterMidnight,
  daysWords,
  deliveryZoneFeeItemIds,
  everyDay,
  findZone,
  hoursLine,
  hoursRange,
  nameInProse,
  opensBy,
  paymentsWords,
  timeWords,
  type PublishedPickup,
  type PublishedSettings,
  type PublishedZone,
} from '@cheeseoclock/shared-types';
import { formatCents } from './format';
import { isPriceKey, priceWords, type PriceKey, type PriceMenu } from './menu-prices';
import { DEFAULT_SHOP_FACTS, nameIsDefault, whatsappNumbersText, type ShopFacts } from './shop-facts';
import { DEFAULT_TAX_BPS, taxPercentWords } from './tax-words';

/**
 * Where the shop delivers and what it costs, as the website says it: the
 * owner's settings block from the till (Settings → Delivery areas & fees,
 * stored with the menu — shared-types web-bridge.ts, THE SETTINGS BLOCK)
 * merged over today's compiled list. With no block the facts ARE the
 * compiled list (DEFAULT_FACTS) and every page reads exactly as before.
 *
 * Pure, and safe in the browser: the ordering page gets its areas from the
 * server as props. The database read is lib/site-facts.ts.
 *
 * Page copy never types a fee: it writes a token that is filled from the
 * facts (fillFees), and a sentence that is only true while fees keep a
 * certain shape carries that claim (Copy / FeeClaim) and steps aside when
 * the owner's fees break it. site-copy.test.ts fails on any fee typed by hand.
 */

/** One delivery area as the website uses it (the block's shape). */
export type FactZone = PublishedZone;

export interface SiteFacts {
  /** 'settings' = the owner's block from the till; 'default' = the compiled list (no block stored, or the database unreadable). */
  source: 'settings' | 'default';
  /** Every area, switched-off ones too, in display order. */
  zones: readonly FactZone[];
  /** The owner's pick-up offer; null = no block, so the till's heartbeat decides (as before). */
  pickup: PublishedPickup | null;
  /**
   * The owner's announcement while it is on (Settings → Online orders on the
   * till, v0.7.30: shared-types announcementInForce), else null — no block,
   * a block without one (a v0.7.29 till) or switched off: every page as
   * before. Shown as page text only (the home page's hero and marquee, the
   * /menu header), never in a title, meta tag or JSON-LD.
   */
  announcement: string | null;
  /**
   * The smallest website DELIVERY order's food, paisa (v0.7.30); 0 = no
   * minimum (no block, or a block without it): as before. A pick-up is never
   * refused; the order route checks it, the checkout says how much to add.
   */
  minDeliveryOrderCents: number;
  // Never the block's stamps or device id: the /menu page hands these facts to the browser.
  // Never the closed notice either: it has a last day, so it is worked out per request on the
  // server from the block (shared-types closedNoticeInForce: the order route, the /menu page) — an
  // hourly page must not show it after that day.
}

/** The compiled list as facts: every area on, no fee item named (found by name and price, as before). */
export const DEFAULT_ZONE_FACTS: readonly FactZone[] = Object.freeze(
  DELIVERY_ZONES.map(
    (z, sort): FactZone => ({
      id: z.id,
      name: z.name,
      shortName: z.shortName,
      group: z.group,
      feeCents: z.feeCents,
      feeItemId: null,
      active: true,
      sort,
      aliases: [...z.aliases],
    }),
  ),
);

export const DEFAULT_FACTS: SiteFacts = Object.freeze({
  source: 'default',
  zones: DEFAULT_ZONE_FACTS,
  pickup: null,
  announcement: null,
  minDeliveryOrderCents: 0,
});

/**
 * What page copy is written from: the delivery facts above, and (sweep B2 +
 * B4) the shop's details and the menu's tax rate. Either one absent = today's
 * (DEFAULT_SHOP_FACTS; DEFAULT_TAX_BPS), so every call that passes plain
 * SiteFacts (DEFAULT_FACTS, factsFromBlock) reads exactly as before. The
 * /menu page hands the browser SiteFacts only — the shop's details go as
 * their own prop (lib/shop-facts.ts), never the block's stamps.
 */
export type CopyFacts = SiteFacts & {
  /** The shop's details (lib/site-facts getShopFacts); absent = today's. */
  shop?: ShopFacts;
  /**
   * The food's one tax rate in basis points (lib/tax-words taxBpsOf); null =
   * more than one rate (no number is named); absent = the menu is unknown
   * (DEFAULT_TAX_BPS, today's 15%).
   */
  taxBps?: number | null;
  /**
   * The published menu the price tokens read (sweep B2: {price:deals} …,
   * lib/menu-prices); absent or null = the menu is unknown (no database,
   * nothing published): no price prints — the copy's `otherwise` does.
   * Server only: never handed to the browser.
   */
  menu?: PriceMenu | null;
};

/** The shop's details these facts carry (today's when none). */
export function shopOf(facts: CopyFacts): ShopFacts {
  return facts.shop ?? DEFAULT_SHOP_FACTS;
}

/** The tax rate these facts name: a rate above 0, else null (no number). */
export function taxBpsIn(facts: CopyFacts): number | null {
  const bps = facts.taxBps === undefined ? DEFAULT_TAX_BPS : facts.taxBps;
  return bps !== null && bps > 0 ? bps : null;
}

/**
 * Tax is added to the bill: the food's one rate is above 0, or it has more
 * than one rate, or the menu is unknown (today's 15%). False only when every
 * food item is at 0% — then no sentence may say tax is added.
 */
export function taxAdded(facts: CopyFacts): boolean {
  return facts.taxBps !== 0;
}

/**
 * The facts for a stored block (null → DEFAULT_FACTS). The block's areas in
 * their display order; a compiled area the block lacks keeps its compiled
 * facts (the website refuses such a block, so this is belt and braces: every
 * area page must always find its areas).
 */
export function factsFromBlock(block: PublishedSettings | null | undefined): SiteFacts {
  if (!block) return DEFAULT_FACTS;
  const zones = block.zones
    .map((z, i) => ({ z, i }))
    .sort((a, b) => a.z.sort - b.z.sort || a.i - b.i)
    .map(({ z }): FactZone => ({ ...z, aliases: [...z.aliases] }));
  const have = new Set(zones.map((z) => z.id));
  for (const d of DEFAULT_ZONE_FACTS) if (!have.has(d.id)) zones.push({ ...d, sort: zones.length });
  return {
    source: 'settings',
    zones,
    pickup: { offered: block.pickup.offered, percent: block.pickup.percent },
    // A block without them (a v0.7.29 till's, and nothing kept from an earlier one): today's site.
    announcement: announcementInForce(block.announcement),
    minDeliveryOrderCents: block.minDeliveryOrderCents ?? 0,
  };
}

export function findFactZone(facts: SiteFacts, id: string | null | undefined): FactZone | undefined {
  if (!id) return undefined;
  return facts.zones.find((z) => z.id === id);
}

/** The areas a customer can order to right now, in display order. */
export function activeZones(facts: SiteFacts): FactZone[] {
  return facts.zones.filter((z) => z.active);
}

// ---------------------------------------------------------------------------
// Fees in words
// ---------------------------------------------------------------------------

/** "Rs N", or "Rs N–M" when the fees differ; '' for none. */
export function feeRangeOfFees(fees: readonly number[]): string {
  if (fees.length === 0) return '';
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  return min === max ? formatCents(min) : `${formatCents(min)}–${formatCents(max).replace(/^Rs\s*/, '')}`;
}

/** The fee range the site advertises: the areas on now; '' while every one is paused (no fee is named for an area switched off). */
export function deliveryFeeRange(facts: SiteFacts): string {
  return feeRangeOfFees(activeZones(facts).map((z) => z.feeCents));
}

/** The groups delivered to now, in display order: ["DHA", "Clifton"]. */
export function deliveryGroups(facts: SiteFacts): string[] {
  const seen: string[] = [];
  for (const z of activeZones(facts)) if (!seen.includes(z.group)) seen.push(z.group);
  return seen;
}

/** "DHA and Clifton" / "DHA & Clifton" / "DHA, Clifton and PECHS". */
export function listWords(words: readonly string[], and: 'and' | '&' = 'and'): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} ${and} ${words[words.length - 1]}`;
}

/** Where the shop delivers, in a sentence's words ("DHA and Clifton"); '' while every area is paused. */
export function deliveryAreasText(facts: SiteFacts, and: 'and' | '&' = 'and'): string {
  return listWords(deliveryGroups(facts), and);
}

/** The menu page's chip: "Delivery Rs N–M · DHA & Clifton", or "Delivery paused" while every area is off. */
export function deliveryChip(facts: SiteFacts): string {
  const where = deliveryAreasText(facts, '&');
  if (!where) return 'Delivery paused';
  return allFree(facts) ? `Free delivery · ${where}` : `Delivery ${deliveryFeeRange(facts)} · ${where}`;
}

/** Every area delivered to now is free (a fee of zero): the chips say "free", never a zero amount. */
function allFree(facts: SiteFacts): boolean {
  const on = activeZones(facts);
  return on.length > 0 && on.every((z) => z.feeCents === 0);
}

/** The delivery half of the delivery / pick-up toggle: "Rs N–M · DHA & Clifton", or "Paused right now". */
export function deliveryOptionNote(facts: SiteFacts): string {
  const where = deliveryAreasText(facts, '&');
  if (!where) return 'Paused right now';
  return `${allFree(facts) ? 'Free' : deliveryFeeRange(facts)} · ${where}`;
}

export interface ZoneOption {
  id: string;
  /** "DHA Phase 6 — Rs N", or "… — delivery paused" for an area switched off. */
  label: string;
  /** Switched off: listed, so the customer sees why, but not choosable. */
  disabled: boolean;
}

/** The checkout's area list: the owner's groups ("DHA", "Clifton", …) in display order. */
export function zoneOptionGroups(zones: readonly FactZone[]): Array<{ group: string; options: ZoneOption[] }> {
  const groups: Array<{ group: string; options: ZoneOption[] }> = [];
  for (const z of zones) {
    const option: ZoneOption = {
      id: z.id,
      label: !z.active
        ? `${z.name} — delivery paused`
        : z.feeCents === 0
          ? `${z.name} — free delivery`
          : `${z.name} — ${formatCents(z.feeCents)}`,
      disabled: !z.active,
    };
    const g = groups.find((x) => x.group === z.group);
    if (g) g.options.push(option);
    else groups.push({ group: z.group, options: [option] });
  }
  return groups;
}

/** The hint under the area list before one is chosen. */
export function checkoutAreaHint(facts: SiteFacts, pickup: { canPickup: boolean; pickupPct: number }): string {
  const where = deliveryAreasText(facts);
  const first = where ? `We deliver in ${where} only.` : 'Delivery is paused right now.';
  return `${first}${pickup.canPickup ? ` Elsewhere? Choose pick-up — ${pickup.pickupPct}% off.` : ''}`;
}

/**
 * The checkout's words when an order names an area the shop does not
 * deliver to (api/orders 'outside_zone'), built from the groups on now.
 */
export function outsideZoneMessage(facts: SiteFacts): string {
  const where = deliveryAreasText(facts);
  if (!where) return 'We are not delivering anywhere right now. Please order on WhatsApp or give us a call.';
  return `We deliver in ${where} only. Choose your area from the list — if it is not there, we cannot deliver to it.`;
}

/**
 * A website delivery whose food is under the owner's smallest delivery order
 * (api/orders 'below_minimum', and the checkout before it sends): how much
 * the smallest order is and how much more to add. `canPickup`: pick-up is on
 * offer now (it has no minimum). Never said for a pick-up.
 */
export function deliveryMinimumMessage(minimumCents: number, shortfallCents: number, canPickup: boolean): string {
  return `Website delivery orders start at ${formatCents(minimumCents)} of food, before tax and the delivery charge. Add ${formatCents(
    shortfallCents,
  )} more${canPickup ? ', or choose pick-up (no minimum)' : ' to order delivery'}.`;
}

/** The cart's note while a delivery is under the smallest order (it does not block until the order is placed). */
export function deliveryMinimumNote(minimumCents: number, shortfallCents: number): string {
  return `Add ${formatCents(shortfallCents)} more for delivery — the smallest delivery order is ${formatCents(minimumCents)} of food.`;
}

/** A switched-off area (api/orders 'zone_paused'). */
export function zonePausedMessage(zone: Pick<FactZone, 'name'>): string {
  return `Delivery to ${zone.name} is paused right now. Choose another area, or order on WhatsApp and we will tell you when it is back.`;
}

/**
 * An area page's fee chip: "Rs N delivery", "Rs N–M delivery" across
 * its areas that are on, "Delivery paused" when none is. Throws on an area id
 * the facts don't know, so a typo fails the build instead of shipping a
 * wrong fee.
 */
export function zonesFeeChip(pageSlug: string, zoneIds: readonly string[], facts: SiteFacts): string {
  const zones = zonesOf(pageSlug, zoneIds, facts);
  const on = zones.filter((z) => z.active);
  if (on.length === 0) return 'Delivery paused';
  if (on.every((z) => z.feeCents === 0)) return 'Free delivery';
  return `${feeRangeOfFees(on.map((z) => z.feeCents))} delivery`;
}

/** The page's areas that are switched off (for its "delivery is paused" note). */
export function pausedZones(zoneIds: readonly string[], facts: SiteFacts): FactZone[] {
  return zoneIds.map((id) => findFactZone(facts, id)).filter((z): z is FactZone => !!z && !z.active);
}

function zonesOf(where: string, zoneIds: readonly string[], facts: SiteFacts): FactZone[] {
  if (zoneIds.length === 0) throw new Error(`${where}: lists no delivery zones`);
  return zoneIds.map((id) => {
    const zone = findFactZone(facts, id);
    if (!zone) throw new Error(`${where}: unknown delivery zone "${id}"`);
    return zone;
  });
}

// ---------------------------------------------------------------------------
// The fee summary (the two tiers today) — generated once a block is stored
// ---------------------------------------------------------------------------

export interface FeeTier {
  feeCents: number;
  /** "DHA Phases 1–7 · Clifton Blocks 3–9". */
  places: string;
}

/**
 * The fee tiers in customer words, cheapest first, over the areas on now —
 * none while every area is paused (an area switched off never has its fee
 * printed). With no block it is exactly the compiled FEE_SUMMARY; with one
 * it is written from the areas (placesWords), which gives the same two
 * lines for today's areas and fees (site-copy.test.ts pins it).
 */
export function feeSummary(facts: SiteFacts): FeeTier[] {
  if (facts.source === 'default') return FEE_SUMMARY.map((f) => ({ feeCents: f.feeCents, places: f.places }));
  return generatedFeeSummary(activeZones(facts));
}

export function generatedFeeSummary(zones: readonly FactZone[]): FeeTier[] {
  const byFee = new Map<number, FactZone[]>();
  for (const z of zones) {
    const list = byFee.get(z.feeCents) ?? [];
    list.push(z);
    byFee.set(z.feeCents, list);
  }
  return [...byFee.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([feeCents, list]) => ({ feeCents, places: placesWords(list) }));
}

/** The pages' sentence over the tiers: "Rs N for DHA Phases 1–7, Clifton Blocks 3–9; Rs M for …". */
export function feeSummarySentence(facts: SiteFacts): string {
  return feeSummary(facts)
    .map((f) => `${formatCents(f.feeCents)} for ${f.places.replace(' · ', ', ')}`)
    .join('; ');
}

const NUMBERED = /^(\S+) (\d+)$/;
const NUMBERED_EXT = /^(\S+) (\d+) Ext(?:ension)?$/i;

/**
 * Areas in customer words, per group in display order: numbered areas as a
 * range ("DHA Phases 1–7", "Clifton Blocks 1 & 2", "DHA Phase 8"), an
 * extension folded into its phase when that phase is listed, anything else
 * by its short name ("Emaar & Creek Vista"). Parts joined with " · ".
 */
export function placesWords(zones: readonly FactZone[]): string {
  const groups: string[] = [];
  const byGroup = new Map<string, FactZone[]>();
  for (const z of zones) {
    if (!byGroup.has(z.group)) {
      byGroup.set(z.group, []);
      groups.push(z.group);
    }
    byGroup.get(z.group)!.push(z);
  }
  const parts: string[] = [];
  for (const g of groups) {
    const list = byGroup.get(g)!;
    const words: string[] = [];
    const numbers = new Map<string, number[]>();
    for (const z of list) {
      const m = NUMBERED.exec(z.shortName.trim());
      if (!m) continue;
      const word = m[1]!;
      if (!numbers.has(word)) {
        numbers.set(word, []);
        words.push(word);
      }
      numbers.get(word)!.push(Number(m[2]));
    }
    const others: string[] = [];
    for (const z of list) {
      const s = z.shortName.trim();
      if (NUMBERED.test(s)) continue;
      const ext = NUMBERED_EXT.exec(s);
      if (ext && numbers.get(ext[1]!)?.includes(Number(ext[2]))) continue;
      others.push(s);
    }
    for (const w of words) {
      const ns = [...new Set(numbers.get(w)!)].sort((a, b) => a - b);
      parts.push(`${g} ${ns.length === 1 ? w : `${w}s`} ${numberList(ns)}`);
    }
    if (others.length > 0) {
      const named = words.length > 0 ? others : others.map((o) => (o.toLowerCase().startsWith(g.toLowerCase()) ? o : `${g} ${o}`));
      parts.push(listWords(named, '&'));
    }
  }
  return parts.join(' · ');
}

/** 1,2,3,4 → "1–4"; 1,2 → "1 & 2"; 1,2,5,6,7 → "1, 2 & 5–7". */
function numberList(ns: readonly number[]): string {
  const runs: number[][] = [];
  for (const n of ns) {
    const last = runs[runs.length - 1];
    if (last && n === last[last.length - 1]! + 1) last.push(n);
    else runs.push([n]);
  }
  if (runs.length === 1) {
    const r = runs[0]!;
    if (r.length === 1) return String(r[0]);
    if (r.length === 2) return `${r[0]} & ${r[1]}`;
    return `${r[0]}–${r[r.length - 1]}`;
  }
  const pieces = runs.flatMap((r) => (r.length >= 3 ? [`${r[0]}–${r[r.length - 1]}`] : r.map(String)));
  return listWords(pieces, '&');
}

// ---------------------------------------------------------------------------
// Fee tokens and claims in page copy
// ---------------------------------------------------------------------------

/**
 * A fact a sentence relies on. `sameFee`: these areas all charge one fee.
 * `rateCard`: these areas charge exactly the compiled rate card's fee (the
 * wording explains a fee by that card). Paused areas count with their fee.
 * `on`: every one of these areas is delivered to now — a sentence that
 * names them beside a fee ("the same for Emaar Crescent Bay") must not
 * speak for one switched off. `delivering`: some area is on.
 * `areasAsBuilt`: the areas delivered to now are exactly today's 21 — none
 * switched off, none added — so a sentence may name them by hand ("DHA
 * Phases 1–8 and Clifton", "We don't deliver outside DHA and Clifton").
 * `noMinimum`: the owner has set no smallest website delivery order (0, as
 * before v0.7.30) — "No minimum on the website" is true.
 *
 * The shop's details (sweep B2 + B4, lib/shop-facts.ts; today's with none
 * stored — every claim below holds for them):
 * `everyDay`: open all seven days ("daily", "every day", "every night").
 * `closesAfterMidnight`: closes after midnight, before 5 am (the late-night
 * page's premise: "past midnight", "a midnight craving").
 * `opensBy`: opens at or before this "HH:MM" ("lunch and dinner, from 12
 * noon" needs it open by 13:00).
 * `cashOnly` / `pickupCashOnly`: the rider / the counter takes cash only
 * (website words — "no cards or wallets needed", "you pay in cash").
 * `nameIsDefault`: the shop's name is today's — the lines built on its pun
 * ("It’s always Cheese O’Clock") may print.
 * `oneTaxRate`: the food has one tax rate above 0 (the menu unknown: today's).
 * `taxAdded`: tax is added on the bill — false only when every food item is
 * at 0% (a sentence that names tax then takes its `otherwise`).
 * `samePayments`: the counter takes exactly what the rider takes ("pay …
 * on delivery or at the counter" names one list for both).
 *
 * The published menu (sweep B2, lib/menu-prices.ts):
 * `priced`: this price line has words on the menu — its {price:<key>} token
 * prints (the menu known, its items on it, one price for an "each").
 */
export type CopyClaim =
  | { sameFee: readonly string[] }
  | { rateCard: readonly string[] }
  | { on: readonly string[] }
  | { delivering: true }
  | { areasAsBuilt: true }
  | { noMinimum: true }
  | { everyDay: true }
  | { closesAfterMidnight: true }
  | { opensBy: string }
  | { cashOnly: true }
  | { pickupCashOnly: true }
  | { nameIsDefault: true }
  | { oneTaxRate: true }
  | { taxAdded: true }
  | { samePayments: true }
  | { priced: PriceKey };

/** A claim page copy relies on (the name from step 3, when every claim was about fees). */
export type FeeClaim = CopyClaim;

/**
 * Page copy: plain text with tokens, or text that holds only under a claim —
 * every one of them when `when` is a list — with `otherwise` (plain, or
 * claimed again) replacing it when the claim breaks; no `otherwise` = leave
 * it out.
 */
export type Copy =
  | string
  | { text: string; when: CopyClaim | readonly CopyClaim[]; otherwise?: Copy };

/** Every compiled area id: `{ rateCard: ALL_COMPILED_ZONE_IDS }` = "the fees are still the rate card's". */
export const ALL_COMPILED_ZONE_IDS: readonly string[] = Object.freeze(DELIVERY_ZONES.map((z) => z.id));

export function claimHolds(claim: CopyClaim | readonly CopyClaim[], facts: CopyFacts): boolean {
  if (isClaimList(claim)) return claim.every((c) => claimHolds(c, facts));
  if ('areasAsBuilt' in claim) {
    const on = activeZones(facts).map((z) => z.id);
    return on.length === ALL_COMPILED_ZONE_IDS.length && ALL_COMPILED_ZONE_IDS.every((id) => on.includes(id));
  }
  if ('delivering' in claim) return activeZones(facts).length > 0;
  if ('noMinimum' in claim) return !(facts.minDeliveryOrderCents > 0);
  if ('on' in claim) return zonesOf('on', expandZoneIds(claim.on), facts).every((z) => z.active);
  const shop = shopOf(facts);
  if ('everyDay' in claim) return everyDay(shop.hours);
  if ('closesAfterMidnight' in claim) return closesAfterMidnight(shop.hours);
  if ('opensBy' in claim) return opensBy(shop.hours, claim.opensBy);
  if ('cashOnly' in claim) return cashOnly(shop.website.doorPayments);
  if ('pickupCashOnly' in claim) return cashOnly(shop.website.pickupPayments);
  if ('nameIsDefault' in claim) return nameIsDefault(shop);
  if ('oneTaxRate' in claim) return taxBpsIn(facts) !== null;
  if ('taxAdded' in claim) return taxAdded(facts);
  if ('samePayments' in claim) {
    const door = canonicalPayments(shop.website.doorPayments);
    const pickup = canonicalPayments(shop.website.pickupPayments);
    return door.length === pickup.length && door.every((p, i) => p === pickup[i]);
  }
  if ('priced' in claim) return menuPriceWords(claim.priced, facts) !== null;
  return feeClaimHolds(claim, facts);
}

/** A price line's words from the facts' menu (lib/menu-prices priceWords), or null; an unknown key throws. */
function menuPriceWords(key: string, facts: CopyFacts): string | null {
  return priceWords(key, facts.menu, deliveryZoneFeeItemIds(facts.zones));
}

function isClaimList(claim: CopyClaim | readonly CopyClaim[]): claim is readonly CopyClaim[] {
  return Array.isArray(claim);
}

function feeClaimHolds(claim: { sameFee: readonly string[] } | { rateCard: readonly string[] }, facts: SiteFacts): boolean {
  if ('sameFee' in claim) {
    const fees = new Set(zonesOf('sameFee', expandZoneIds(claim.sameFee), facts).map((z) => z.feeCents));
    return fees.size === 1;
  }
  return zonesOf('rateCard', expandZoneIds(claim.rateCard), facts).every((z) => findZone(z.id)?.feeCents === z.feeCents);
}

/**
 * The copy as the page prints it, or null when it is left out. Text whose
 * fee token names only areas switched off (PausedFeeToken) can't print, as
 * if its claim broke: its `otherwise`, else nothing — a switched-off area's
 * fee never reaches the page (the page's paused note says why).
 */
export function renderCopy(copy: Copy, facts: CopyFacts): string | null {
  if (typeof copy === 'string') return fillOrNull(copy, facts);
  if (claimHolds(copy.when, facts)) {
    const text = fillOrNull(copy.text, facts);
    if (text !== null) return text;
  }
  return copy.otherwise === undefined ? null : renderCopy(copy.otherwise, facts);
}

/**
 * A token with nothing true to print: the text that holds it can't print
 * (renderCopy moves on to its `otherwise`, else leaves it out) — never a
 * wrong or empty value. Every such token throws a subclass.
 */
export class CantPrint extends Error {}

/** A fee token with no area on to name a fee for: the text that holds it can't print (renderCopy moves on). */
export class PausedFeeToken extends CantPrint {
  constructor(token: string) {
    super(`${token}: every area it names is switched off`);
    this.name = 'PausedFeeToken';
  }
}

/** {minOrder} with no smallest delivery order set: the text that holds it can't print (renderCopy moves on) — never a zero amount. */
export class NoMinimumToken extends CantPrint {
  constructor(token: string) {
    super(`${token}: the owner has set no smallest delivery order`);
    this.name = 'NoMinimumToken';
  }
}

/**
 * {tax} / {Tax} while every food item is at 0%: no tax is added, so the text
 * that says it is can't print (renderCopy moves on to its `otherwise`).
 */
export class NoTaxToken extends CantPrint {
  constructor(token: string) {
    super(`${token}: the food is taxed at 0%`);
    this.name = 'NoTaxToken';
  }
}

/**
 * {price:<key>} with nothing true to print — the menu unknown, the line's
 * items not on it, its choices at more than one price: the text that holds
 * it can't print (renderCopy moves on) — never a zero price, never a stale one.
 */
export class NoPriceToken extends CantPrint {
  constructor(token: string) {
    super(`${token}: the published menu does not say`);
    this.name = 'NoPriceToken';
  }
}

function fillOrNull(text: string, facts: CopyFacts): string | null {
  try {
    return fillFees(text, facts);
  } catch (e) {
    if (e instanceof CantPrint) return null;
    throw e;
  }
}

/** Copy that always prints (a string, or a claim with an `otherwise`). */
export function copyText(copy: Copy, facts: CopyFacts): string {
  const out = renderCopy(copy, facts);
  if (out === null) throw new Error(`Copy with no words for these fees: ${typeof copy === 'string' ? copy : copy.text}`);
  return out;
}

/** "dha-1..7,dha-2-ext" → dha-1 … dha-7, dha-2-ext. */
export function expandZoneIds(list: readonly string[] | string): string[] {
  const parts = typeof list === 'string' ? list.split(',') : list;
  const out: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    const range = /^(.*-)(\d+)\.\.(\d+)$/.exec(p);
    if (range) {
      const [, prefix, a, b] = range;
      for (let n = Number(a); n <= Number(b); n++) out.push(`${prefix}${n}`);
    } else if (p) out.push(p);
  }
  return out;
}

const TOKEN = /\{([a-zA-Z]+)(?::([^{}]*))?\}/g;

/**
 * Fill a sentence's fee tokens from the facts:
 *  - {fee:dha-6} / {fee:dha-8,emaar,creek-vista} / {fee:clifton-3..9}: the
 *    fee ("Rs N") or range ("Rs N–M") of those areas that are on — a fee of
 *    an area switched off is never named: with none of them on, the token
 *    throws PausedFeeToken (renderCopy then takes the copy's `otherwise`);
 *  - {fees}: the range across every area on;
 *  - {minFee}: the lowest fee of an area on;
 *  - {summary}: the fee tiers in a sentence (feeSummarySentence);
 *    these three throw PausedFeeToken while every area is paused;
 *  - {where}: the groups delivered to now ("DHA, Clifton and PECHS"; every
 *    group while all are paused);
 *  - {places}: the areas delivered to now in customer words ("DHA Phases
 *    1–8, Emaar & Creek Vista, Clifton Blocks 1–9"; every area while all
 *    are paused);
 *  - {minOrder}: the owner's smallest website delivery order, in rupees;
 *    throws NoMinimumToken while there is none (claim it: { noMinimum }).
 * The shop's details (sweep B2 + B4; today's with none stored):
 *  - {hours} "12 noon – 1 am"; {opens} "12 noon"; {closes} "1 am";
 *    {days} "daily" (every day) or "Mon–Sat"; {hoursLine} "Open daily ·
 *    12 noon – 1 am" — the owner's opening hours (display only);
 *  - {name} "Cheese O'Clock"; {nameProse} "Cheese O’Clock" (the curly
 *    apostrophe of running text); {phone} the call line as printed;
 *    {waNumbers} the WhatsApp numbers ("… or …"); {street} the street
 *    address; {areaLine} its short "area, city" line;
 *  - {doorPayments} / {DoorPayments} what the rider takes ("cash", "cash or
 *    card"; capitalised at a sentence's start), {pickupPayments} /
 *    {PickupPayments} what the counter takes;
 *  - {tax} / {Tax}: "15% tax" — the food's one rate (the menu unknown:
 *    today's); "tax" / "Tax" when the food has more than one (never a
 *    wrong number); every food item at 0% throws NoTaxToken — claim it:
 *    { taxAdded: true }.
 * The published menu (sweep B2):
 *  - {price:deals} / {price:burgers} / {price:sides} / {price:masalaFries} /
 *    {price:burgerCheese} / {price:dip}: the till's prices for the items a
 *    page names (lib/menu-prices PRICE_LINES: a price, or a spaced "low –
 *    high" range); throws NoPriceToken while the menu can't say (unknown, the
 *    items missing, mixed prices) — claim it: { priced: 'deals' }.
 * An unknown token or area id throws: a typo must fail the tests and the
 * build, never print "{fee:dha-66}" or a wrong fee.
 */
export function fillFees(text: string, facts: CopyFacts): string {
  return text.replace(TOKEN, (whole, name: string, arg: string | undefined) => {
    switch (name) {
      case 'fee': {
        const zones = zonesOf(`token ${whole}`, expandZoneIds(arg ?? ''), facts);
        const on = zones.filter((z) => z.active);
        if (on.length === 0) throw new PausedFeeToken(whole);
        return feeRangeOfFees(on.map((z) => z.feeCents));
      }
      case 'fees':
      case 'minFee':
      case 'summary': {
        const on = activeZones(facts);
        if (on.length === 0) throw new PausedFeeToken(whole);
        if (name === 'fees') return deliveryFeeRange(facts);
        if (name === 'minFee') return formatCents(Math.min(...on.map((z) => z.feeCents)));
        return feeSummarySentence(facts);
      }
      case 'where': {
        const where = deliveryAreasText(facts);
        return where || listWords([...new Set(facts.zones.map((z) => z.group))]);
      }
      case 'places': {
        const on = activeZones(facts);
        return placesWords(on.length > 0 ? on : facts.zones).split(' · ').join(', ');
      }
      case 'minOrder': {
        if (!(facts.minDeliveryOrderCents > 0)) throw new NoMinimumToken(whole);
        return formatCents(facts.minDeliveryOrderCents);
      }
      case 'price': {
        // A key that names no price line is a typo like any unknown token.
        if (!isPriceKey(arg ?? '')) throw new Error(`Unknown fee token ${whole}`);
        const words = menuPriceWords(arg ?? '', facts);
        if (words === null) throw new NoPriceToken(whole);
        return words;
      }
      default: {
        const shopWords = shopToken(name, facts);
        if (shopWords === null) throw new Error(`Unknown fee token ${whole}`);
        return shopWords;
      }
    }
  });
}

const capitalised = (s: string) => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s);

/** A shop token's words (fillFees), or null for a name that is none. */
function shopToken(name: string, facts: CopyFacts): string | null {
  const shop = shopOf(facts);
  switch (name) {
    case 'hours':
      return hoursRange(shop.hours);
    case 'opens':
      return timeWords(shop.hours.opens);
    case 'closes':
      return timeWords(shop.hours.closes);
    case 'days':
      return daysWords(shop.hours.days);
    case 'hoursLine':
      return hoursLine(shop.hours);
    case 'name':
      return shop.profile.name;
    case 'nameProse':
      return nameInProse(shop.profile.name);
    case 'phone':
      return shop.profile.phone.display;
    case 'waNumbers':
      return whatsappNumbersText(shop);
    case 'street':
      return shop.profile.address.street;
    case 'areaLine':
      return shop.profile.address.areaLine;
    case 'doorPayments':
      return paymentsWords(shop.website.doorPayments);
    case 'DoorPayments':
      return capitalised(paymentsWords(shop.website.doorPayments));
    case 'pickupPayments':
      return paymentsWords(shop.website.pickupPayments);
    case 'PickupPayments':
      return capitalised(paymentsWords(shop.website.pickupPayments));
    case 'tax':
    case 'Tax': {
      if (!taxAdded(facts)) throw new NoTaxToken(`{${name}}`);
      const bps = taxBpsIn(facts);
      if (bps !== null) return `${taxPercentWords(bps)} tax`;
      return name === 'Tax' ? 'Tax' : 'tax';
    }
    default:
      return null;
  }
}
