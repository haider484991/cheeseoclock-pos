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
 *    fee's item on the bill; another area swaps it (one the till can't pin
 *    to a fee takes the old charge off); clearing the area or leaving
 *    Delivery takes it off. Never twice, never on foodpanda.
 *  - buildSettingsBlock: the stamped settings block that travels with the
 *    menu to the website (shared-types web-bridge.ts, THE SETTINGS BLOCK).
 */
import {
  DEFAULT_DELIVERY_ZONES,
  DEFAULT_SETTINGS_AT,
  compareSettingsStamp,
  deliveryChargeItemName,
  isDeliveryChargeName,
  zoneFeeItem,
  type ClosedNotice,
  type DeliveryZoneSetting,
  type OrderMode,
  type PublishedSettings,
  type SettingsStamp,
  type WebsiteAnnouncement,
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
 * A delivery-charge item that is on, and that no area that is on charges
 * now, is switched off (never deleted) when the areas charged it before:
 *  - the saved list pointed at it (feeItemId);
 *  - a Save made it (its fee's name-based id) — left on by a Save on the
 *    other till that the link settled against (two offline Saves);
 *  - it is named like a charge at a fee the saved list charged: before the
 *    first Save the areas charge today's items by name and price, so the
 *    first Save that moves every Rs 250 area switches today's Rs 250 item
 *    off (Menu can't switch a fee item off, so nothing else ever would).
 * Items that only look like a delivery charge, at a fee no area charged
 * (the owner's own "Delivery charge long distance"), are left alone.
 */
export function planFeeItems(input: {
  zones: ReadonlyArray<Omit<DeliveryZoneSetting, 'feeItemId'> & { feeItemId?: string | null }>;
  /** The fee items of the list saved now (before this Save): each area's feeItemId. */
  previousFeeItemIds: ReadonlySet<string>;
  /**
   * The fees the list saved now (before this Save) charges — for a till
   * that never saved, the default's Rs 200 and Rs 250, whose items the areas
   * found by name and price. Absent = none.
   */
  previousFees?: ReadonlySet<number>;
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
  const off = new Set<string>();
  for (const item of input.items) {
    if (item.deleted || !item.isActive || inUse.has(item.id)) continue;
    const theAreas =
      input.previousFeeItemIds.has(item.id) ||
      input.idForFee(item.basePriceCents) === item.id ||
      (isDeliveryChargeName(item.name) && (input.previousFees?.has(item.basePriceCents) ?? false));
    if (theAreas) off.add(item.id);
  }
  for (const id of [...off].sort()) actions.push({ kind: 'switchOff', id });
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
  /** The text does not name an area the shop knows: lines left as they are (after an area the till charged, that charge comes off: planDeliveryChargeOnAreaChange). */
  | 'unknown_area'
  /** A place across areas of different fees ("which phase?"): lines left as they are (after an area the till charged, that charge comes off). */
  | 'which';

export type DeliveryChargeTarget =
  | { kind: 'none'; reason: 'not_delivery' | 'no_area' | 'free' | 'paused'; zoneName?: string }
  | {
      kind: 'leave';
      reason: 'unknown_area' | 'which';
      /** 'which': one of the places it may be has delivery switched off (the cashier must be told). */
      pausedName?: string;
    }
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
  // A place across areas where one is switched off ("Khayaban-e-Ittehad" with Phase 8 paused): the
  // customer may be in the paused one, so the till asks which rather than charging the other's fee.
  const paused = zones.find((z) => z.active === false);
  if (paused) return { kind: 'leave', reason: 'which', pausedName: paused.name };
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

/**
 * The change an AREA CHANGE brings (the owner's rule: changing the area
 * swaps the charge). As planDeliveryChargeLines, except that a new area the
 * till can't pin to one fee ('leave': not on the list, or a road across
 * phases) after an area the till charged a fee for takes that charge off —
 * it was the old area's, and nothing says it is this one's. After no area,
 * or one the till charged nothing for, a charge tapped on by hand is left
 * alone. `previous` = the target of the area before (null = none yet).
 */
export function planDeliveryChargeOnAreaChange(
  previous: DeliveryChargeTarget | null,
  target: DeliveryChargeTarget,
  lines: readonly ChargeLine[],
): { remove: string[]; add: string | null } {
  if (target.kind === 'leave') {
    return previous?.kind === 'fee' ? { remove: lines.map((l) => l.id), add: null } : { remove: [], add: null };
  }
  return planDeliveryChargeLines(target, lines);
}

/**
 * Are two area texts the same place for the delivery charge? The same words
 * (spaces and case aside), or words that name the same area or areas of the
 * list: "DHA Phase 6" and "Phase 6, DHA" — a customer's two saved addresses
 * for one place, picked in turn — are not an area CHANGE, so a charge the
 * cashier took off by hand stays off. Text that names no area of the list
 * is compared by its words only.
 */
export function sameDeliveryArea(
  areas: DeliveryAreas,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const words = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (words(a) === words(b)) return true;
  const place = (s: string | null | undefined) => [...new Set(areas.resolveAreaText(s).zoneIds)].sort().join('|');
  const pa = place(a);
  return pa !== '' && pa === place(b);
}

/**
 * What the delivery-charge row on the till's customer panel tells the main
 * process (orders:setDeliveryArea), and what it keeps to itself.
 *
 * The main process puts the area's charge on, swaps it, or takes it off when
 * the area CHANGES (order-repo deliveryChargeForArea). An area the cashier
 * types or picks is a change, and so is an area CLEARED — one the row told
 * for this order, then emptied. An empty panel the row never saw filled is
 * not: the order-type switch empties the customer form, and so does a
 * restart (the draft comes back, the form does not), while the order keeps
 * its area and the charge the main process put back for it. Telling "no
 * area" then took the charge off, and Send let the order go on its saved
 * address without the fee (review of f55e3f0).
 *
 * One per row on screen: a new row (the details step shown again, the till
 * restarted) starts knowing nothing. It remembers only the order it told.
 * `told` is called when the ask actually goes (after the row's short wait),
 * so an area typed and deleted inside that wait was never told.
 */
export interface DeliveryAreaTeller {
  /** Does the row tell the main process this area for this order? */
  shouldTell(orderId: string | null, area: string): boolean;
  /** The row told the main process this area for this order. */
  told(orderId: string | null, area: string): void;
}

export function makeDeliveryAreaTeller(): DeliveryAreaTeller {
  let last: { orderId: string | null; area: string } | null = null;
  return {
    shouldTell(orderId, area) {
      if (area.trim() !== '') return true;
      // Empty: a clear only after an area this row told for this order.
      return last !== null && last.orderId === orderId && last.area !== '';
    },
    told(orderId, area) {
      last = { orderId, area: area.trim() };
    },
  };
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
      if (target.reason === 'unknown_area') {
        return 'Not one of the delivery areas (Settings → Delivery areas): the till adds no delivery charge, and takes off the one it added for the area before. Add one by hand if you deliver there.';
      }
      return target.pausedName
        ? `Pick the phase or block to add the delivery charge — delivery to ${target.pausedName} is switched off in Settings → Delivery areas`
        : 'Pick the phase or block to add the delivery charge';
  }
}

/**
 * What the till's delivery-charge row says about the bill for an area it
 * charges (target 'fee' with its item; CustomerInlinePanel). `lines` are the
 * order's delivery-charge lines; `told` = the main process has answered the
 * row's area (until then the bill may not show the area's charge yet).
 *  - 'on': the area's charge is on the bill ("Take it off"; `qty` > 1: check it).
 *  - 'other': a charge at ANOTHER fee is on the bill — the fee raised while
 *    the order was open (a charge on the bill keeps its price), or another
 *    charge tapped on by hand. Both fees are named, and one tap ("Put it
 *    back" in the main process: the area's charge, the others off) swaps it.
 *    Never "taken off by hand": a charge IS on the bill (review of 865657b).
 *  - 'telling': none on the bill yet, the till still being told: the fee alone.
 *  - 'off': none on the bill after the till answered: taken off by hand.
 */
export type DeliveryChargeRowState =
  | { kind: 'on'; text: string; qty: number }
  | { kind: 'other'; text: string; action: string }
  | { kind: 'telling'; text: string }
  | { kind: 'off'; text: string; action: 'Put it back' };

export function deliveryChargeRowState(
  feeCents: number,
  lines: readonly ChargeLine[],
  told: boolean,
): DeliveryChargeRowState {
  const fee = formatCents(feeCents);
  const rightQty = lines.filter((l) => l.unitPriceCents === feeCents).reduce((n, l) => n + l.quantity, 0);
  const others = lines.filter((l) => l.unitPriceCents !== feeCents);
  const otherQty = others.reduce((n, l) => n + l.quantity, 0);
  if (otherQty > 0) {
    if (rightQty > 0) {
      const what =
        otherQty === 1
          ? `a ${formatCents(others[0]?.unitPriceCents ?? 0)} delivery charge`
          : `${otherQty} other delivery charges`;
      return { kind: 'other', text: `The bill has ${what} as well as this area’s ${fee} — check it`, action: `Keep only ${fee}` };
    }
    const what =
      otherQty === 1
        ? `a ${formatCents(others[0]?.unitPriceCents ?? 0)} delivery charge`
        : `${otherQty} delivery charges at other fees (${[...new Set(others.map((l) => formatCents(l.unitPriceCents)))].join(', ')})`;
    return { kind: 'other', text: `The bill has ${what} — this area’s charge is ${fee}`, action: `Change to ${fee}` };
  }
  if (rightQty > 0) return { kind: 'on', text: `${fee} delivery charge is on the bill`, qty: rightQty };
  if (!told) return { kind: 'telling', text: `Delivery to this area is ${fee}` };
  return { kind: 'off', text: `Delivery to this area is ${fee} — not on the bill (taken off by hand)`, action: 'Put it back' };
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
 * The block's stamp from the carried keys' rows (shared-types web-bridge.ts,
 * THE STAMP): the sum of their versions, the newest updated_at, and the sum
 * of their updated_at in ms — so a settled state that differs from a till's
 * is always strictly newer than it, even at the same versions and newest time.
 */
export function settingsStampOf(stamps: ReadonlyArray<SettingStamp | null>): {
  settingsRev: number;
  settingsAt: string;
  settingsTie: number;
} {
  let rev = 0;
  let at = DEFAULT_SETTINGS_AT;
  let tie = 0;
  for (const s of stamps) {
    if (!s) continue;
    rev += s.version;
    const ms = Date.parse(s.updatedAt);
    if (Number.isFinite(ms)) tie += ms;
    if (ms > Date.parse(at)) at = s.updatedAt;
  }
  return { settingsRev: rev, settingsAt: at, settingsTie: tie };
}

/**
 * Does the website need this till's settings block? (shared-types
 * web-bridge.ts, WHEN THE TILL SENDS ONE.) `held` = what the website said it
 * holds, null when it holds no block or has not said.
 *  - nothing saved on either till (rev 0): never;
 *  - no block there, or an older one: yes;
 *  - the same one, but it names a fee item the website's menu lacks (a till
 *    behind on the link published over it): yes — this till's menu goes
 *    with it;
 *  - this till's own block, and a Save here since at a later time (a restore
 *    from an older backup moved this till's versions back): yes — the
 *    website takes a till's later block over its own;
 *  - a newer one from the other till: no — the link brings it here.
 */
export function websiteNeedsSettings(
  local: SettingsStamp,
  held: { stamp: SettingsStamp; deviceId: string | null; problem: string | null } | null,
  deviceId: string,
): boolean {
  if (local.settingsRev === 0) return false;
  if (!held) return true;
  const c = compareSettingsStamp(local, held.stamp);
  if (c > 0) return true;
  if (c === 0) return held.problem !== null;
  return held.deviceId === deviceId && Date.parse(local.settingsAt) > Date.parse(held.stamp.settingsAt);
}

/**
 * The settings block for the menu publish: every area (switched-off ones
 * too) in display order, each ACTIVE one with a fee naming the item of
 * `menuItems` that carries it (its feeItemId when that item is there at
 * the fee, else today's by name and price); the pick-up offer; the stamp
 * (settingsStampOf) and the sending till; and — from a till of v0.7.30 on,
 * always, at their defaults too (shared-types web-bridge.ts, WEBSITE
 * MESSAGES) — the website's messages and delivery minimum. Without
 * `website` the block is exactly a v0.7.29 till's (the website keeps what
 * it stored for them). The caller checks it against the same menu
 * (settingsBlockProblem) before sending.
 */
export function buildSettingsBlock(input: {
  zones: readonly DeliveryZoneSetting[];
  pickup: { offered: boolean; percent: number };
  stamps: ReadonlyArray<SettingStamp | null>;
  menuItems: ReadonlyArray<{ id: string; name: string; basePriceCents: number }>;
  /** The till sending it. */
  deviceId: string;
  /** The website's messages and delivery minimum ('online.options'): absent = a v0.7.29-shaped block. */
  website?: {
    closedNotice: ClosedNotice;
    announcement: WebsiteAnnouncement;
    minDeliveryOrderCents: number;
  };
}): PublishedSettings {
  const stamp = settingsStampOf(input.stamps);
  const website = input.website
    ? {
        closedNotice: { text: input.website.closedNotice.text, until: input.website.closedNotice.until },
        announcement: { on: input.website.announcement.on, text: input.website.announcement.text },
        minDeliveryOrderCents: input.website.minDeliveryOrderCents,
      }
    : {};
  return {
    v: 1,
    settingsAt: stamp.settingsAt,
    settingsRev: stamp.settingsRev,
    settingsTie: stamp.settingsTie,
    deviceId: input.deviceId,
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
    ...website,
  };
}
