/**
 * Delivery-area search for the till's address entry.
 *
 * The areas — zones with their fees — are the owner's ('delivery.zones',
 * Settings → Delivery areas; the compiled DELIVERY_ZONES are its default).
 * The places people name instead of a phase or block are the compiled
 * DELIVERY_PLACES (shared-types delivery-areas.ts), keyed by zone id. This
 * module is the pure logic on top, as a FUNCTION OF THE ZONE LIST
 * (deliveryAreas(zones), memoised per list): typeahead, turning a pick into
 * the text that goes on the ticket, and recognising a saved or typed area
 * again so its fee can be shown. Nothing here reads a constant list: every
 * caller passes the zones it read from the setting.
 *
 * Cashiers should pick the area, not type it: every spelling of "Bukhari"
 * that reaches a rider costs a phone call, and the area decides the fee.
 *
 * A SWITCHED-OFF area (active false) is still recognised — on an old address,
 * in Reports — but never offered: the picker hides it, and a place whose
 * areas are all off is hidden too.
 */

import {
  DELIVERY_PLACES,
  normalizeAreaText,
  type DeliveryPlaceKind,
} from '@cheeseoclock/shared-types';
import { formatCents } from './money.js';

export { normalizeAreaText };

/** An area as this module needs it: the setting's zones and the compiled ones both fit. */
export interface AreaZone {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly group: string;
  readonly feeCents: number;
  readonly aliases: readonly string[];
  readonly hints: readonly string[];
  /** Absent = on (the compiled list). */
  readonly active?: boolean;
  readonly feeItemId?: string | null;
}

export interface AreaOption {
  /** Stable React key: "zone:dha-6", "place:Rahat Commercial". */
  key: string;
  /** "DHA Phase 6", "Rahat Commercial", "Khayaban-e-Ittehad". */
  label: string;
  kind: 'zone' | DeliveryPlaceKind;
  group: string;
  /** One zone = known exactly; several = ask which (see DeliveryPlace). */
  zoneIds: readonly string[];
}

export interface ResolvedArea {
  /** The zone or place the text names, when recognised. */
  option: AreaOption | null;
  /** Candidate zones: one when the text pins the zone, several when it does not, none when unknown. */
  zoneIds: readonly string[];
}

export interface SuggestOptions {
  limit?: number;
  /** Deliveries per zone id on this till (see `zoneUsageFromAreas`). */
  usage?: ReadonlyMap<string, number>;
}

