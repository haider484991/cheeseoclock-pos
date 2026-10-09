/**
 * Settings → Delivery areas and the website cards (Money & discounts'
 * pick-up, Online orders' "publish by itself"): what is typed ↔ the
 * setting's value, and the words. The main process checks every value
 * again (the key's schema, and settings:saveDeliveryZones' own rules: an
 * area is never removed); this says what is wrong before Save, in the same
 * words — the zone list's own schema (shared-schemas deliveryZonesSchema)
 * runs here too. Every number in the words comes from the values.
 */
import { deliveryZonesSchema } from '@cheeseoclock/shared-schemas';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  DELIVERY_FEE_MAX_CENTS,
  SHOP_SETTING_FORMAT,
  WEBSITE_PICKUP_MAX_PERCENT,
  deliveryChargeItemName,
  newDeliveryZoneId,
  normalizeAreaText,
  type DeliveryZoneInput,
  type DeliveryZoneSetting,
  type DeliveryZones,
  type SettingsPublishStatus,
  type WebsitePickup,
} from '@cheeseoclock/shared-types';
import { centsFromRupeesText } from './foodpandaWords';
import type { Parsed } from './foodpandaForm';

// ---------------------------------------------------------------- areas --

/** One row of the areas table, as typed. */
export interface ZoneRow {
  id: string;
  name: string;
  shortName: string;
  group: string;
  /** Whole rupees, as typed. */
  fee: string;
  active: boolean;
  /** Other spellings, comma separated (they name the area on an address). */
  aliases: string;
  /** Search shortcuts, comma separated ("6", "block 5"). */
  hints: string;
  /** The name it has saved now ('' for a new area): a rename keeps it as a spelling. */
  savedName: string;
  feeItemId: string | null;
}

const list = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function zonesToForm(v: Pick<DeliveryZones, 'zones'>): ZoneRow[] {
  return v.zones.map((z) => ({
    id: z.id,
    name: z.name,
    shortName: z.shortName,
    group: z.group,
    fee: String(z.feeCents / 100),
    active: z.active,
    aliases: z.aliases.join(', '),
    hints: z.hints.join(', '),
    savedName: z.name,
    feeItemId: z.feeItemId,
  }));
}

/**
 * The list Save sends (settings:saveDeliveryZones picks each fee item). A
 * renamed area keeps its old name as a spelling, so saved addresses and
 * old orders still resolve to it.
 */
export function zonesFromForm(rows: readonly ZoneRow[]): Parsed<DeliveryZoneInput[]> {
  const zones: DeliveryZoneSetting[] = [];
  for (const r of rows) {
    const label = r.name.trim() || 'An area';
    const cents = centsFromRupeesText(r.fee);
    if (cents === null || Number.isNaN(cents) || cents > DELIVERY_FEE_MAX_CENTS) {
      return {
        value: null,
        problem: `${label}: the fee is whole rupees, Rs 0 to ${formatCents(DELIVERY_FEE_MAX_CENTS, { showSymbol: false })}.`,
      };
    }
    const aliases = list(r.aliases);
    const name = r.name.trim();
    if (r.savedName && name && name !== r.savedName) {
      const known = new Set(aliases.map(normalizeAreaText));
      if (
        !known.has(normalizeAreaText(r.savedName)) &&
        normalizeAreaText(r.savedName) !== normalizeAreaText(name)
      ) {
        aliases.push(r.savedName);
      }
    }
    zones.push({
      id: r.id,
      name,
      shortName: r.shortName.trim(),
      group: r.group.trim(),
      feeCents: cents,
      feeItemId: cents === 0 ? null : r.feeItemId,
      active: r.active,
      aliases,
      hints: list(r.hints),
    });
  }
  const check = deliveryZonesSchema.safeParse({ v: SHOP_SETTING_FORMAT['delivery.zones'], zones });
  if (!check.success)
    return { value: null, problem: check.error.issues[0]?.message ?? 'Check the areas.' };
  return { value: zones, problem: null };
}

