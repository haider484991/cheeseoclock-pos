/**
 * Where Cheese O'Clock delivers — ONE list, shared by the website checkout
 * (apps/web/src/lib/delivery-zones.ts re-exports it) and the till's address
 * entry (the area picker in the POS). Change a zone or a fee here and both
 * move together.
 *
 * Zones — source: the Dropoff rider service's 2026 rate card (Zone 1). The
 * owner delivers in DHA and Clifton ONLY; every other Karachi area on that
 * card is deliberately left out, and the website checkout refuses an order
 * without one of these zones (owner, 25 Sep 2026: "customers should not be
 * able to order outside our zones").
 *
 * The fee reaches the till as a real line item: the POS menu carries
 * "Delivery Charge (Rs 200)" and "Delivery Charge (Rs 250)" items (category
 * "Delivery Charges"), and the website server / the till's one-tap button add
 * the one whose price matches the zone. Changing a fee here means changing
 * that POS item's price too.
 *
 * Places — commercial areas, markets, roads and landmarks people name instead
 * of their phase or block ("Bukhari", "Boat Basin"). A place lists the zone(s)
 * it lies in: ONE only when we are sure which phase/block it is in; several
 * when a road crosses phases or we are not sure — the till then asks which.
 * Never guess a single zone: the zone decides the fee and where the rider goes.
 */

export type ZoneGroup = 'DHA' | 'Clifton';

export interface DeliveryZone {
  /** Stable id sent by the website checkout — never rename one that has shipped. */
  id: string;
  /** What the customer picks and what the till shows as the order's area. */
  name: string;
  /** Short chip text on the till: "Phase 6", "Block 2", "Emaar". */
  shortName: string;
  group: ZoneGroup;
  feeCents: number;
  /**
   * Other ways people write this zone that cannot mean anywhere else in
   * Karachi ("phase 6", "ph6", "clifton 5"). Used to search AND to recognise
   * an area typed or saved in an older format.
   */
  aliases: readonly string[];
  /**
   * Counter shorthand that only makes sense inside a search box ("6",
   * "block 5" — every Karachi society has a Block 5). Search only.
   */
  hints: readonly string[];
}

const RS200 = 20_000;
const RS250 = 25_000;

function dhaPhase(n: number): DeliveryZone {
  return {
    id: `dha-${n}`,
    name: `DHA Phase ${n}`,
    shortName: `Phase ${n}`,
    group: 'DHA',
    feeCents: RS200,
    aliases: [`phase ${n}`, `ph ${n}`, `ph${n}`, `dha ${n}`, `dha${n}`, `defence phase ${n}`, `defence ${n}`],
    hints: [`${n}`, `p${n}`, `p ${n}`],
  };
}

function dhaExtension(n: number): DeliveryZone {
  return {
    id: `dha-${n}-ext`,
    name: `DHA Phase ${n} Extension`,
    shortName: `Phase ${n} Ext`,
    group: 'DHA',
    feeCents: RS200,
    aliases: [
      `phase ${n} extension`,
      `phase ${n} ext`,
      `ph ${n} ext`,
      `ph${n} ext`,
      `dha phase ${n} ext`,
      `dha ${n} ext`,
    ],
    hints: [`${n} ext`, `${n} extension`, `p${n} ext`],
  };
}

function cliftonBlock(n: number, feeCents: number): DeliveryZone {
  return {
    id: `clifton-${n}`,
    name: `Clifton Block ${n}`,
    shortName: `Block ${n}`,
    group: 'Clifton',
    feeCents,
    aliases: [`clifton ${n}`, `clifton blk ${n}`, `block ${n} clifton`, `blk ${n} clifton`],
    hints: [`block ${n}`, `blk ${n}`, `b${n}`, `cl ${n}`, `cl${n}`],
  };
}

export const DELIVERY_ZONES: readonly DeliveryZone[] = [
  dhaPhase(1),
  dhaPhase(2),
  dhaExtension(2),
  dhaPhase(3),
  dhaPhase(4),
  dhaPhase(5),
  dhaPhase(6),
  dhaPhase(7),
  dhaExtension(7),
  dhaPhase(8),
  {
    id: 'emaar',
    name: 'Emaar Crescent Bay (DHA)',
    shortName: 'Emaar',
    group: 'DHA',
    feeCents: RS250,
    aliases: ['emaar', 'emaar crescent bay', 'crescent bay'],
    hints: ['ecb'],
  },
  {
    id: 'creek-vista',
    name: 'Creek Vista (DHA)',
    shortName: 'Creek Vista',
    group: 'DHA',
    feeCents: RS250,
    aliases: ['creek vista'],
    hints: ['creek'],
  },
  cliftonBlock(1, RS250),
  cliftonBlock(2, RS250),
  cliftonBlock(3, RS200),
  cliftonBlock(4, RS200),
  cliftonBlock(5, RS200),
  cliftonBlock(6, RS200),
  cliftonBlock(7, RS200),
  cliftonBlock(8, RS200),
  cliftonBlock(9, RS200),
];

