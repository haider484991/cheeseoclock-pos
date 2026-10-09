import type { AppDatabase } from '../connection.js';
import type { Actor } from './base.js';
import { createTaxCategory, updateTaxCategory } from './tax-category-repo.js';
import { updateMenuItem } from './menu-item-repo.js';
import { saveDeliveryZones } from './delivery-zones-repo.js';
import { readDeliveryFeeItemIds, readShopSetting } from '../business-settings-read.js';
import {
  DELIVERY_CHARGE_TAX_NAME,
  isDeliveryChargeMenuItem,
  type DeliveryChargeTaxCategory,
  type DeliveryChargeTaxChoice,
  type DeliveryChargeTaxItem,
  type DeliveryChargeTaxSaved,
  type DeliveryChargeTaxView,
} from '@cheeseoclock/shared-types';
import { deliveryChargeTaxNow } from '@cheeseoclock/pos-domain';

/**
 * Settings → Delivery areas & fees → "Tax on the delivery charge"
 * (settings:deliveryChargeTax / settings:saveDeliveryChargeTax, the owner
 * only; shared-types delivery-charge-tax.ts). The charges' tax IS their
 * items' tax category, so the card reads it from the "Delivery Charge
 * (Rs N)" items and its Save moves every one of them (switched-off ones
 * too) onto one tax, in ONE transaction, through the repositories (synced
 * and audited):
 *
 *  1. the tax: the food's (the one most of the other items are on), or
 *     "Delivery charge tax" — made, or set to the chosen rates — for no tax
 *     (0%) and for a rate of its own. A "Delivery charge tax" that food
 *     items are on too is never re-rated (that would change the food's tax);
 *  2. each charge item not on it yet, moved (updateMenuItem);
 *  3. when that changed anything and the areas were saved on this till, the
 *     areas' own Save again, as they are (saveDeliveryZones): the website
 *     gets the charge items with their new tax the way it gets them after
 *     any Save of the areas — the block alone, with only those items, never
 *     the till's unpublished menu changes. The areas' card shows it as its
 *     latest Save. Areas never saved here: the next menu Publish takes it.
 *
 * Orders already open keep the tax their lines were sold at (order_items'
 * snapshot); the next charge put on a bill takes the new one.
 */

interface ItemRow {
  id: string;
  name: string;
  base_price_cents: number;
  is_active: number;
  tax_category_id: string;
}

interface TaxRow {
  id: string;
  name: string;
  rate_bps: number;
  digital_rate_bps: number | null;
  created_at: string;
  deleted_at: string | null;
}

/** Why there is nothing to tax the charges with. */
export const NO_TAX_CATEGORY = 'Add a tax in Menu → Tax first: the delivery charges need one.';

function liveItems(db: AppDatabase): { charges: ItemRow[]; food: ItemRow[] } {
  const feeIds = readDeliveryFeeItemIds(db);
  const rows = db
    .prepare(
      `SELECT id, name, base_price_cents, is_active, tax_category_id FROM menu_items WHERE deleted_at IS NULL`,
    )
    .all() as ItemRow[];
  const charges: ItemRow[] = [];
  const food: ItemRow[] = [];
  for (const r of rows) (isDeliveryChargeMenuItem(r, feeIds) ? charges : food).push(r);
  return { charges, food };
}

/** Every tax row by id — a deleted one too, so a charge still on it shows what it charges. */
function taxRows(db: AppDatabase): Map<string, TaxRow> {
  const rows = db
    .prepare(`SELECT id, name, rate_bps, digital_rate_bps, created_at, deleted_at FROM tax_categories`)
    .all() as TaxRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

const isOurName = (name: string) => name.trim().toLowerCase() === DELIVERY_CHARGE_TAX_NAME.toLowerCase();

/**
 * The food's tax: the one most of the other items are on (a tax nothing is
 * on yet only when the menu has no food), never "Delivery charge tax" while
 * another will do; the older tax on a tie.
 */
function foodTax(food: readonly ItemRow[], taxes: ReadonlyMap<string, TaxRow>): TaxRow | null {
  const uses = new Map<string, number>();
  for (const i of food) uses.set(i.tax_category_id, (uses.get(i.tax_category_id) ?? 0) + 1);
  const live = [...taxes.values()].filter((t) => t.deleted_at === null);
  live.sort(
    (a, b) =>
      (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) ||
      Number(isOurName(a.name)) - Number(isOurName(b.name)) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
  return live[0] ?? null;
}

function categoryOf(t: TaxRow): DeliveryChargeTaxCategory {
  return { id: t.id, name: t.name, rateBps: t.rate_bps, digitalRateBps: t.digital_rate_bps };
}

/** What the card shows: the charges, each with its tax now, the food's tax, and how the website gets a change. */
export function readDeliveryChargeTax(db: AppDatabase): DeliveryChargeTaxView {
  const { charges, food } = liveItems(db);
  const taxes = taxRows(db);
  const foodT = foodTax(food, taxes);
  const items: DeliveryChargeTaxItem[] = charges
    .map((c) => {
      const t = taxes.get(c.tax_category_id);
      return {
        itemId: c.id,
        name: c.name,
        feeCents: c.base_price_cents,
        isActive: c.is_active === 1,
        tax: t ? categoryOf(t) : { id: c.tax_category_id, name: 'Unknown tax', rateBps: 0, digitalRateBps: null },
      };
    })
    .sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) || a.feeCents - b.feeCents || a.name.localeCompare(b.name) || a.itemId.localeCompare(b.itemId),
    );
  const zones = readShopSetting(db, 'delivery.zones');
  return {
    now: deliveryChargeTaxNow(items, foodT?.id ?? null),
    charges: items,
    food: foodT ? categoryOf(foodT) : null,
    website: zones.isDefault || zones.newerFormat ? 'publish' : 'itself',
  };
}

