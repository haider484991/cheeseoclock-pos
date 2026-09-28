import {
  DELIVERY_ZONES,
  FEE_SUMMARY,
  findZone,
  type PublishedPickup,
  type PublishedSettings,
  type PublishedZone,
} from '@cheeseoclock/shared-types';
import { formatCents } from './format';

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
  settingsAt: string | null;
  settingsRev: number | null;
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
  settingsAt: null,
  settingsRev: null,
});

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
    settingsAt: block.settingsAt,
    settingsRev: block.settingsRev,
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

/** The fee range the site advertises: the areas on now (all of them when every one is paused). */
export function deliveryFeeRange(facts: SiteFacts): string {
  const on = activeZones(facts);
  return feeRangeOfFees((on.length > 0 ? on : facts.zones).map((z) => z.feeCents));
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
 * The fee tiers in customer words, cheapest first, over the areas on now
 * (every area while all are paused, so a sentence over it still reads — the
 * fees they will have again). With no block it is exactly the compiled
 * FEE_SUMMARY; with one it is written from the areas (placesWords), which
 * gives the same two lines for today's areas and fees (site-copy.test.ts
 * pins it).
 */
export function feeSummary(facts: SiteFacts): FeeTier[] {
  if (facts.source === 'default') return FEE_SUMMARY.map((f) => ({ feeCents: f.feeCents, places: f.places }));
  const on = activeZones(facts);
  return generatedFeeSummary(on.length > 0 ? on : facts.zones);
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
 * `areasAsBuilt`: the areas delivered to now are exactly today's 21 — none
 * switched off, none added — so a sentence may name them by hand ("DHA
 * Phases 1–8 and Clifton", "We don't deliver outside DHA and Clifton").
 */
export type FeeClaim =
  | { sameFee: readonly string[] }
  | { rateCard: readonly string[] }
  | { areasAsBuilt: true };

/**
 * Page copy: plain text with fee tokens, or text that holds only under a
 * claim — every one of them when `when` is a list — with `otherwise` (plain,
 * or claimed again) replacing it when the claim breaks; no `otherwise` =
 * leave it out.
 */
export type Copy =
  | string
  | { text: string; when: FeeClaim | readonly FeeClaim[]; otherwise?: Copy };

/** Every compiled area id: `{ rateCard: ALL_COMPILED_ZONE_IDS }` = "the fees are still the rate card's". */
export const ALL_COMPILED_ZONE_IDS: readonly string[] = Object.freeze(DELIVERY_ZONES.map((z) => z.id));

export function claimHolds(claim: FeeClaim | readonly FeeClaim[], facts: SiteFacts): boolean {
  if (isClaimList(claim)) return claim.every((c) => claimHolds(c, facts));
  if ('areasAsBuilt' in claim) {
    const on = activeZones(facts).map((z) => z.id);
    return on.length === ALL_COMPILED_ZONE_IDS.length && ALL_COMPILED_ZONE_IDS.every((id) => on.includes(id));
  }
  return feeClaimHolds(claim, facts);
}

function isClaimList(claim: FeeClaim | readonly FeeClaim[]): claim is readonly FeeClaim[] {
  return Array.isArray(claim);
}

function feeClaimHolds(claim: { sameFee: readonly string[] } | { rateCard: readonly string[] }, facts: SiteFacts): boolean {
  if ('sameFee' in claim) {
    const fees = new Set(zonesOf('sameFee', expandZoneIds(claim.sameFee), facts).map((z) => z.feeCents));
    return fees.size === 1;
  }
  return zonesOf('rateCard', expandZoneIds(claim.rateCard), facts).every((z) => findZone(z.id)?.feeCents === z.feeCents);
}

/** The copy as the page prints it, or null when it is left out. */
export function renderCopy(copy: Copy, facts: SiteFacts): string | null {
  if (typeof copy === 'string') return fillFees(copy, facts);
  if (claimHolds(copy.when, facts)) return fillFees(copy.text, facts);
  return copy.otherwise === undefined ? null : renderCopy(copy.otherwise, facts);
}

/** Copy that always prints (a string, or a claim with an `otherwise`). */
export function copyText(copy: Copy, facts: SiteFacts): string {
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
 *    fee ("Rs N") or range ("Rs N–M") of those areas that are on (all
 *    of them when every one is paused, so the sentence still reads);
 *  - {fees}: the range across every area on;
 *  - {minFee}: the lowest fee of an area on;
 *  - {summary}: the fee tiers in a sentence (feeSummarySentence);
 *  - {where}: the groups delivered to now ("DHA, Clifton and PECHS"; every
 *    group while all are paused);
 *  - {places}: the areas delivered to now in customer words ("DHA Phases
 *    1–8, Emaar & Creek Vista, Clifton Blocks 1–9"; every area while all
 *    are paused).
 * An unknown token or area id throws: a typo must fail the tests and the
 * build, never print "{fee:dha-66}" or a wrong fee.
 */
export function fillFees(text: string, facts: SiteFacts): string {
  return text.replace(TOKEN, (whole, name: string, arg: string | undefined) => {
    switch (name) {
      case 'fee': {
        const zones = zonesOf(`token ${whole}`, expandZoneIds(arg ?? ''), facts);
        const on = zones.filter((z) => z.active);
        return feeRangeOfFees((on.length > 0 ? on : zones).map((z) => z.feeCents));
      }
      case 'fees':
        return deliveryFeeRange(facts);
      case 'minFee': {
        const on = activeZones(facts);
        return formatCents(Math.min(...(on.length > 0 ? on : facts.zones).map((z) => z.feeCents)));
      }
      case 'summary':
        return feeSummarySentence(facts);
      case 'where': {
        const where = deliveryAreasText(facts);
        return where || listWords([...new Set(facts.zones.map((z) => z.group))]);
      }
      case 'places': {
        const on = activeZones(facts);
        return placesWords(on.length > 0 ? on : facts.zones).split(' · ').join(', ');
      }
      default:
        throw new Error(`Unknown fee token ${whole}`);
    }
  });
}
