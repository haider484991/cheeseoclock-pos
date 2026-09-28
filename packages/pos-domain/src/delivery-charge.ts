/**
 * The delivery charge as the owner keeps it (Settings → Delivery areas,
 * 'delivery.zones'): pure rules the till's main process runs.
 *
 *  - planFeeItems: what Settings → Delivery areas' Save does to the
 *    "Delivery Charge (Rs N)" menu items — one per fee in use, made with a
 *    name-based id (two tills saving offline make the SAME row), today's
 *    items adopted on the first Save, an item no area uses any more switched
 *    off, never deleted — and which item each area points at (feeItemId).
 *  - deliveryChargeTarget / planDeliveryChargeLines: the owner's rule of
 *    28 Sep 2026 — "if delivery area selected the delivery fee should be
 *    automatically added". Picking an area on a delivery order puts its
 *    fee's item on the bill; another area swaps it; clearing the area or
 *    leaving Delivery takes it off. Never twice, never on foodpanda.
 *  - buildSettingsBlock: the stamped settings block that travels with the
 *    menu to the website (shared-types web-bridge.ts, THE SETTINGS BLOCK).
 */
import {
  DEFAULT_DELIVERY_ZONES,
  DEFAULT_SETTINGS_AT,
  deliveryChargeItemName,
  isDeliveryChargeName,
  zoneFeeItem,
  type DeliveryZoneSetting,
  type OrderMode,
  type PublishedSettings,
} from '@cheeseoclock/shared-types';
import type { DeliveryAreas } from './delivery-areas.js';
import { formatCents } from './money.js';

// ---------------------------------------------------------------------------
// Save: the fee items
// ---------------------------------------------------------------------------

/** A menu item that is, or could be, a delivery charge item (deleted ones too: a name-based row can come back). */
export interface FeeItemCandidate {
  id: string;
  name: string;
  basePriceCents: number;
  isActive: boolean;
  /** Soft-deleted (a fresh-start import, or an older till). */
  deleted: boolean;
  createdAt: string;
}

export type FeeItemAction =
  /** No item for this fee anywhere: make one with the fee's name-based id. */
  | { kind: 'create'; id: string; feeCents: number; name: string }
  /** The fee's own (name-based) row was deleted: bring it back, on, at the fee. */
  | { kind: 'restore'; id: string; feeCents: number; name: string }
  /** An item already there carries this fee: on, at exactly the fee, under the fee's name (an adopted one is renamed once). */
  | { kind: 'keep'; id: string; feeCents: number; name: string; adopted: boolean }
  /** No area charges this item's fee any more: switched off, never deleted. */
  | { kind: 'switchOff'; id: string };

export interface FeeItemPlan {
  actions: FeeItemAction[];
  /** The areas with their fee items (Rs 0 → null; a switched-off area → its fee's item when one exists). */
  zones: DeliveryZoneSetting[];
}

/**
 * What Save does to the fee items, for the list being saved.
 *
 * For each fee an area that is ON charges (Rs 0 needs none), the item is,
 * in this order (the same data gives the same answer on either till):
 *  1. the item the saved list already points at for that fee (each area
 *     keeps its item while its fee stays);
 *  2. the fee's own name-based row (idForFee), made by this till or the other;
 *  3. today's item, found by its name and price (the menu import's
 *     "Delivery Charge (Rs 200)"), on ones first, then the oldest — ADOPTED,
 *     keeping its id and renamed to the fee's name;
 *  4. the fee's own row brought back when it was deleted;
 *  5. a new item with the fee's name-based id.
 * An item the saved list pointed at that no area charges now is switched off.
 * Items that only look like a delivery charge and were never an area's are
 * left alone.
 */
