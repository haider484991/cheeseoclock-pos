import { v5 as uuidv5 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import type { Actor } from './base.js';
import { setBusinessSettings, NEWER_FORMAT_REFUSAL } from './business-settings-repo.js';
import { createCategory, updateCategory } from './category-repo.js';
import { createMenuItem, restoreMenuItem, updateMenuItem } from './menu-item-repo.js';
import { readShopSetting } from '../business-settings-read.js';
import { listAreaUsage } from './customer-repo.js';
import { BUSINESS_SETTING_SCHEMAS } from '@cheeseoclock/shared-schemas';
import {
  COC_ID_NAMESPACE,
  DEFAULT_DELIVERY_ZONES,
  DELIVERY_CHARGES_CATEGORY_ID_SEED,
  DELIVERY_CHARGES_CATEGORY_NAME,
  deliveryChargeItemIdSeed,
  deliveryChargeItemName,
  deliveryZoneFeeItemIds,
  isDeliveryChargeName,
  type DeliveryZoneInput,
  type DeliveryZoneSetting,
  type PrepStation,
} from '@cheeseoclock/shared-types';
import {
  deliveryZonesPutBack,
  planFeeItems,
  type FeeItemCandidate,
} from '@cheeseoclock/pos-domain';

/**
 * Settings → Delivery areas' Save (settings:saveDeliveryZones, the owner
 * only): the areas and fees ('delivery.zones') AND the menu items that
 * carry the fees, in ONE transaction, through the repositories (every row
 * synced and audited):
 *
 *  1. the "Delivery Charges" category — the adopted items' own, else the one
 *     of that name, else made with a name-based id — switched on;
 *  2. one "Delivery Charge (Rs N)" item per fee an area that is on charges
 *     (pos-domain planFeeItems): the fee's name-based id (uuid v5 of
 *     "delivery-charge:<paisa>" — two tills saving offline make the SAME
 *     row, which the link settles by last write), today's Rs 200 and Rs 250
 *     items adopted on the first Save (id kept, renamed to the fee's name),
 *     a deleted one brought back; each on, at exactly its fee, under that
 *     name, with the adopted items' tax and kitchen station;
 *  3. an item the saved list pointed at that no area charges now switched
 *     off — never deleted (orders and web orders already placed carry it);
 *  4. the setting LAST, each area naming its item (feeItemId): the sync
 *     queue sends the items before the setting that points at them.
 *
 * An area is never removed (its id is on saved addresses, in Reports and on
 * the website's pages): the list must keep every id it had. A value saved
 * by a newer version of the app is never saved over.
 */

/** The menu item that carries a fee: the same id on every till. */
export function deliveryChargeItemId(feeCents: number): string {
  return uuidv5(deliveryChargeItemIdSeed(feeCents), COC_ID_NAMESPACE);
}

/** The "Delivery Charges" category when the shop has none: the same id on every till. */
export function deliveryChargesCategoryId(): string {
  return uuidv5(DELIVERY_CHARGES_CATEGORY_ID_SEED, COC_ID_NAMESPACE);
}

/** Why the new list can't replace the saved one (the rules the schema can't see), or null. */
/**
 * An area that saved addresses still name (by its name or a spelling) is never
 * removed, only switched off; one no address uses may go. `usedAreas` is the
 * lower-cased area names on customer addresses (usedAreaNames).
 */
export function zonesSaveProblem(
  saved: ReadonlyArray<Pick<DeliveryZoneSetting, 'id' | 'name' | 'aliases'>>,
  next: ReadonlyArray<Pick<DeliveryZoneSetting, 'id'>>,
  usedAreas: ReadonlySet<string> = new Set(),
): string | null {
  const ids = new Set(next.map((z) => z.id));
  const gone = saved.find((z) => !ids.has(z.id) && zoneIsUsed(z, usedAreas));
  return gone
    ? `${gone.name} can’t be removed: addresses still use it — switch it off instead (old orders, Reports and the website’s page keep it)`
    : null;
}

function zoneIsUsed(zone: Pick<DeliveryZoneSetting, 'name' | 'aliases'>, usedAreas: ReadonlySet<string>): boolean {
  if (usedAreas.size === 0) return false;
  return [zone.name, ...zone.aliases].some((n) => usedAreas.has(n.trim().toLowerCase()));
}

/** The area names on this till's saved customer addresses, lower-cased. */
export function usedAreaNames(db: AppDatabase): Set<string> {
  return new Set(listAreaUsage(db, 100_000).map((a) => a.area.trim().toLowerCase()));
}

interface ItemRow {
  id: string;
  name: string;
  base_price_cents: number;
  is_active: number;
  deleted_at: string | null;
  created_at: string;
  category_id: string;
  tax_category_id: string;
  prep_station: PrepStation;
  sort_order: number;
}

export function saveDeliveryZones(
  db: AppDatabase,
  request: { zones: DeliveryZoneInput[] } | { useDefault: true },
  actor: Actor,
): DeliveryZoneSetting[] {
  let saved!: DeliveryZoneSetting[];
  const tx = db.transaction(() => {
    const current = readShopSetting(db, 'delivery.zones');
    if (current.newerFormat) throw new Error(NEWER_FORMAT_REFUSAL);
    const input =
      'useDefault' in request ? deliveryZonesPutBack(current.value.zones) : request.zones;

    // Never an area removed: the saved list's ids all stay (switched off is how an area goes).
    // Nothing saved yet = nothing to protect: first-time setup may save an
    // empty list or the preset. Afterwards, an area addresses use stays.
    const removed = current.isDefault ? null : zonesSaveProblem(current.value.zones, input, usedAreaNames(db));
    if (removed) throw new Error(removed);

    const previousFeeItemIds = current.isDefault
      ? new Set<string>()
      : deliveryZoneFeeItemIds(current.value.zones);
    // The fees the list charges now (for the default, today's Rs 200 and Rs 250, charged by
    // name and price): an item at one of them that no area charges after this Save goes off.
    const previousFees = new Set(
      current.value.zones.filter((z) => z.feeCents > 0).map((z) => z.feeCents),
    );
    const fees = new Set(input.filter((z) => z.feeCents > 0).map((z) => z.feeCents));
    const ownIds = new Set([...fees].map(deliveryChargeItemId));
    const rows = (
      db
        .prepare(
          `SELECT id, name, base_price_cents, is_active, deleted_at, created_at, category_id, tax_category_id,
                  prep_station, sort_order
             FROM menu_items`,
        )
        .all() as ItemRow[]
    ).filter(
      (r) =>
        previousFeeItemIds.has(r.id) ||
        ownIds.has(r.id) ||
        (r.deleted_at === null && isDeliveryChargeName(r.name)),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const candidates: FeeItemCandidate[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      basePriceCents: r.base_price_cents,
      isActive: r.is_active === 1,
      deleted: r.deleted_at !== null,
      createdAt: r.created_at,
    }));
    const plan = planFeeItems({
      zones: input,
      previousFeeItemIds,
      previousFees,
      items: candidates,
      idForFee: deliveryChargeItemId,
    });

    // The whole list checked before anything is written (the setting's own rules: fees, spellings, groups).
    const value = { v: DEFAULT_DELIVERY_ZONES.v, zones: plan.zones };
    const check = BUSINESS_SETTING_SCHEMAS['delivery.zones'].safeParse(value);
    if (!check.success)
      throw new Error(check.error.issues[0]?.message ?? 'Those delivery areas can’t be saved');

    // A new fee item copies an item the areas charge with — the one kept, else one this Save
    // switches off (every fee raised at once), else today's by name: its tax (a delivery charge
    // may be taxed apart from the food), kitchen station and category. The food's tax only when
    // the shop has no fee item at all.
    const kept = plan.actions.filter((a) => a.kind === 'keep').map((a) => byId.get(a.id)!);
    const switchedOff = plan.actions.filter((a) => a.kind === 'switchOff').map((a) => byId.get(a.id)!);
    const live = (r: ItemRow | undefined): r is ItemRow => !!r && r.deleted_at === null;
    const template =
      kept.find(live) ??
      switchedOff.find(live) ??
      rows.find((r) => live(r) && previousFeeItemIds.has(r.id)) ??
      rows
        .filter((r) => live(r) && isDeliveryChargeName(r.name))
        .sort((a, b) => b.is_active - a.is_active || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0] ??
      null;
    let feeCategory: string | null = null;
    const categoryForNew = (): string => {
      feeCategory ??= ensureFeeCategory(db, template?.category_id ?? null, actor);
      return feeCategory;
    };
    let nextSort = Math.max(
      0,
      ...rows.filter((r) => r.deleted_at === null).map((r) => r.sort_order + 1),
    );

    for (const a of plan.actions) {
      if (a.kind === 'switchOff') {
        updateMenuItem(db, { id: a.id, isActive: false }, actor);
        continue;
      }
      if (a.kind === 'create') {
        const tax = template?.tax_category_id ?? mostUsedTaxCategory(db);
        if (!tax)
          throw new Error(
            'Add a tax category in Menu → Tax first: the delivery charge items need one',
          );
        createMenuItem(
          db,
          {
            id: a.id,
            categoryId: categoryForNew(),
            name: a.name,
            description: FEE_ITEM_DESCRIPTION,
            basePriceCents: a.feeCents,
            prepStation: template?.prep_station ?? 'kitchen',
            taxCategoryId: tax,
            sortOrder: nextSort++,
          },
          actor,
        );
        continue;
      }
      if (a.kind === 'restore') {
        restoreMenuItem(db, a.id, actor);
        updateMenuItem(
          db,
          {
            id: a.id,
            name: a.name,
            basePriceCents: a.feeCents,
            isActive: true,
            categoryId: categoryForNew(),
          },
          actor,
        );
        continue;
      }
      // keep: on, at exactly its fee, under the fee's name, in a category that is on. WRITTEN even
      // when nothing changes: this Save's word that the item is on must reach the other till with
      // the setting that points at it. Two Saves offline — till A moves every Rs 250 area on (the
      // Rs 250 item switched off), till B keeps one at Rs 250 — are settled row by row by (version,
      // time): the item row and the setting then both go to the later Save, so an area never ends
      // up pointing at an item the other Save switched off.
      const r = byId.get(a.id)!;
      const patch: Parameters<typeof updateMenuItem>[1] = { id: a.id, isActive: true };
      if (r.name !== a.name) patch.name = a.name;
      if (r.base_price_cents !== a.feeCents) patch.basePriceCents = a.feeCents;
      if (a.adopted) patch.description = FEE_ITEM_DESCRIPTION;
      // Its category deleted (an older till): it moves to the fee category, or the website never sees it.
      const home = db.prepare(`SELECT 1 AS x FROM categories WHERE id = ? AND deleted_at IS NULL`).get(r.category_id);
      if (!home) patch.categoryId = categoryForNew();
      updateMenuItem(db, patch, actor);
      if (home) ensureCategoryOn(db, r.category_id, actor);
    }

    // Last: the setting, each area naming its item (the sync queue sends the items first).
    setBusinessSettings(db, [{ key: 'delivery.zones', value }], actor);
    saved = plan.zones;
  });
  tx();
  return saved;
}

