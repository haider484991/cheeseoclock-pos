/**
 * The delivery-charge menu items are Settings → Delivery areas' (step 3):
 * each area names its item (feeItemId), the website checks the area's fee
 * against that item's price, and Save makes, re-prices and switches them.
 * So Menu can't change what makes one a fee — its name and price — and no
 * other item may take a delivery-charge name. An item an area that is ON
 * charges (shared-types chargedFeeItemIds) is locked outright: on/off, the
 * category and deleting too, and its category can't be hidden. A charge
 * item no area that is on uses (an old "Delivery Charge (Rs 150)", today's
 * Rs 250 after every Rs 250 area moved) may be hidden or deleted like any
 * item. Checked in the main process (menu handlers), whoever asks; the
 * words work for a manager, who can't open Settings.
 *
 * Read-only and free of Electron.
 */
import {
  FEE_ITEM_LOCKED_NOTE,
  chargedFeeItemIds,
  isDeliveryChargeMenuItem,
  isDeliveryChargeName,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { readDeliveryFeeItemIds, readDeliveryZones } from '../db/business-settings-read.js';

/** Menu's refusal, and the note on a fee item in Menu. */
export const FEE_ITEM_LOCKED = FEE_ITEM_LOCKED_NOTE;

interface ItemNow {
  id: string;
  name: string;
  category_id: string;
  base_price_cents: number;
  is_active: number;
}

function itemNow(db: AppDatabase, id: string): ItemNow | undefined {
  return db
    .prepare(
      `SELECT id, name, category_id, base_price_cents, is_active FROM menu_items WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as ItemNow | undefined;
}

/** Is this menu item a delivery charge (an area's fee item, or named like one)? */
export function isFeeItem(db: AppDatabase, id: string): boolean {
  const it = itemNow(db, id);
  return !!it && isDeliveryChargeMenuItem(it, readDeliveryFeeItemIds(db));
}

/** The items the areas that are on charge their fees with (chargedFeeItemIds): locked outright in Menu. */
function chargedIds(db: AppDatabase): Set<string> {
  const items = (
    db.prepare(`SELECT id, name, base_price_cents, is_active FROM menu_items WHERE deleted_at IS NULL`).all() as Array<{
      id: string;
      name: string;
      base_price_cents: number;
      is_active: number;
    }>
  ).map((i) => ({ id: i.id, name: i.name, basePriceCents: i.base_price_cents, isActive: i.is_active === 1 }));
  return chargedFeeItemIds(readDeliveryZones(db), items);
}

/** Why Menu can't make this change to an item, or null. A field sent unchanged is fine (the item dialog sends them all). */
export function menuItemEditProblem(
  db: AppDatabase,
  id: string,
  patch: { name?: string; basePriceCents?: number; isActive?: boolean; categoryId?: string },
): string | null {
  const it = itemNow(db, id);
  if (!it) return null;
  if (!isDeliveryChargeMenuItem(it, readDeliveryFeeItemIds(db))) {
    return patch.name !== undefined && patch.name !== it.name && isDeliveryChargeName(patch.name)
      ? FEE_NAME_TAKEN
      : null;
  }
  // Its name and price make it a charge (the area's fee, the website's check): Settings' alone.
  const feeChanges =
    (patch.name !== undefined && patch.name !== it.name) ||
    (patch.basePriceCents !== undefined && patch.basePriceCents !== it.base_price_cents);
  if (feeChanges) return FEE_ITEM_LOCKED;
  // On/off and the category: locked only while an area that is on charges it.
  const placeChanges =
    (patch.isActive !== undefined && patch.isActive !== (it.is_active === 1)) ||
    (patch.categoryId !== undefined && patch.categoryId !== it.category_id);
  return placeChanges && chargedIds(db).has(it.id) ? FEE_ITEM_LOCKED : null;
}

/** Why Menu can't delete this item (an area that is on charges it), or null. */
export function menuItemDeleteProblem(db: AppDatabase, id: string): string | null {
  return isFeeItem(db, id) && chargedIds(db).has(id) ? FEE_ITEM_LOCKED : null;
}

/** A new item may not take a delivery-charge name: Save makes those. */
export const FEE_NAME_TAKEN =
  'Delivery charges are made in Settings → Delivery areas (ask the owner) — give this item another name.';
export function menuItemNameProblem(name: string | undefined): string | null {
  return name !== undefined && isDeliveryChargeName(name) ? FEE_NAME_TAKEN : null;
}

/** Why Menu can't hide or delete this category (it holds an item that is on and an area that is on charges), or null. */
export function categoryEditProblem(
  db: AppDatabase,
  id: string,
  patch: { isActive?: boolean; delete?: boolean },
): string | null {
  if (patch.isActive !== false && !patch.delete) return null;
  const charged = chargedIds(db);
  const items = db
    .prepare(`SELECT id, is_active FROM menu_items WHERE category_id = ? AND deleted_at IS NULL`)
    .all(id) as Array<{ id: string; is_active: number }>;
  return items.some((i) => i.is_active === 1 && charged.has(i.id))
    ? `This category holds the delivery charges the website needs. ${FEE_ITEM_LOCKED}`
    : null;
}