export function planFeeItems(input: {
  zones: ReadonlyArray<Omit<DeliveryZoneSetting, 'feeItemId'> & { feeItemId?: string | null }>;
  /** The fee items of the list saved now (before this Save): each area's feeItemId. */
  previousFeeItemIds: ReadonlySet<string>;
  items: readonly FeeItemCandidate[];
  idForFee: (feeCents: number) => string;
}): FeeItemPlan {
  const live = input.items.filter((i) => !i.deleted);
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const actions: FeeItemAction[] = [];
  const chosen = new Map<number, string>();
  const taken = new Set<string>();

  const findExisting = (fee: number): { item: FeeItemCandidate; adopted: boolean } | null => {
    const previous = live
      .filter(
        (i) => input.previousFeeItemIds.has(i.id) && i.basePriceCents === fee && !taken.has(i.id),
      )
      .sort(stableOrder)[0];
    if (previous) return { item: previous, adopted: false };
    const own = byId.get(input.idForFee(fee));
    if (own && !own.deleted && !taken.has(own.id)) return { item: own, adopted: false };
    const today = live
      .filter((i) => isDeliveryChargeName(i.name) && i.basePriceCents === fee && !taken.has(i.id))
      .sort(stableOrder)[0];
    return today ? { item: today, adopted: true } : null;
  };

  const needed = [
    ...new Set(input.zones.filter((z) => z.active && z.feeCents > 0).map((z) => z.feeCents)),
  ].sort((a, b) => a - b);
  for (const fee of needed) {
    const name = deliveryChargeItemName(fee);
    const found = findExisting(fee);
    if (found) {
      actions.push({
        kind: 'keep',
        id: found.item.id,
        feeCents: fee,
        name,
        adopted: found.adopted,
      });
      chosen.set(fee, found.item.id);
      taken.add(found.item.id);
      continue;
    }
    const id = input.idForFee(fee);
    actions.push(
      byId.get(id)?.deleted
        ? { kind: 'restore', id, feeCents: fee, name }
        : { kind: 'create', id, feeCents: fee, name },
    );
    chosen.set(fee, id);
    taken.add(id);
  }

  // A switched-off area keeps pointing at its fee's item when there is one (never made just for it).
  const zones: DeliveryZoneSetting[] = input.zones.map((z) => {
    let feeItemId: string | null = null;
    if (z.feeCents > 0) {
      feeItemId = chosen.get(z.feeCents) ?? null;
      if (!feeItemId && !z.active) feeItemId = findExisting(z.feeCents)?.item.id ?? null;
    }
    return {
      id: z.id,
      name: z.name,
      shortName: z.shortName,
      group: z.group,
      feeCents: z.feeCents,
      feeItemId,
      active: z.active,
      aliases: [...z.aliases],
      hints: [...z.hints],
    };
  });

  const inUse = new Set(chosen.values());
  for (const id of [...input.previousFeeItemIds].sort()) {
    const item = byId.get(id);
    if (!item || item.deleted || !item.isActive || inUse.has(id)) continue;
    actions.push({ kind: 'switchOff', id });
  }
  return { actions, zones };
}

/**
 * "Put back the default" for the areas: today's 21 areas and fees; an area
 * the owner added stays, switched off (an area is never removed). Each area
 * keeps the fee item it has while its fee stays the same, so a list put
 * back reads as the default again (Save would point it there anyway).
 */
export function deliveryZonesPutBack(
  current: ReadonlyArray<DeliveryZoneSetting>,
): DeliveryZoneSetting[] {
  const now = new Map(current.map((z) => [z.id, z]));
  const defaults = DEFAULT_DELIVERY_ZONES.zones.map((z) => {
    const was = now.get(z.id);
    return {
      ...z,
      feeItemId: was && was.feeCents === z.feeCents ? was.feeItemId : null,
      aliases: [...z.aliases],
      hints: [...z.hints],
    };
  });
  const known = new Set(defaults.map((z) => z.id));
  const added = current
    .filter((z) => !known.has(z.id))
    .map((z) => ({ ...z, active: false, aliases: [...z.aliases], hints: [...z.hints] }));
  return [...defaults, ...added];
}

/** On first, then the oldest, then by id: the same pick on either till. */
function stableOrder(a: FeeItemCandidate, b: FeeItemCandidate): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The order: the fee follows the area
// ---------------------------------------------------------------------------

/** Why an order gets no delivery charge line, or why the till leaves its lines as they are. */
export type DeliveryChargeReason =
  /** Not a delivery (takeaway, dine-in, foodpanda…): no charge line. */
  | 'not_delivery'
  /** A delivery with no area yet: no charge line. */
  | 'no_area'
  /** The area is free to deliver to (Rs 0). */
  | 'free'
  /** Delivery to that area is switched off in Settings → Delivery areas. */
  | 'paused'
  /** The text does not name an area the shop knows: lines left as they are. */
  | 'unknown_area'
  /** A place across areas of different fees ("which phase?"): lines left as they are. */
  | 'which';

export type DeliveryChargeTarget =
  | { kind: 'none'; reason: 'not_delivery' | 'no_area' | 'free' | 'paused'; zoneName?: string }
  | { kind: 'leave'; reason: 'unknown_area' | 'which' }
  | {
      kind: 'fee';
      feeCents: number;
      /** The menu item that carries it (the area's feeItemId, else today's by name and price); null = none on the menu. */
      itemId: string | null;
      zoneName: string;
    };

/**
 * What the bill of an order of this type, for this area, should carry.
 * `items` are the menu items that are ON (the fee item must be sellable).
 */
