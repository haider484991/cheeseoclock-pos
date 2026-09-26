/**
 * Delivery-area search for the till's address entry.
 *
 * The data — zones, fees and the places people name instead of a phase or
 * block — is the ONE list in @cheeseoclock/shared-types (delivery-areas.ts),
 * which the website checkout uses too. This module is the pure logic on top:
 * typeahead, turning a pick into the text that goes on the ticket, and
 * recognising a saved or typed area again so its fee can be shown.
 *
 * Cashiers should pick the area, not type it: every spelling of "Bukhari"
 * that reaches a rider costs a phone call, and the area decides the fee.
 */

import {
  DELIVERY_PLACES,
  DELIVERY_ZONES,
  feeRangeForZones,
  findZone,
  type DeliveryPlaceKind,
  type DeliveryZone,
  type ZoneGroup,
} from '@cheeseoclock/shared-types';
import { formatCents } from './money.js';

export interface AreaOption {
  /** Stable React key: "zone:dha-6", "place:Rahat Commercial". */
  key: string;
  /** "DHA Phase 6", "Rahat Commercial", "Khayaban-e-Ittehad". */
  label: string;
  kind: 'zone' | DeliveryPlaceKind;
  group: ZoneGroup;
  /** One zone = known exactly; several = ask which (see DeliveryPlace). */
  zoneIds: readonly string[];
}

/** Lower-case, punctuation to spaces, "ph6" → "ph 6", accents dropped. */
export function normalizeAreaText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[-_.,/()'’&#:;]+/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Indexed {
  option: AreaOption;
  order: number;
  labelNorm: string;
  /** Aliases + search hints, normalised. */
  searchAliases: string[];
  /** Every word the query may prefix-match. */
  words: string[];
}

const KIND_BONUS: Record<AreaOption['kind'], number> = { zone: 5, commercial: 3, landmark: 2, khayaban: 0 };

function groupOf(zoneIds: readonly string[], label: string): ZoneGroup {
  const groups = new Set(zoneIds.map((id) => findZone(id)?.group));
  const [group] = groups;
  if (groups.size !== 1 || !group) {
    throw new Error(`delivery-areas: "${label}" must list zones of exactly one group`);
  }
  return group;
}

function splitWords(texts: string[]): string[] {
  return [...new Set(texts.flatMap((t) => t.split(' ')).filter(Boolean))];
}

const INDEX: Indexed[] = [
  ...DELIVERY_ZONES.map((z, i): Indexed => {
    const labelNorm = normalizeAreaText(z.name);
    const searchAliases = [...z.aliases, ...z.hints].map(normalizeAreaText);
    return {
      option: { key: `zone:${z.id}`, label: z.name, kind: 'zone', group: z.group, zoneIds: [z.id] },
      order: i,
      labelNorm,
      searchAliases,
      words: splitWords([labelNorm, ...searchAliases]),
    };
  }),
  ...DELIVERY_PLACES.map((p, i): Indexed => {
    const labelNorm = normalizeAreaText(p.label);
    const searchAliases = (p.aliases ?? []).map(normalizeAreaText);
    const group = groupOf(p.zoneIds, p.label);
    // A place pinned to one zone is found by that zone's words too ("6"
    // lists Rahat Commercial); a road across phases only by its group.
    const only = p.zoneIds.length === 1 ? findZone(p.zoneIds[0]) : undefined;
    const zoneWords = only ? [normalizeAreaText(only.name), ...only.aliases.map(normalizeAreaText)] : [];
    return {
      option: { key: `place:${p.label}`, label: p.label, kind: p.kind, group, zoneIds: p.zoneIds },
      order: DELIVERY_ZONES.length + i,
      labelNorm,
      searchAliases,
      words: splitWords([labelNorm, ...searchAliases, ...zoneWords, normalizeAreaText(group)]),
    };
  }),
];

/** Every pickable area: the zones first (rate-card order), then the places. */
export const AREA_OPTIONS: readonly AreaOption[] = INDEX.map((e) => e.option);

