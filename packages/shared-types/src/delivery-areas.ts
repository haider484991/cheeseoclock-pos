/**
 * Where Cheese O'Clock delivers: the COMPILED list, today's 21 areas and
 * fees (source: the Dropoff rider service's 2026 rate card, Zone 1). FROZEN
 * since Settings step 3: the owner changes areas and fees in Settings →
 * Delivery areas ('delivery.zones', shop-settings.ts), and this list is only
 *  - that setting's default (DEFAULT_DELIVERY_ZONES: a till where nothing is
 *    saved works exactly as before),
 *  - the website's fallback while it holds no settings block
 *    (apps/web/src/lib/delivery-zones.ts re-exports it), and
 *  - the rider service's rate card, which Reports → Profit prices a rider
 *    trip from (never the owner's charge: a new fee must not rewrite past
 *    profit; rider pay is costing Phase 9's).
 * NEVER edit a zone or a fee here again: two tills, or a till and the
 * website, on different versions would disagree.
 *
 * The owner delivers in DHA and Clifton ONLY by default; every other Karachi
 * area on that card is deliberately left out, and the website checkout
 * refuses an order without one of these zones (owner, 25 Sep 2026:
 * "customers should not be able to order outside our zones").
 *
 * The fee reaches the till as a real line item: a "Delivery Charge (Rs N)"
 * menu item (category "Delivery Charges"). Since step 3 each saved zone names
 * its item (feeItemId), made or adopted by Settings → Delivery areas' Save;
 * until the first Save the item is found by its name and price, as before.
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

function dhaPhase(n: number, feeCents: number = RS200): DeliveryZone {
  return {
    id: `dha-${n}`,
    name: `DHA Phase ${n}`,
    shortName: `Phase ${n}`,
    group: 'DHA',
    feeCents,
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
  // Phase 8 is Rs 250 (owner 2026-09-27: "phase 8 250 ki category may jayega").
  dhaPhase(8, RS250),
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
  { feeCents: RS200, places: 'DHA Phases 1–7 · Clifton Blocks 3–9' },
  { feeCents: RS250, places: 'DHA Phase 8 · Emaar & Creek Vista · Clifton Blocks 1 & 2' },
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
 * THE test for "this order line is a delivery charge" wherever a rule treats
 * one differently from the food: an order's discount leaves it alone (owner,
 * 28 Sep 2026: "Delivery charges is separate we don't want to add discount
 * to it"), and so do the tax split, the FBR invoice and profit that follow
 * the discount. It reads the name the line was SOLD under
 * (order_items.menu_item_name, written once when the line is added), never
 * the live menu or a category: renaming an item, or marking a category "not
 * food" in Costing, can't move yesterday's split.
 *
 * Settings step 3 gave the charge items ids of their own (each zone's
 * feeItemId, deliveryZoneFeeItemIds): pass them as `feeItemIds` and a line
 * of one of those items is a delivery charge too, whatever it was called.
 * The NAME stays the test for a stored order: every reader after the fact
 * (the discount's split and tax, the FBR invoice, the receipt, Reports)
 * calls this without ids, so an order already paid reads back exactly as it
 * was worked. The two agree on every line sold since: a fee item is always
 * named deliveryChargeItemName(fee) — Save renames an adopted one, and Menu
 * locks the name.
 */
export function isDeliveryChargeLine(
  line: { readonly menuItemName?: string | null; readonly menuItemId?: string | null },
  feeItemIds?: ReadonlySet<string> | null,
): boolean {
  if (typeof line.menuItemName === 'string' && isDeliveryChargeName(line.menuItemName)) return true;
  return !!feeItemIds && typeof line.menuItemId === 'string' && feeItemIds.has(line.menuItemId);
}

/**
 * The order's discount left its delivery charge alone: the discount's frozen
 * rule says so (OrderDiscount.alsoOffDeliveryCharge false) and there is a
 * delivery charge on the order. The bill, the cart and Pay then say "food
 * only". False for every discount given before the rule existed (they came
 * off the delivery charge too), so a reprint of an old order never changes.
 */
export function discountLeavesDeliveryCharge(
  discount: { readonly alsoOffDeliveryCharge?: boolean } | null | undefined,
  items: ReadonlyArray<{ readonly menuItemName?: string | null }>,
): boolean {
  return discount?.alsoOffDeliveryCharge === false && items.some((l) => isDeliveryChargeLine(l));
}

/**
 * A discount's words on the printed bill: "Discount (Staff)", "Discount", or
 * the foodpanda deal's own label, as before, or an automatic offer's name
 * ("WhatsApp 10% off") — and, when it left the order's
 * delivery charge alone, "Discount 10% (Staff, food only)" / "Discount (food
 * only)" / "Foodpanda deal 20% off (food only)". Built from the discount's
 * frozen rule (discountLeavesDeliveryCharge), never the live setting, so a
 * DUPLICATE of an old order prints exactly what the first copy did.
 */