export function deliveryChargeTarget(
  areas: DeliveryAreas,
  mode: OrderMode,
  area: string | null | undefined,
  items: ReadonlyArray<{ id: string; name: string; basePriceCents: number }>,
): DeliveryChargeTarget {
  if (mode !== 'delivery') return { kind: 'none', reason: 'not_delivery' };
  if (!area || !area.trim()) return { kind: 'none', reason: 'no_area' };
  const { zoneIds } = areas.resolveAreaText(area);
  const zones = zoneIds
    .map((id) => areas.findZone(id))
    .filter((z): z is NonNullable<typeof z> => !!z);
  if (zones.length === 0) return { kind: 'leave', reason: 'unknown_area' };
  const on = zones.filter((z) => z.active !== false);
  if (on.length === 0) return { kind: 'none', reason: 'paused', zoneName: zones[0]!.name };
  const fee = areas.feeForZones(on.map((z) => z.id));
  if (fee === null) return { kind: 'leave', reason: 'which' };
  if (fee === 0) return { kind: 'none', reason: 'free', zoneName: on[0]!.name };
  const zone = on[0]!;
  const item = zoneFeeItem({ feeCents: fee, feeItemId: zone.feeItemId ?? null }, items);
  return {
    kind: 'fee',
    feeCents: fee,
    itemId: item?.id ?? null,
    zoneName: on.length === 1 ? zone.name : area.trim(),
  };
}

/** A delivery charge line already on the order. */
export interface ChargeLine {
  id: string;
  unitPriceCents: number;
  quantity: number;
}

/**
 * The change that brings an order's delivery charge lines to the target:
 *  - no charge (not a delivery, no area, free, paused): every charge line off;
 *  - a fee: a line at exactly that fee stays (never a second one); lines at
 *    any other fee come off; with none left at the fee, its item goes on;
 *  - an area the till can't pin to one fee: nothing changes.
 */
export function planDeliveryChargeLines(
  target: DeliveryChargeTarget,
  lines: readonly ChargeLine[],
): { remove: string[]; add: string | null } {
  if (target.kind === 'leave') return { remove: [], add: null };
  if (target.kind === 'none') return { remove: lines.map((l) => l.id), add: null };
  const right = lines.filter((l) => l.unitPriceCents === target.feeCents);
  const remove = lines.filter((l) => l.unitPriceCents !== target.feeCents).map((l) => l.id);
  return { remove, add: right.length === 0 ? target.itemId : null };
}

/** The line under the area on the till: what the bill carries for it, in words. */
export function deliveryChargeWords(target: DeliveryChargeTarget): string | null {
  switch (target.kind) {
    case 'fee':
      return target.itemId
        ? `${formatCents(target.feeCents)} delivery charge`
        : `No “${deliveryChargeItemName(target.feeCents)}” item on the menu — the owner saves Settings → Delivery areas to make it`;
    case 'none':
      if (target.reason === 'paused')
        return `Delivery to ${target.zoneName ?? 'this area'} is switched off in Settings → Delivery areas: no charge added`;
      if (target.reason === 'free') return `Delivery to ${target.zoneName ?? 'this area'} is free`;
      return null;
    case 'leave':
      return target.reason === 'which'
        ? 'Pick the phase or block to add the delivery charge'
        : null;
  }
}

// ---------------------------------------------------------------------------
// The website's settings block
// ---------------------------------------------------------------------------

/** A carried key's row as it is on this till (null = never saved). */
export interface SettingStamp {
  version: number;
  updatedAt: string;
}

/**
 * The settings block for the menu publish: every area (switched-off ones
 * too) in display order, each ACTIVE one with a fee naming the item of
 * `menuItems` that carries it (its feeItemId when that item is there at
 * the fee, else today's by name and price); the pick-up offer; the stamp
 * (sum of the carried keys' versions, their newest updated_at). The caller
 * checks it against the same menu (settingsBlockProblem) before sending.
 */
export function buildSettingsBlock(input: {
  zones: readonly DeliveryZoneSetting[];
  pickup: { offered: boolean; percent: number };
  stamps: ReadonlyArray<SettingStamp | null>;
  menuItems: ReadonlyArray<{ id: string; name: string; basePriceCents: number }>;
}): PublishedSettings {
  let rev = 0;
  let at = DEFAULT_SETTINGS_AT;
  for (const s of input.stamps) {
    if (!s) continue;
    rev += s.version;
    if (Date.parse(s.updatedAt) > Date.parse(at)) at = s.updatedAt;
  }
  return {
    v: 1,
    settingsAt: at,
    settingsRev: rev,
    pickup: { offered: input.pickup.offered, percent: input.pickup.percent },
    zones: input.zones.map((z, sort) => {
      const item = z.feeCents > 0 ? zoneFeeItem(z, input.menuItems) : undefined;
      return {
        id: z.id,
        name: z.name,
        shortName: z.shortName,
        group: z.group,
        feeCents: z.feeCents,
        feeItemId: z.feeCents > 0 ? (item?.id ?? (z.active ? null : z.feeItemId)) : null,
        active: z.active,
        sort,
        aliases: [...z.aliases],
      };
    }),
  };
}