/**
 * The order zones are offered in before the till has any history: the kitchen
 * is in Phase 6, so the nearest phases first, then the rest of DHA, then
 * Clifton. A starting guess — `rankZones` reorders by what this till delivers.
 */
const DEFAULT_ZONE_ORDER = [
  'dha-6',
  'dha-7',
  'dha-5',
  'dha-8',
  'dha-7-ext',
  'dha-4',
  'dha-3',
  'dha-2',
  'dha-2-ext',
  'dha-1',
  'emaar',
  'creek-vista',
  'clifton-1',
  'clifton-2',
  'clifton-3',
  'clifton-4',
  'clifton-5',
  'clifton-6',
  'clifton-7',
  'clifton-8',
  'clifton-9',
];

function defaultRank(zoneId: string): number {
  const i = DEFAULT_ZONE_ORDER.indexOf(zoneId);
  return i < 0 ? DEFAULT_ZONE_ORDER.length : i;
}

/** Zone usage for an option: its zone's count when it has exactly one. */
function usageOf(option: AreaOption, usage: ReadonlyMap<string, number> | undefined): number {
  if (!usage || option.zoneIds.length !== 1) return 0;
  return usage.get(option.zoneIds[0] ?? '') ?? 0;
}

/** All zones, most used on this till first; untouched zones in the default order. */
export function rankZones(usage?: ReadonlyMap<string, number>): DeliveryZone[] {
  return [...DELIVERY_ZONES].sort(
    (a, b) => (usage?.get(b.id) ?? 0) - (usage?.get(a.id) ?? 0) || defaultRank(a.id) - defaultRank(b.id),
  );
}

export interface SuggestOptions {
  limit?: number;
  /** Deliveries per zone id on this till (see `zoneUsageFromAreas`). */
  usage?: ReadonlyMap<string, number>;
}

function score(e: Indexed, q: string): number {
  let s: number;
  if (e.labelNorm === q) s = 100;
  else if (e.labelNorm.startsWith(q)) s = 70;
  else if (e.searchAliases.includes(q)) s = 60;
  else if (e.searchAliases.some((a) => a.startsWith(q))) s = 45;
  else if (e.labelNorm.includes(q)) s = 30;
  else s = 10;
  return s + KIND_BONUS[e.option.kind];
}

/**
 * Typeahead. Every typed word must start some word of the area's name, its
 * aliases, or (for a place pinned to one zone) that zone — so "kh sha" finds
 * Khayaban-e-Shahbaz, "6" lists Phase 6 and what is in it, "cl 2" finds
 * Clifton Block 2. With nothing typed: every zone, most used first.
 */
export function suggestDeliveryAreas(query: string, opts: SuggestOptions = {}): AreaOption[] {
  const limit = opts.limit ?? 8;
  const q = normalizeAreaText(query);
  if (!q) {
    return rankZones(opts.usage)
      .slice(0, limit)
      .map((z) => INDEX.find((e) => e.option.key === `zone:${z.id}`)!.option);
  }
  const words = q.split(' ');
  const scored: Array<{ e: Indexed; s: number }> = [];
  for (const e of INDEX) {
    if (!words.every((w) => e.words.some((hw) => hw.startsWith(w)))) continue;
    scored.push({ e, s: score(e, q) });
  }
  return scored
    .sort(
      (a, b) =>
        b.s - a.s ||
        usageOf(b.e.option, opts.usage) - usageOf(a.e.option, opts.usage) ||
        a.e.order - b.e.order,
    )
    .slice(0, limit)
    .map((x) => x.e.option);
}

/**
 * The text that goes on the ticket and into the saved address:
 *   zone                    → "DHA Phase 6"
 *   place, zone known       → "Rahat Commercial, DHA Phase 6"
 *   place, zone not chosen  → "Khayaban-e-Ittehad, DHA"
 * `zoneId` picks one of a multi-zone place's candidates.
 */