/**
 * A website order's delivery charge line whose item has not reached this till
 * yet: the owner saved a new fee on the OTHER till, which made its item
 * (with the fee's name-based id) and published, and the website charged it
 * before the till link brought the item here. The item is made here with
 * that same id — the same row the link then settles — exactly as a Save
 * makes it, so the order imports with its charge instead of failing until it
 * is cancelled. Only a Save's own item (the line's id IS the fee's
 * name-based id, and it is named like a charge) is ever made this way;
 * anything else is left to the import's "not on the menu" path. Returns the
 * item id, or null. Runs inside the caller's transaction; synced and audited.
 */
export function deliveryChargeItemForWebOrder(
  db: AppDatabase,
  line: { posItemId: string; name: string; unitPriceCents: number },
  actor: Actor,
): string | null {
  const fee = line.unitPriceCents;
  if (!(fee > 0) || fee % 100 !== 0 || !isDeliveryChargeName(line.name)) return null;
  const id = deliveryChargeItemId(fee);
  if (line.posItemId !== id) {
    // A charge item Menu deleted (no area that is on charged it) while the website still held an
    // older block that charged it: back, switched off — the order keeps the fee the customer saw,
    // and a cashier still can't ring it up.
    const gone = db
      .prepare(`SELECT id, name, base_price_cents, deleted_at FROM menu_items WHERE id = ?`)
      .get(line.posItemId) as { id: string; name: string; base_price_cents: number; deleted_at: string | null } | undefined;
    if (!gone || gone.deleted_at === null || !isDeliveryChargeName(gone.name) || gone.base_price_cents !== fee) return null;
    restoreMenuItem(db, gone.id, actor);
    updateMenuItem(db, { id: gone.id, isActive: false }, actor);
    return gone.id;
  }
  const row = db.prepare(`SELECT id, deleted_at FROM menu_items WHERE id = ?`).get(id) as
    | { id: string; deleted_at: string | null }
    | undefined;
  if (row && row.deleted_at === null) return id;
  const fromHere = (
    db
      .prepare(
        `SELECT id, name, base_price_cents, is_active, deleted_at, created_at, category_id, tax_category_id,
                prep_station, sort_order
           FROM menu_items WHERE deleted_at IS NULL`,
      )
      .all() as ItemRow[]
  ).filter((r) => isDeliveryChargeName(r.name));
  const template =
    [...fromHere].sort(
      (a, b) => b.is_active - a.is_active || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    )[0] ?? null;
  const categoryId = ensureFeeCategory(db, template?.category_id ?? null, actor);
  if (row) {
    restoreMenuItem(db, id, actor);
    updateMenuItem(
      db,
      { id, name: deliveryChargeItemName(fee), basePriceCents: fee, isActive: true, categoryId },
      actor,
    );
    return id;
  }
  const tax = template?.tax_category_id ?? mostUsedTaxCategory(db);
  if (!tax) return null;
  createMenuItem(
    db,
    {
      id,
      categoryId,
      name: deliveryChargeItemName(fee),
      description: FEE_ITEM_DESCRIPTION,
      basePriceCents: fee,
      prepStation: template?.prep_station ?? 'kitchen',
      taxCategoryId: tax,
      sortOrder: Math.max(0, ...fromHere.map((r) => r.sort_order + 1)),
    },
    actor,
  );
  return id;
}