export function discountBillLabel(
  d: {
    readonly discountType: 'percent' | 'flat';
    readonly value: number;
    readonly reason?: string | null;
    readonly source?: string | null;
    readonly alsoOffDeliveryCharge?: boolean;
  },
  items: ReadonlyArray<{ readonly menuItemName?: string | null }>,
): string {
  const foodOnly = discountLeavesDeliveryCharge(d, items);
  // The foodpanda deal's label, and an automatic offer's NAME (its reason), print as themselves.
  if ((d.source === 'foodpanda' || d.source === 'offer') && d.reason) return foodOnly ? `${d.reason} (food only)` : d.reason;
  if (!foodOnly) return d.reason ? `Discount (${d.reason})` : 'Discount';
  const percent = d.discountType === 'percent' ? ` ${d.value}%` : '';
  return `Discount${percent} (${d.reason ? `${d.reason}, ` : ''}food only)`;
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

// ---------------------------------------------------------------------------
// The owner's delivery areas (Settings → Delivery areas, 'delivery.zones')
// ---------------------------------------------------------------------------

/**
 * One delivery area as the owner keeps it ('delivery.zones', Settings step
 * 3). The compiled DELIVERY_ZONES are the default. The list's order is the
 * order the till and the website show them in.
 */
export interface DeliveryZoneSetting {
  /**
   * Made once when the area is added and never changed: the website sends it,
   * browsers remember the last one, Reports group by it. Lower case letters,
   * digits and dashes (DELIVERY_ZONE_ID_RE). A zone is switched off, never
   * removed.
   */
  id: string;
  /** What the customer picks and what goes on the ticket ("DHA Phase 6"). A rename keeps the old name in `aliases`. */
  name: string;
  /** Chip text on the till: "Phase 6", "Block 2", "Emaar". */
  shortName: string;
  /** Free text heading: "DHA", "Clifton", "PECHS". */
  group: string;
  /** Whole rupees in paisa, Rs 0–2,000. Rs 0 = no delivery charge line (feeItemId null). */
  feeCents: number;
  /**
   * The "Delivery Charge (Rs N)" menu item that carries this fee (made with a
   * name-based id, or today's item adopted, by Save). Null for Rs 0, and in
   * the default (never saved): the item is then found by name and price.
   */
  feeItemId: string | null;
  /** Off = delivery there is paused: not offered on the till or the website, still recognised on old addresses. */
  active: boolean;
  /** Other ways people write it that cannot mean anywhere else in Karachi (search AND recognition). */
  aliases: string[];
  /** Counter shorthand, search only ("6", "block 5"). */
  hints: string[];
}

/** An area id: lower case letters and digits in dash-separated words, at most DELIVERY_ZONE_ID_MAX long. */
export const DELIVERY_ZONE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DELIVERY_ZONE_ID_MAX = 40;
/** The most areas the list holds (switched-off ones included). */
export const DELIVERY_ZONES_MAX = 60;
/** A delivery fee is whole rupees from Rs 0 to Rs 2,000 (the owner's bound). */
export const DELIVERY_FEE_MAX_CENTS = 200_000;
export const DELIVERY_ZONE_NAME_MAX = 60;
export const DELIVERY_ZONE_SHORT_NAME_MAX = 20;
export const DELIVERY_ZONE_GROUP_MAX = 30;
/** Spellings per area (aliases, and search hints, each). */
export const DELIVERY_ZONE_SPELLINGS_MAX = 30;
export const DELIVERY_ZONE_SPELLING_MAX = 60;

/**
 * Lower case, accents dropped, punctuation to spaces, "ph6" → "ph 6": how an
 * area typed, saved or searched is compared (the till's area search and the
 * area list's own checks).
 */
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

/**
 * An alias is trusted to NAME an area (a saved address, a typed one), so it
 * must not be counter shorthand that could be anywhere in Karachi: a bare
 * number, or "block 5" (every society has one). Those belong in the search
 * hints. Null when it is fine.
 */
export function zoneAliasProblem(alias: string): string | null {
  const n = normalizeAreaText(alias);
  if (!n) return 'A spelling can’t be empty';
  if (/^\d+$/.test(n)) return `"${alias}" is only a number — it could be anywhere; keep it as a search shortcut`;
  if (/^(block|blk) \d+$/.test(n)) return `"${alias}" could be any society's block — write the area too ("clifton ${n.replace(/^\D+/, '')}")`;
  return null;
}

/** "Rs 1,500": whole rupees for an item name (no locale: every till writes the same name). */
function rupeesWords(cents: number): string {
  const r = Math.round(cents / 100);
  return `Rs ${String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/**
 * The seed of a fee's menu item id: the till makes it a uuid v5 of this (its
 * COC_ID_NAMESPACE), so the Rs 300 item made on two tills saving offline is
 * the SAME row. Never change it: ids already made would no longer match.
 */
export function deliveryChargeItemIdSeed(feeCents: number): string {
  return `delivery-charge:${feeCents}`;
}

/**
 * Menu's word on a delivery charge item: Settings → Delivery areas makes,
 * prices and switches them, so Menu can't (the main process refuses; the
 * screen says why). Works for a manager, who can't open Settings.
 */
export const FEE_ITEM_LOCKED_NOTE = 'Set delivery fees in Settings → Delivery areas (ask the owner).';

/** Menu's note on a charge item no area that is on uses: it may go, its fee stays Settings'. */
export const FEE_ITEM_UNUSED_NOTE =
  'No delivery area that is on charges this fee: it can be hidden or deleted. Its name and price are set in Settings → Delivery areas.';

/** The menu category that holds the fee items (made with a name-based id when the shop has none). */
export const DELIVERY_CHARGES_CATEGORY_NAME = 'Delivery Charges';
/** Its id's seed (uuid v5, as deliveryChargeItemIdSeed). */
export const DELIVERY_CHARGES_CATEGORY_ID_SEED = 'category:delivery-charges';

/** The name of the menu item that carries a fee: "Delivery Charge (Rs 200)". The same on every till. */
export function deliveryChargeItemName(feeCents: number): string {
  return `Delivery Charge (${rupeesWords(feeCents)})`;
}

/** Every fee item the areas name (switched-off areas included). */
export function deliveryZoneFeeItemIds(zones: ReadonlyArray<{ readonly feeItemId?: string | null }>): Set<string> {
  const ids = new Set<string>();
  for (const z of zones) if (z.feeItemId) ids.add(z.feeItemId);
  return ids;
}

/**
 * Is this MENU item a delivery charge? One of the areas' fee items (by id),
 * or — for data from before Settings step 3 and an older till — named like
 * one. Menu locks it, the menu file import leaves it alone, Reports never
 * count it as food.
 */
export function isDeliveryChargeMenuItem(
  item: { readonly id: string; readonly name: string },
  feeItemIds?: ReadonlySet<string> | null,
): boolean {
  return (!!feeItemIds && feeItemIds.has(item.id)) || isDeliveryChargeName(item.name);
}

/**
 * The menu items the areas that are ON charge their fees with — what Menu
 * locks outright (name, price, on/off, category, delete): each such area's
 * own feeItemId when that item is there at its fee, and the item the area
 * is charged with now (zoneFeeItem among the items that are on — before
 * the first Save, today's by name and price). A charge item no area that is
 * on uses may be hidden or deleted in Menu like any item; its name and
 * price still make it a charge, so those stay Settings'.
 */
export function chargedFeeItemIds(
  /** `active` absent = on (as the till's reader has it). */
  zones: ReadonlyArray<{ readonly active?: boolean; readonly feeCents: number; readonly feeItemId?: string | null }>,
  items: ReadonlyArray<{ readonly id: string; readonly name: string; readonly basePriceCents: number; readonly isActive: boolean }>,
): Set<string> {
  const on = items.filter((i) => i.isActive);
  const ids = new Set<string>();
  for (const z of zones) {
    if (z.active === false || !(z.feeCents > 0)) continue;
    const own = z.feeItemId ? items.find((i) => i.id === z.feeItemId && i.basePriceCents === z.feeCents) : undefined;
    if (own) ids.add(own.id);
    const charged = zoneFeeItem(z, on);
    if (charged) ids.add(charged.id);
  }
  return ids;
}

/**
 * The menu item that charges an area's fee: its own feeItemId when that item
 * is there at exactly the fee, else — before the first Save, or while an
 * older till has moved things — today's match by name and price. Undefined
 * for a Rs 0 area (no charge line) or when the menu has none.
 */
export function zoneFeeItem<T extends { id: string; name: string; basePriceCents: number }>(
  zone: { readonly feeCents: number; readonly feeItemId?: string | null },
  items: readonly T[],
): T | undefined {
  if (!(zone.feeCents > 0)) return undefined;
  if (zone.feeItemId) {
    const own = items.find((i) => i.id === zone.feeItemId);
    if (own && own.basePriceCents === zone.feeCents) return own;
  }
  return findDeliveryChargeItem(items, zone.feeCents);
}

/**
 * An id for a new area, made once from its name when it is added:
 * "PECHS Block 6" → "pechs-block-6" (with "-2", "-3"… when taken).
 */
export function newDeliveryZoneId(name: string, taken: ReadonlySet<string>): string {
  const base =
    normalizeAreaText(name)
      .replace(/[^a-z0-9 ]+/g, '')
      .trim()
      .replace(/ +/g, '-')
      .slice(0, DELIVERY_ZONE_ID_MAX - 4)
      .replace(/-+$/g, '') || 'area';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}