export function formatAreaText(option: AreaOption, zoneId?: string): string {
  if (option.kind === 'zone') return findZone(option.zoneIds[0])?.name ?? option.label;
  const chosen = zoneId && option.zoneIds.includes(zoneId) ? zoneId : option.zoneIds.length === 1 ? option.zoneIds[0] : undefined;
  const zone = findZone(chosen);
  return zone ? `${option.label}, ${zone.name}` : `${option.label}, ${option.group}`;
}

export interface ResolvedArea {
  /** The zone or place the text names, when recognised. */
  option: AreaOption | null;
  /** Candidate zones: one when the text pins the zone, several when it does not, none when unknown. */
  zoneIds: readonly string[];
}

/** Zone names and unambiguous aliases, longest first — "phase 7 extension" before "phase 7". */
const ZONE_KEYS: Array<{ key: string; zoneId: string }> = DELIVERY_ZONES.flatMap((z) =>
  [z.name, ...z.aliases].map((a) => ({ key: normalizeAreaText(a), zoneId: z.id })),
).sort((a, b) => b.key.length - a.key.length);

const PLACES = INDEX.filter((e) => e.option.kind !== 'zone').sort((a, b) => b.labelNorm.length - a.labelNorm.length);

/**
 * Recognise an area again — one saved on an address, typed by hand, or in the
 * format an older till wrote ("Phase 2 Extension, DHA Phase 2", "phase 6").
 * Search-only shorthand ("6", "block 5") is NOT trusted here: "Block 5" alone
 * could be Gulshan.
 */
export function resolveAreaText(text: string | null | undefined): ResolvedArea {
  const t = normalizeAreaText(text ?? '');
  if (!t) return { option: null, zoneIds: [] };
  const padded = ` ${t} `;
  const zoneHit = ZONE_KEYS.find((k) => padded.includes(` ${k.key} `));
  const place = PLACES.find((e) => t === e.labelNorm || t.startsWith(`${e.labelNorm} `));

  if (zoneHit) {
    if (place && place.option.zoneIds.includes(zoneHit.zoneId)) {
      return { option: place.option, zoneIds: [zoneHit.zoneId] };
    }
    const zoneOption = INDEX.find((e) => e.option.key === `zone:${zoneHit.zoneId}`)!.option;
    return { option: zoneOption, zoneIds: [zoneHit.zoneId] };
  }
  if (place) return { option: place.option, zoneIds: place.option.zoneIds };

  // A bare nickname typed on its own: "bukhari", "zamzama", "boat basin".
  const byAlias = PLACES.filter((e) => e.searchAliases.includes(t)).sort(
    (a, b) => KIND_BONUS[b.option.kind] - KIND_BONUS[a.option.kind] || a.order - b.order,
  );
  const hit = byAlias[0];
  if (hit) return { option: hit.option, zoneIds: hit.option.zoneIds };
  return { option: null, zoneIds: [] };
}

/** "Rs 200", "Rs 200–250" while the block is not known, or null for no zone. */
export function deliveryFeeText(zoneIds: readonly string[]): string | null {
  const range = feeRangeForZones(zoneIds);
  if (!range) return null;
  if (range.minCents === range.maxCents) return formatCents(range.minCents);
  return `${formatCents(range.minCents)}–${formatCents(range.maxCents, { showSymbol: false })}`;
}

/** The picker's second line: where the option is, or what is still to ask. */
export function areaOptionWhere(option: AreaOption): string {
  if (option.kind === 'zone') return option.group;
  if (option.zoneIds.length === 1) return findZone(option.zoneIds[0])?.name ?? option.group;
  return `${option.group} · ${option.group === 'DHA' ? 'which phase?' : 'which block?'}`;
}

/**
 * Deliveries per zone from saved-address area counts (the till's history).
 * Areas that do not pin one zone are not counted.
 */
export function zoneUsageFromAreas(rows: ReadonlyArray<{ area: string; count: number }>): Map<string, number> {
  const usage = new Map<string, number>();
  for (const r of rows) {
    const { zoneIds } = resolveAreaText(r.area);
    const only = zoneIds.length === 1 ? zoneIds[0] : undefined;
    if (only) usage.set(only, (usage.get(only) ?? 0) + r.count);
  }
  return usage;
}