/** What Menu shows under a fee item. */
const FEE_ITEM_DESCRIPTION =
  'Delivery charge — the areas and fees are set in Settings → Delivery areas.';

/** The category new fee items go in: the adopted items' own, else "Delivery Charges", else one made with a name-based id. */
function ensureFeeCategory(db: AppDatabase, preferred: string | null, actor: Actor): string {
  const live = (id: string) =>
    db
      .prepare(`SELECT id, is_active FROM categories WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as { id: string; is_active: number } | undefined;
  const found =
    (preferred ? live(preferred) : undefined) ??
    (db
      .prepare(
        `SELECT id, is_active FROM categories
          WHERE deleted_at IS NULL AND lower(trim(name)) = lower(?)
          ORDER BY created_at, id LIMIT 1`,
      )
      .get(DELIVERY_CHARGES_CATEGORY_NAME) as { id: string; is_active: number } | undefined) ??
    live(deliveryChargesCategoryId());
  if (found) {
    ensureCategoryOn(db, found.id, actor);
    return found.id;
  }
  const id = deliveryChargesCategoryId();
  const exists = db.prepare(`SELECT id FROM categories WHERE id = ?`).get(id);
  if (exists) {
    // Its name-based row was deleted (a fresh start before this version): a new look-alike can't take the id.
    const order = (
      db
        .prepare(
          `SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM categories WHERE deleted_at IS NULL`,
        )
        .get() as { n: number }
    ).n;
    return createCategory(
      db,
      { name: DELIVERY_CHARGES_CATEGORY_NAME, displayOrder: order, colorHex: '#78716c' },
      actor,
    ).id;
  }
  const order = (
    db
      .prepare(
        `SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM categories WHERE deleted_at IS NULL`,
      )
      .get() as { n: number }
  ).n;
  return createCategory(
    db,
    { id, name: DELIVERY_CHARGES_CATEGORY_NAME, displayOrder: order, colorHex: '#78716c' },
    actor,
  ).id;
}

/** A fee item's category must be on, or the website never sees the item (buildPublishedMenu reads categories that are on). */
function ensureCategoryOn(db: AppDatabase, categoryId: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT is_active FROM categories WHERE id = ? AND deleted_at IS NULL`)
    .get(categoryId) as { is_active: number } | undefined;
  if (row && row.is_active !== 1) updateCategory(db, { id: categoryId, isActive: true }, actor);
}

/** The tax most of the menu is charged (a new fee item's, when no fee item exists to copy). */
function mostUsedTaxCategory(db: AppDatabase): string | null {
  const row = db
    .prepare(
      `SELECT tc.id FROM tax_categories tc
         LEFT JOIN menu_items mi ON mi.tax_category_id = tc.id AND mi.deleted_at IS NULL
        WHERE tc.deleted_at IS NULL
        GROUP BY tc.id
        ORDER BY COUNT(mi.id) DESC, tc.id
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}