/** A new row for "Add an area": its id made once from its name, never changed after. */
export function newZoneRow(
  rows: readonly ZoneRow[],
  input: { name: string; shortName: string; group: string; fee: string; aliases: string },
): ZoneRow {
  const taken = new Set(rows.map((r) => r.id));
  return {
    id: newDeliveryZoneId(input.name, taken),
    name: input.name.trim(),
    shortName: input.shortName.trim() || input.name.trim().slice(0, 20),
    group: input.group.trim(),
    fee: input.fee.trim(),
    active: true,
    aliases: input.aliases,
    hints: '',
    savedName: '',
    feeItemId: null,
  };
}

/** Move a row up or down within the list (the order the till and the website show). */
export function moveZoneRow(rows: readonly ZoneRow[], id: string, by: -1 | 1): ZoneRow[] {
  const i = rows.findIndex((r) => r.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= rows.length) return [...rows];
  const next = [...rows];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** "Change the fee for several areas": the ticked rows at the one fee. */
export function setFeeFor(
  rows: readonly ZoneRow[],
  ids: ReadonlySet<string>,
  fee: string,
): ZoneRow[] {
  return rows.map((r) => (ids.has(r.id) ? { ...r, fee: fee.trim() } : r));
}

/** One line for History: "21 areas, 20 on · Rs 200 (15), Rs 250 (5)". */
export function zonesSummary(v: Pick<DeliveryZones, 'zones'>): string {
  const on = v.zones.filter((z) => z.active);
  const byFee = new Map<number, number>();
  for (const z of on) byFee.set(z.feeCents, (byFee.get(z.feeCents) ?? 0) + 1);
  const fees = [...byFee.entries()]
    .sort(([a], [b]) => a - b)
    .map(([c, n]) => `${c === 0 ? 'free' : formatCents(c)} (${n})`)
    .join(', ');
  return `${v.zones.length} areas, ${on.length} on · ${fees || 'no delivery'}`;
}

/** The worked example under the card, from the areas as typed. */
export function zonesExample(
  zones: readonly Pick<DeliveryZoneSetting, 'name' | 'feeCents' | 'active'>[],
): string {
  const z = zones.find((x) => x.active && x.feeCents > 0);
  if (!z) return 'No area charges a delivery fee: a delivery order carries no delivery charge.';
  return `Picking ${z.name} on a delivery order puts “${deliveryChargeItemName(z.feeCents)}” on the bill by itself, and the website charges the same ${formatCents(z.feeCents)}. A discount comes off it only when Money & discounts → “A discount also comes off the delivery charge” is Yes.`;
}

export const ZONES_SAVE_NOTE =
  'Save also makes the “Delivery Charge (Rs …)” items the fees need (they are not listed in Menu: this card and “Tax on the delivery charge” look after them) and sends the website the areas and those charge items only. Menu changes you have not published stay on the till until you press Publish. An area is switched off, never removed: its website page stays and says delivery is paused.';

/** The message after the areas are saved. */
export const ZONES_SAVED_TOAST =
  'On both tills once they are linked. The website gets the areas and their charge items by itself — not the rest of the menu.';

/** Money & discounts → Website pick-up: the card's introduction. */
export const PICKUP_INTRO =
  'Whether website customers may collect their order from the counter, the % off website orders, and whether delivery orders get it too. It reaches the website by itself when saved (the menu is not sent with it); pick-up still needs the shop to be taking orders. The % is never taken off value deals or a delivery charge.';

// --------------------------------------------------------------- pick-up --

export interface PickupForm {
  offered: boolean;
  percent: string;
  /** v0.7.37: the % also comes off a website delivery's food. */
  alsoDelivery: boolean;
}

export function pickupToForm(p: WebsitePickup): PickupForm {
  return { offered: p.offered, percent: String(p.percent), alsoDelivery: p.alsoDelivery };
}

export function pickupFromForm(f: PickupForm): Parsed<WebsitePickup> {
  const t = f.percent.trim();
  if (!/^\d{1,3}$/.test(t) || Number(t) > WEBSITE_PICKUP_MAX_PERCENT) {
    return {
      value: null,
      problem: `The website discount is a whole % from 0 to ${WEBSITE_PICKUP_MAX_PERCENT}.`,
    };
  }
  return {
    value: {
      v: SHOP_SETTING_FORMAT['discounts.websitePickup'],
      offered: f.offered,
      percent: Number(t),
      alsoDelivery: f.alsoDelivery,
    },
    problem: null,
  };
}

export function pickupSummary(p: WebsitePickup): string {
  const delivery = p.alsoDelivery && p.percent > 0 ? `; delivery orders ${p.percent}% off the food` : '';
  if (!p.offered) return `Pick-up not offered on the website${delivery}`;
  return (p.percent > 0 ? `Pick-up offered, ${p.percent}% off` : 'Pick-up offered, no discount') + delivery;
}

/** Rs 2,000 of food: the example's order. */
export const PICKUP_EXAMPLE_CENTS = 200_000;

export function pickupExample(p: Pick<WebsitePickup, 'offered' | 'percent'> & { alsoDelivery?: boolean }): string {
  const off = Math.round((PICKUP_EXAMPLE_CENTS * p.percent) / 100);
  const delivery =
    p.alsoDelivery === true && p.percent > 0
      ? ` A ${formatCents(PICKUP_EXAMPLE_CENTS)} delivery order gets the same ${formatCents(off)} off its food; the delivery charge stays full.`
      : '';
  if (!p.offered) return `Customers can only order delivery on the website.${delivery}`;
  if (p.percent === 0)
    return `A ${formatCents(PICKUP_EXAMPLE_CENTS)} pick-up order pays ${formatCents(PICKUP_EXAMPLE_CENTS)} (no discount).`;
  return `A ${formatCents(PICKUP_EXAMPLE_CENTS)} pick-up order gets ${p.percent}% off: ${formatCents(off)} off, ${formatCents(PICKUP_EXAMPLE_CENTS - off)} before tax.${delivery} The till bills exactly what the website showed.`;
}

export const PICKUP_PRINTED_MENU_NOTE =
  'The printed menu shows the pick-up discount too: reprint it when you change the %.';

/** What the settings block carries, in the owner's words. */
const SETTINGS_WORDS = 'Delivery areas, pick-up & website messages';

/** "27 Sep, 14:02" */
function at(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

/**
 * Where the website settings — the delivery areas, the pick-up offer and
 * the website messages (the settings block) — stand with the website (the
 * bridge's settingsPublish): "Website updated 27 Sep, 14:02", "Waiting to
 * reach the website", "Website not updated: …". Null when there is nothing
 * to say (nothing saved yet).
 */
export function settingsPublishWords(
  s: SettingsPublishStatus | undefined,
  what: string = SETTINGS_WORDS,
): { tone: 'ok' | 'wait' | 'bad'; text: string } | null {
  if (!s || s.state === 'none') return null;
  if (s.state === 'published')
    return {
      tone: 'ok',
      text: `${what}: website updated${s.at ? ` ${at(s.at)}` : ''}.`,
    };
  if (s.state === 'waiting')
    return {
      tone: 'wait',
      text: `${what}: waiting to reach the website.${s.message ? ` ${s.message}` : ''}`,
    };
  return {
    tone: 'bad',
    text: `${what}: website not updated: ${s.message ?? 'no reason given'}`,
  };
}

/** The shop block's line in Settings → Online orders (THE SHOP BLOCK): the same words as the settings block's. */
export const SHOP_DETAILS_WORDS = 'Shop details, hours & home page';