/** Everything the till does with the areas, for one zone list. */
export interface DeliveryAreas {
  /** Every area, in the list's order (switched-off ones too). */
  readonly zones: readonly AreaZone[];
  /** The areas delivered to now, in the list's order. */
  readonly activeZones: readonly AreaZone[];
  /** The groups, in the order their first area comes ("DHA", "Clifton"…). */
  readonly groups: readonly string[];
  /** Every option: the zones first (list order), then the places. Switched-off ones included (recognition). */
  readonly options: readonly AreaOption[];
  findZone(id: string | null | undefined): AreaZone | undefined;
  isActive(id: string | null | undefined): boolean;
  /** Areas delivered to now, most used on this till first; untouched ones in the first-day order. */
  rankZones(usage?: ReadonlyMap<string, number>): AreaZone[];
  /** Typeahead over the areas delivered to now (see suggestDeliveryAreas below). */
  suggest(query: string, opts?: SuggestOptions): AreaOption[];
  formatAreaText(option: AreaOption, zoneId?: string): string;
  resolveAreaText(text: string | null | undefined): ResolvedArea;
  /** The one fee when the candidate zones agree, null when they differ or none is known. */
  feeForZones(zoneIds: readonly string[]): number | null;
  feeRangeForZones(zoneIds: readonly string[]): { minCents: number; maxCents: number } | null;
  /** "Rs 200", "Rs 200–250" while the block is not known, or null for no zone. */
  deliveryFeeText(zoneIds: readonly string[]): string | null;
  /** The picker's second line: where the option is, or what is still to ask. */
  areaOptionWhere(option: AreaOption): string;
  /** "Which phase?" / "Which block?" — the question a place across several areas asks, from the areas' own short names. */
  whichQuestion(zoneIds: readonly string[]): string;
  /** Deliveries per zone from saved-address area counts (only areas that pin one zone count). */
  zoneUsageFromAreas(rows: ReadonlyArray<{ area: string; count: number }>): Map<string, number>;
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

const KIND_BONUS: Record<AreaOption['kind'], number> = {
  zone: 5,
  commercial: 3,
  landmark: 2,
  khayaban: 0,
};

/**
 * The order the released areas are offered in before the till has any
 * history: the kitchen is in Phase 6, so the nearest phases first, then the
 * rest of DHA, then Clifton. A starting guess — rankZones reorders by what
 * this till delivers. An area the owner adds comes after these, in the
 * list's order.
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

function splitWords(texts: string[]): string[] {
  return [...new Set(texts.flatMap((t) => t.split(' ')).filter(Boolean))];
}

const on = (z: AreaZone | undefined): boolean => !!z && z.active !== false;

function build(zones: readonly AreaZone[]): DeliveryAreas {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const findZone = (id: string | null | undefined) => (id ? byId.get(id) : undefined);
  const activeZones = zones.filter(on);
  const groups = [...new Set(zones.map((z) => z.group))];
  const listIndex = new Map(zones.map((z, i) => [z.id, i]));

  const index: Indexed[] = [
    ...zones.map((z, i): Indexed => {
      const labelNorm = normalizeAreaText(z.name);
      const searchAliases = [...z.aliases, ...z.hints].map(normalizeAreaText);
      return {
        option: {
          key: `zone:${z.id}`,
          label: z.name,
          kind: 'zone',
          group: z.group,
          zoneIds: [z.id],
        },
        order: i,
        labelNorm,
        searchAliases,
        words: splitWords([labelNorm, ...searchAliases]),
      };
    }),
    ...DELIVERY_PLACES.flatMap((p, i): Indexed[] => {
      const zoneIds = p.zoneIds.filter((id) => byId.has(id));
      const first = findZone(zoneIds[0]);
      // Saving the areas keeps each place's areas in one group (the schema's rule); never throw at startup.
      if (!first) return [];
      const group = first.group;
      const labelNorm = normalizeAreaText(p.label);
      const searchAliases = (p.aliases ?? []).map(normalizeAreaText);
      // A place pinned to one zone is found by that zone's words too ("6"
      // lists Rahat Commercial); a road across phases only by its group.
      const only = zoneIds.length === 1 ? first : undefined;
      const zoneWords = only
        ? [normalizeAreaText(only.name), ...only.aliases.map(normalizeAreaText)]
        : [];
      return [
        {
          option: { key: `place:${p.label}`, label: p.label, kind: p.kind, group, zoneIds },
          order: zones.length + i,
          labelNorm,
          searchAliases,
          words: splitWords([labelNorm, ...searchAliases, ...zoneWords, normalizeAreaText(group)]),
        },
      ];
    }),
  ];
  const zoneEntry = new Map(
    index.filter((e) => e.option.kind === 'zone').map((e) => [e.option.zoneIds[0]!, e]),
  );
  /** Offered in the picker: an area that is on, or a place with at least one area that is on. */
  const offered = (o: AreaOption) => o.zoneIds.some((id) => on(byId.get(id)));

  const defaultRank = (zoneId: string): number => {
    const i = DEFAULT_ZONE_ORDER.indexOf(zoneId);
    return i >= 0 ? i : DEFAULT_ZONE_ORDER.length + (listIndex.get(zoneId) ?? zones.length);
  };
  const usageOf = (option: AreaOption, usage: ReadonlyMap<string, number> | undefined): number => {
    if (!usage || option.zoneIds.length !== 1) return 0;
    return usage.get(option.zoneIds[0] ?? '') ?? 0;
  };
  const rankZones = (usage?: ReadonlyMap<string, number>): AreaZone[] =>
    [...activeZones].sort(
      (a, b) =>
        (usage?.get(b.id) ?? 0) - (usage?.get(a.id) ?? 0) || defaultRank(a.id) - defaultRank(b.id),
    );