/** The two fee tiers in customer words, for copy that summarises the card. */
export const FEE_SUMMARY = [
  { feeCents: RS200, places: 'DHA Phases 1–8 · Clifton Blocks 3–9' },
  { feeCents: RS250, places: 'Clifton Blocks 1 & 2 · Emaar & Creek Vista' },
] as const;

/** Every delivery address is in Karachi — the city is never in question. */
export const DELIVERY_CITY = 'Karachi';

export function findZone(id: string | null | undefined): DeliveryZone | undefined {
  if (!id) return undefined;
  return DELIVERY_ZONES.find((z) => z.id === id);
}

// ---------------------------------------------------------------------------
// Places people name instead of the phase / block
// ---------------------------------------------------------------------------

export type DeliveryPlaceKind = 'commercial' | 'khayaban' | 'landmark';

export interface DeliveryPlace {
  /** What the cashier sees and what goes on the ticket, e.g. "Rahat Commercial". */
  label: string;
  /**
   * The zone(s) this place lies in. One id = we are sure of the phase/block.
   * Several = a road that crosses phases, or a place whose block we are not
   * sure of: the till asks which one.
   */
  zoneIds: readonly string[];
  kind: DeliveryPlaceKind;
  /** Extra spellings people type: "bokhari", "kh e shahbaz". Search only. */
  aliases?: readonly string[];
}

/** DHA proper — phases 1–8 with their extensions. All Rs 200. */
const DHA_PHASES = ['dha-1', 'dha-2', 'dha-2-ext', 'dha-3', 'dha-4', 'dha-5', 'dha-6', 'dha-7', 'dha-7-ext', 'dha-8'] as const;
/** All nine Clifton blocks (Rs 200 or Rs 250 — the block decides). */
const CLIFTON_BLOCKS = [
  'clifton-1',
  'clifton-2',
  'clifton-3',
  'clifton-4',
  'clifton-5',
  'clifton-6',
  'clifton-7',
  'clifton-8',
  'clifton-9',
] as const;

const commercial = (label: string, zoneIds: readonly string[], aliases: string[] = []): DeliveryPlace => ({
  label,
  zoneIds,
  kind: 'commercial',
  aliases,
});
const landmark = (label: string, zoneIds: readonly string[], aliases: string[] = []): DeliveryPlace => ({
  label,
  zoneIds,
  kind: 'landmark',
  aliases,
});
/**
 * Khayabans are long DHA roads that run through several phases, so none is
 * pinned to one: picking one on the till asks for the phase.
 */
const khayaban = (name: string, aliases: string[] = []): DeliveryPlace => ({
  label: `Khayaban-e-${name}`,
  zoneIds: DHA_PHASES,
  kind: 'khayaban',
  aliases: [name, `kh ${name}`, `kh e ${name}`, `khy ${name}`, `khayaban ${name}`, ...aliases],
});