/**
 * "Delivery charge tax" at these rates, for no tax and a rate of its own:
 * the one no food item is on, re-rated if need be; else one food is on too
 * that already charges these rates, as it is; else a new one. Refused when
 * the only ones are on food at other rates (re-rating them would change the
 * food's tax). `changed`: made or re-rated.
 */
function chargeTaxCategory(
  db: AppDatabase,
  rates: { rateBps: number; digitalRateBps: number | null },
  food: readonly ItemRow[],
  taxes: ReadonlyMap<string, TaxRow>,
  actor: Actor,
): { id: string; changed: boolean } {
  const onFood = new Set(food.map((i) => i.tax_category_id));
  const ours = [...taxes.values()]
    .filter((t) => t.deleted_at === null && isOurName(t.name))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const wantCard = rates.digitalRateBps ?? rates.rateBps;
  const charges = (t: TaxRow) => t.rate_bps === rates.rateBps && (t.digital_rate_bps ?? t.rate_bps) === wantCard;
  const free = ours.find((t) => !onFood.has(t.id));
  if (free) {
    if (charges(free)) return { id: free.id, changed: false };
    updateTaxCategory(db, { id: free.id, rateBps: rates.rateBps, digitalRateBps: rates.digitalRateBps }, actor);
    return { id: free.id, changed: true };
  }
  const asItIs = ours.find(charges);
  if (asItIs) return { id: asItIs.id, changed: false };
  const taken = ours[0];
  if (taken) {
    throw new Error(
      `Menu items other than the delivery charges are on the tax “${taken.name}” — put them on another tax in Menu first, or pick “The same as the food”.`,
    );
  }
  const made = createTaxCategory(
    db,
    { name: DELIVERY_CHARGE_TAX_NAME, rateBps: rates.rateBps, digitalRateBps: rates.digitalRateBps },
    actor,
  );
  return { id: made.id, changed: true };
}

/** Each charge item not on this tax yet, moved onto it. How many moved. */
function moveCharges(db: AppDatabase, charges: readonly ItemRow[], taxId: string, actor: Actor): number {
  let moved = 0;
  for (const c of charges) {
    if (c.tax_category_id === taxId) continue;
    updateMenuItem(db, { id: c.id, taxCategoryId: taxId }, actor);
    moved += 1;
  }
  return moved;
}

/**
 * The Save: every delivery charge item onto the chosen tax, in one
 * transaction (see the top of this file). No charge item at all: nothing to
 * do (the card asks for an area's fee first).
 */
export function saveDeliveryChargeTax(
  db: AppDatabase,
  choice: DeliveryChargeTaxChoice,
  actor: Actor,
): DeliveryChargeTaxSaved {
  let itemsChanged = 0;
  let changed = false;
  let sentToWebsite = false;
  const tx = db.transaction(() => {
    const { charges, food } = liveItems(db);
    if (charges.length === 0) return;
    const taxes = taxRows(db);
    let taxId: string;
    if (choice.kind === 'food') {
      const t = foodTax(food, taxes);
      if (!t) throw new Error(NO_TAX_CATEGORY);
      taxId = t.id;
    } else {
      const rates =
        choice.kind === 'none'
          ? { rateBps: 0, digitalRateBps: null }
          : { rateBps: choice.rateBps, digitalRateBps: choice.digitalRateBps };
      const ours = chargeTaxCategory(db, rates, food, taxes, actor);
      taxId = ours.id;
      changed = ours.changed;
    }
    itemsChanged = moveCharges(db, charges, taxId, actor);
    changed ||= itemsChanged > 0;
    if (!changed) return;
    const zones = readShopSetting(db, 'delivery.zones');
    if (zones.isDefault || zones.newerFormat) return;
    // The website: the areas' own Save again, as they are — their charge items go with them.
    saveDeliveryZones(db, { zones: zones.value.zones }, actor);
    // A charge item that Save made (an area's fee whose item had gone) takes the tax too.
    itemsChanged += moveCharges(db, liveItems(db).charges, taxId, actor);
    sentToWebsite = true;
  });
  tx();
  return { view: readDeliveryChargeTax(db), itemsChanged, changed, sentToWebsite };
}