  const score = (e: Indexed, q: string): number => {
    let s: number;
    if (e.labelNorm === q) s = 100;
    else if (e.labelNorm.startsWith(q)) s = 70;
    else if (e.searchAliases.includes(q)) s = 60;
    else if (e.searchAliases.some((a) => a.startsWith(q))) s = 45;
    else if (e.labelNorm.includes(q)) s = 30;
    else s = 10;
    return s + KIND_BONUS[e.option.kind];
  };

  const suggest = (query: string, opts: SuggestOptions = {}): AreaOption[] => {
    const limit = opts.limit ?? 8;
    const q = normalizeAreaText(query);
    if (!q) {
      return rankZones(opts.usage)
        .slice(0, limit)
        .map((z) => zoneEntry.get(z.id)!.option);
    }
    const words = q.split(' ');
    const scored: Array<{ e: Indexed; s: number }> = [];
    for (const e of index) {
      if (!offered(e.option)) continue;
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
  };

  const formatAreaText = (option: AreaOption, zoneId?: string): string => {
    if (option.kind === 'zone') return findZone(option.zoneIds[0])?.name ?? option.label;
    const chosen =
      zoneId && option.zoneIds.includes(zoneId)
        ? zoneId
        : option.zoneIds.length === 1
          ? option.zoneIds[0]
          : undefined;
    const zone = findZone(chosen);
    return zone ? `${option.label}, ${zone.name}` : `${option.label}, ${option.group}`;
  };

  /** Zone names and unambiguous aliases, longest first — "phase 7 extension" before "phase 7". */
  const zoneKeys: Array<{ key: string; zoneId: string }> = zones
    .flatMap((z) =>
      [z.name, ...z.aliases].map((a) => ({ key: normalizeAreaText(a), zoneId: z.id })),
    )
    .filter((k) => k.key !== '')
    .sort((a, b) => b.key.length - a.key.length);
  const places = index
    .filter((e) => e.option.kind !== 'zone')
    .sort((a, b) => b.labelNorm.length - a.labelNorm.length);

  /**
   * Recognise an area again — one saved on an address, typed by hand, or in
   * the format an older till wrote ("Phase 2 Extension, DHA Phase 2",
   * "phase 6"), or under an area's old name (a rename keeps it). Search-only
   * shorthand ("6", "block 5") is NOT trusted here: "Block 5" alone could be
   * Gulshan.
   */
  const resolveAreaText = (text: string | null | undefined): ResolvedArea => {
    const t = normalizeAreaText(text ?? '');
    if (!t) return { option: null, zoneIds: [] };
    const padded = ` ${t} `;
    const zoneHit = zoneKeys.find((k) => padded.includes(` ${k.key} `));
    const place = places.find((e) => t === e.labelNorm || t.startsWith(`${e.labelNorm} `));

    if (zoneHit) {
      if (place && place.option.zoneIds.includes(zoneHit.zoneId)) {
        return { option: place.option, zoneIds: [zoneHit.zoneId] };
      }
      return { option: zoneEntry.get(zoneHit.zoneId)!.option, zoneIds: [zoneHit.zoneId] };
    }
    if (place) return { option: place.option, zoneIds: place.option.zoneIds };

    // A bare nickname typed on its own: "bukhari", "zamzama", "boat basin".
    const byAlias = places
      .filter((e) => e.searchAliases.includes(t))
      .sort((a, b) => KIND_BONUS[b.option.kind] - KIND_BONUS[a.option.kind] || a.order - b.order);
    const hit = byAlias[0];
    if (hit) return { option: hit.option, zoneIds: hit.option.zoneIds };
    return { option: null, zoneIds: [] };
  };

  const feeForZones = (zoneIds: readonly string[]): number | null => {
    let fee: number | null = null;
    for (const id of zoneIds) {
      const zone = findZone(id);
      if (!zone) continue;
      if (fee === null) fee = zone.feeCents;
      else if (fee !== zone.feeCents) return null;
    }
    return fee;
  };
  const feeRangeForZones = (zoneIds: readonly string[]) => {
    const fees = zoneIds
      .map((id) => findZone(id)?.feeCents)
      .filter((f): f is number => f !== undefined);
    if (fees.length === 0) return null;
    return { minCents: Math.min(...fees), maxCents: Math.max(...fees) };
  };
  const deliveryFeeText = (zoneIds: readonly string[]): string | null => {
    const range = feeRangeForZones(zoneIds);
    if (!range) return null;
    if (range.minCents === range.maxCents) return formatCents(range.minCents);
    return `${formatCents(range.minCents)}–${formatCents(range.maxCents, { showSymbol: false })}`;
  };
  const whichWord = (zoneIds: readonly string[]): string => {
    const firsts = new Set(
      zoneIds
        .map((id) => findZone(id)?.shortName.trim().split(/\s+/)[0]?.toLowerCase())
        .filter((w): w is string => !!w),
    );
    const [only] = firsts;
    return firsts.size === 1 && only && !/\d/.test(only) ? only : 'area';
  };
  const whichQuestion = (zoneIds: readonly string[]): string => {
    const w = whichWord(zoneIds);
    return `Which ${w}?`;
  };
  const areaOptionWhere = (option: AreaOption): string => {
    if (option.kind === 'zone') return option.group;
    if (option.zoneIds.length === 1) return findZone(option.zoneIds[0])?.name ?? option.group;
    return `${option.group} · which ${whichWord(option.zoneIds)}?`;
  };
  const zoneUsageFromAreas = (
    rows: ReadonlyArray<{ area: string; count: number }>,
  ): Map<string, number> => {
    const usage = new Map<string, number>();
    for (const r of rows) {
      const { zoneIds } = resolveAreaText(r.area);
      const only = zoneIds.length === 1 ? zoneIds[0] : undefined;
      if (only) usage.set(only, (usage.get(only) ?? 0) + r.count);
    }
    return usage;
  };

  return {
    zones,
    activeZones,
    groups,
    options: index.map((e) => e.option),
    findZone,
    isActive: (id) => on(findZone(id)),
    rankZones,
    suggest,
    formatAreaText,
    resolveAreaText,
    feeForZones,
    feeRangeForZones,
    deliveryFeeText,
    areaOptionWhere,
    whichQuestion,
    zoneUsageFromAreas,
  };
}

/** What makes two lists the same for the helpers (a fresh read of the same setting is the same list). */
function contentKey(zones: readonly AreaZone[]): string {
  return JSON.stringify(
    zones.map((z) => [
      z.id,
      z.name,
      z.shortName,
      z.group,
      z.feeCents,
      z.active !== false,
      z.aliases,
      z.hints,
      z.feeItemId ?? null,
    ]),
  );
}

const byList = new WeakMap<readonly AreaZone[], DeliveryAreas>();
const byContent = new Map<string, DeliveryAreas>();
/** Lists kept by content: a Save or two a day, and the default. */
const CONTENT_CACHE_MAX = 8;

/**
 * The area helpers for a zone list, memoised: the same array object (a
 * React memo, the default) at once; a fresh read of the same setting by its
 * content. Build it from the zones the setting holds now — never from a
 * constant.
 */
export function deliveryAreas(zones: readonly AreaZone[]): DeliveryAreas {
  const hit = byList.get(zones);
  if (hit) return hit;
  const key = contentKey(zones);
  let areas = byContent.get(key);
  if (!areas) {
    areas = build(zones);
    if (byContent.size >= CONTENT_CACHE_MAX) {
      const oldest = byContent.keys().next().value;
      if (oldest !== undefined) byContent.delete(oldest);
    }
    byContent.set(key, areas);
  }
  byList.set(zones, areas);
  return areas;
}