export const DELIVERY_PLACES: readonly DeliveryPlace[] = [
  // Phase 6 — home turf (the kitchen is in Rahat Commercial).
  commercial('Rahat Commercial', ['dha-6'], ['rahat']),
  commercial('Bukhari Commercial', ['dha-6'], ['bukhari', 'bokhari', 'big bukhari', 'small bukhari']),
  commercial('Nishat Commercial', ['dha-6'], ['nishat']),
  commercial('Muslim Commercial', ['dha-6'], ['muslim']),
  commercial('Shahbaz Commercial', ['dha-6'], ['shahbaz', 'shabaz']),
  // Not sure of the phase: it sits on Khayaban-e-Ittehad, which crosses 2 Ext, 6, 7 and 8.
  commercial('Ittehad Commercial', ['dha-2-ext', 'dha-6', 'dha-7', 'dha-8'], ['ittehad', 'itehad', 'ittihad']),

  // Phase 5
  commercial('Badar Commercial', ['dha-5'], ['badar', 'badr']),
  commercial('Zamzama Commercial', ['dha-5'], ['zamzama', 'zamzama boulevard']),
  commercial('Tauheed Commercial', ['dha-5'], ['tauheed', 'touheed', 'tohid']),
  commercial('Saba Commercial', ['dha-5'], ['saba']),
  landmark('Khadda Market', ['dha-5'], ['khadda', 'khada']),
  landmark('26th Street', ['dha-5'], ['26 street', '26th st']),
  landmark('Phase 5 Extension', ['dha-5'], ['phase 5 ext', 'ph 5 ext', '5 ext']),

  // Phase 4 and the older phases
  commercial('9th Commercial Street', ['dha-4'], ['9th commercial', 'ninth commercial']),
  commercial('Phase 1 Commercial', ['dha-1'], ['ph 1 commercial']),
  landmark('Defence Mor', ['dha-1', 'dha-2'], ['defence more', 'def mor']),
  landmark('Sunset Boulevard', ['dha-1', 'dha-2', 'dha-4'], ['sunset', 'sunset blvd']),

  // Phase 7
  commercial('Sehar Commercial', ['dha-7'], ['sehar', 'seher']),
  commercial('Jami Commercial', ['dha-7'], ['jami']),

  // Phase 8
  commercial('Zulfiqar Commercial', ['dha-8'], ['zulfiqar', 'zulfikar']),
  commercial('Al-Murtaza Commercial', ['dha-8'], ['murtaza', 'al murtaza']),
  landmark('Do Darya', ['dha-8'], ['dodarya', 'do darya']),
  landmark('Phase 8 Zone A', ['dha-8'], ['zone a']),
  landmark('Phase 8 Zone B', ['dha-8'], ['zone b']),
  landmark('Phase 8 Zone C', ['dha-8'], ['zone c']),
  landmark('Phase 8 Zone D', ['dha-8'], ['zone d']),
  landmark('Phase 8 Zone E', ['dha-8'], ['zone e']),

  // Khayabans (roads) — the phase is asked for.
  khayaban('Ittehad', ['itehad', 'ittihad']),
  khayaban('Shahbaz', ['shabaz']),
  khayaban('Bukhari', ['bokhari']),
  khayaban('Rahat'),
  khayaban('Nishat'),
  khayaban('Muslim'),
  khayaban('Badar', ['badr']),
  khayaban('Sehar', ['seher']),
  khayaban('Jami'),
  khayaban('Saadi', ['sadi']),
  khayaban('Shaheen'),
  khayaban('Qasim'),
  khayaban('Tanzeem'),
  khayaban('Bahria'),
  khayaban('Shamsheer'),
  khayaban('Momin'),
  khayaban('Tariq'),
  khayaban('Ghazi'),
  khayaban('Mujahid'),
  khayaban('Hafiz'),

  // Clifton
  landmark('Boat Basin', ['clifton-5'], ['boat basin']),
  landmark('Dolmen Mall Clifton', ['clifton-4'], ['dolmen']),
  landmark('Ocean Mall', ['clifton-9'], ['ocean tower', 'ocean towers']),
  // Block not pinned down — the till asks.
  landmark('Schon Circle', CLIFTON_BLOCKS, ['schon', 'schön']),
  landmark('Bilawal Chowrangi', CLIFTON_BLOCKS, ['bilawal']),
  landmark('Teen Talwar', CLIFTON_BLOCKS, ['3 talwar', 'teen talwar']),
  landmark('Kehkashan', CLIFTON_BLOCKS, ['kehkashan', 'kahkashan']),
];

// ---------------------------------------------------------------------------
// Fees and the delivery-charge menu item
// ---------------------------------------------------------------------------

/**
 * The fee for a set of candidate zones: the one fee when they all agree,
 * null when they differ (a Clifton landmark before the block is known) or
 * when none of the ids is a zone.
 */
export function feeForZones(zoneIds: readonly string[]): number | null {
  let fee: number | null = null;
  for (const id of zoneIds) {
    const zone = findZone(id);
    if (!zone) continue;
    if (fee === null) fee = zone.feeCents;
    else if (fee !== zone.feeCents) return null;
  }
  return fee;
}

/** Lowest and highest fee across candidate zones, or null when none is known. */
export function feeRangeForZones(zoneIds: readonly string[]): { minCents: number; maxCents: number } | null {
  const fees = zoneIds.map((id) => findZone(id)?.feeCents).filter((f): f is number => f !== undefined);
  if (fees.length === 0) return null;
  return { minCents: Math.min(...fees), maxCents: Math.max(...fees) };
}

/** "Delivery Charge (Rs 200)" — a POS item that exists only to carry the fee. */
export function isDeliveryChargeName(name: string): boolean {
  return /^delivery charge/i.test(name.trim());
}

/**
 * The "Delivery Charge (Rs N)" item whose price is this fee, or undefined
 * when the menu has none. Matched on price rather than the exact name so a
 * cashier retyping the name cannot break it.
 */
export function findDeliveryChargeItem<T extends { name: string; basePriceCents: number }>(
  items: readonly T[],
  feeCents: number,
): T | undefined {
  return items.find((i) => isDeliveryChargeName(i.name) && i.basePriceCents === feeCents);
}
