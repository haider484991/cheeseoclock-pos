import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import type { Actor } from './base.js';
import { writeAudit } from './audit-repo.js';
import { listCategories, createCategory, deleteCategory } from './category-repo.js';
import { listMenuItems, createMenuItem, updateMenuItem, deleteMenuItem } from './menu-item-repo.js';
import {
  listIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  convertIngredientToBaseUnit,
  findIngredient,
  setRecipeForItem,
  type PriceMeta,
} from './ingredient-repo.js';
import { importPriceRowId, rollUpBatches, setSheetPrice } from './ingredient-cost-repo.js';
import { raiseBatchUnpricedAlerts } from './cost-alert-repo.js';
import { loadPriceBook } from '../price-book.js';
import { latestPriceTags } from '../price-history-read.js';
import { readDeliveryFeeItemIds, readMenuImportPolicy } from '../business-settings-read.js';
import { setBatchRecipe, clearBatchRecipeLines } from './batch-recipe-repo.js';
import { setBusinessSetting } from './business-settings-repo.js';
import { listCombos, deleteCombo } from './combo-repo.js';
import {
  listModifierGroups,
  listModifiersByGroup,
  createModifierGroup,
  updateModifierGroup,
  deleteModifierGroup,
  createModifier,
  updateModifier,
  deleteModifier,
  listModifierGroupsForItem,
  setItemModifierGroups,
} from './modifier-repo.js';
import { listTaxCategories, createTaxCategory } from './tax-category-repo.js';
import {
  normalizeName,
  planMenuImport,
  type GroupRef,
  type IngredientRef,
  type MenuImportOps,
  type MenuImportPlan,
  type MenuSnapshot,
  type ModifierRef,
} from '../menu-import-plan.js';
import type { MenuImportFile } from '@cheeseoclock/shared-schemas';
import { toPriceKind } from '@cheeseoclock/pos-domain';
import {
  isDeliveryChargeMenuItem,
  webAvailabilityOf,
  type MenuImportFreshStart,
  type MenuImportSummary,
  type WebAvailability,
} from '@cheeseoclock/shared-types';

/** The import cannot run as asked (open orders during a fresh start…). */
export class MenuImportRefusedError extends Error {}

function groupBy<T, K, V>(rows: T[], key: (r: T) => K, value: (r: T) => V): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), value(r)]);
  return out;
}

/** The live menu as the planner needs it. */
export function readMenuSnapshot(db: AppDatabase): MenuSnapshot {
  const recipes = db
    .prepare(`SELECT menu_item_id, ingredient_id, qty_per_unit, modifier_id FROM recipes WHERE deleted_at IS NULL`)
    .all() as Array<{ menu_item_id: string; ingredient_id: string; qty_per_unit: number; modifier_id: string | null }>;
  const attachments = db
    .prepare(
      `SELECT menu_item_id, modifier_group_id, sort_order FROM menu_item_modifier_groups WHERE deleted_at IS NULL`,
    )
    .all() as Array<{ menu_item_id: string; modifier_group_id: string; sort_order: number }>;
  const batchLines = db
    .prepare(`SELECT ingredient_id, input_ingredient_id, qty FROM batch_recipe_lines WHERE deleted_at IS NULL`)
    .all() as Array<{ ingredient_id: string; input_ingredient_id: string; qty: number }>;
  // Where each price came from, and the sheet's price kept for it (costing Phase 6: the till keeps its prices).
  const tags = latestPriceTags(db);
  const sheets = new Map(
    (
      db
        .prepare(
          `SELECT id, sheet_pack_size, sheet_pack_price_cents, sheet_price_kind FROM ingredients
            WHERE deleted_at IS NULL AND sheet_pack_size IS NOT NULL AND sheet_pack_price_cents IS NOT NULL`,
        )
        .all() as Array<{ id: string; sheet_pack_size: number; sheet_pack_price_cents: number; sheet_price_kind: string | null }>
    ).map((r) => [
      r.id,
      { packSize: Number(r.sheet_pack_size), packPriceCents: Number(r.sheet_pack_price_cents), priceKind: toPriceKind(r.sheet_price_kind) },
    ]),
  );
  return {
    categories: listCategories(db),
    items: listMenuItems(db),
    ingredients: listIngredients(db).map((i) => ({ ...i, priceSource: tags.get(i.id)?.source ?? null, sheet: sheets.get(i.id) ?? null })),
    recipes: groupBy(recipes, (r) => r.menu_item_id, (r) => ({
      ingredientId: r.ingredient_id,
      qtyPerUnit: r.qty_per_unit,
      modifierId: r.modifier_id,
    })),
    taxCategories: listTaxCategories(db),
    modifierGroups: listModifierGroups(db).map((g) => ({ ...g, modifiers: listModifiersByGroup(db, g.id) })),
    itemGroups: groupBy(attachments, (a) => a.menu_item_id, (a) => ({ groupId: a.modifier_group_id, sortOrder: a.sort_order })),
    batchLines: groupBy(batchLines, (b) => b.ingredient_id, (b) => ({ inputId: b.input_ingredient_id, qty: b.qty })),
  };
}

/**
 * Unpaid orders still in progress — a fresh start waits until there are none,
 * or their stock would come off recipes that no longer exist. Paid orders
 * waiting on the board are fine: their stock came off when they were paid.
 */
function countOpenOrders(db: AppDatabase): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
          WHERE deleted_at IS NULL AND paid_at IS NULL
            AND status IN ('open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery')`,
      )
      .get() as { n: number }
  ).n;
}

/** Throws while unpaid orders are open (checked again inside the import's transaction). */
export function refuseFreshStartWhileBusy(db: AppDatabase): void {
  const open = countOpenOrders(db);
  if (open > 0) {
    throw new MenuImportRefusedError(
      `${open} unpaid order${open === 1 ? ' is' : 's are'} still open. Take payment or discard ${open === 1 ? 'it' : 'them'} first — a fresh start replaces every menu item.`,
    );
  }
  // Purchase orders still expected point at the ingredients a fresh start
  // retires; receiving one afterwards failed with "Ingredient not found" and
  // the whole delivery rolled back (audit 2026-09-25).
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM purchase_orders
          WHERE deleted_at IS NULL AND status IN ('ordered', 'partial')`,
      )
      .get() as { n: number }
  ).n;
  if (pending > 0) {
    throw new MenuImportRefusedError(
      `${pending} purchase order${pending === 1 ? ' is' : 's are'} still waiting to be received. Receive or cancel ${pending === 1 ? 'it' : 'them'} first — a fresh start replaces every ingredient.`,
    );
  }
}

function taxUseOf(live: MenuSnapshot): Map<string, number> {
  const use = new Map<string, number>();
  for (const it of live.items) use.set(it.taxCategoryId, (use.get(it.taxCategoryId) ?? 0) + 1);
  return use;
}

/**
 * The same POS with no menu: what a fresh start plans against (tax
 * categories stay, and so do the delivery charges with their categories:
 * Settings → Delivery areas', never removed by a file).
 */
function emptyMenu(live: MenuSnapshot, feeItemIds: ReadonlySet<string>): MenuSnapshot {
  const fees = live.items.filter((i) => isDeliveryChargeMenuItem(i, feeItemIds));
  const feeCategories = new Set(fees.map((i) => i.categoryId));
  return {
    categories: live.categories.filter((c) => feeCategories.has(c.id)),
    items: fees,
    ingredients: [],
    recipes: new Map(),
    taxCategories: live.taxCategories,
    modifierGroups: [],
    itemGroups: new Map(),
    batchLines: new Map(),
    taxUse: taxUseOf(live),
  };
}

/**
 * What the owner set in Menu → On the website on the rows a fresh start
 * removes (the delivery charges and their categories stay, and keep theirs),
 * by name (normalizeName, as the import matches): each item set "Pick-up
 * only" or "Not on the website", each category off the website. The file
 * carries no website setting, so a fresh start gives the file's item or
 * category of the SAME name the setting its namesake had — the "kept on the
 * till" rule of an ordinary import, and the menu the import publishes at
 * once (menu:importApply) keeps them. Two removed rows of one name that were
 * set differently carry nothing (never guessed): that name's setting is lost
 * whatever the file holds, and the preview counts it. A value this version
 * does not know (a newer till's) is not carried.
 */
interface WebsiteCarry {
  items: Map<string, WebAvailability>;
  offCategories: Set<string>;
  /** Items and categories set so, by name — what the preview weighs against the file. */
  setItems: string[];
  setCategories: string[];
  /** Names whose removed rows were set differently: nothing carried, so always lost. */
  conflictingItems: string[];
  conflictingCategories: string[];
}

function websiteCarryOf(db: AppDatabase, feeItemIds: ReadonlySet<string>): WebsiteCarry {
  const kept = emptyMenu(readMenuSnapshot(db), feeItemIds);
  const keptItems = new Set(kept.items.map((i) => i.id));
  const keptCategories = new Set(kept.categories.map((c) => c.id));
  const items = new Map<string, WebAvailability | null>();
  const setItems: string[] = [];
  for (const r of db
    .prepare(`SELECT id, name, web_availability FROM menu_items WHERE deleted_at IS NULL`)
    .all() as Array<{ id: string; name: string; web_availability: string }>) {
    if (keptItems.has(r.id)) continue;
    const key = normalizeName(r.name);
    const w = webAvailabilityOf(r.web_availability);
    if (items.has(key) && items.get(key) !== w) items.set(key, null);
    else items.set(key, w);
  }
  const carried = new Map<string, WebAvailability>();
  const conflictingItems: string[] = [];
  for (const [key, w] of items) {
    // Set differently (one of them at least pick-up only or off): the new row is on the website.
    if (w === null) conflictingItems.push(key);
    if (w === null || w === 'on') continue;
    carried.set(key, w);
    setItems.push(key);
  }
  const categories = new Map<string, boolean | null>();
  for (const r of db
    .prepare(`SELECT id, name, is_on_website FROM categories WHERE deleted_at IS NULL`)
    .all() as Array<{ id: string; name: string; is_on_website: number }>) {
    if (keptCategories.has(r.id)) continue;
    const key = normalizeName(r.name);
    const off = r.is_on_website === 0;
    if (categories.has(key) && categories.get(key) !== off) categories.set(key, null);
    else categories.set(key, off);
  }
  const offCategories = new Set<string>();
  const conflictingCategories: string[] = [];
  for (const [key, off] of categories) {
    if (off === true) offCategories.add(key);
    // One off the website and one on it: the new category is on the website.
    else if (off === null) conflictingCategories.push(key);
  }
  return { items: carried, offCategories, setItems, setCategories: [...offCategories], conflictingItems, conflictingCategories };
}

function freshStartOf(
  db: AppDatabase,
  live: MenuSnapshot,
  feeItemIds: ReadonlySet<string>,
  ops: MenuImportOps,
): MenuImportFreshStart {
  const kept = emptyMenu(live, feeItemIds);
  const keptItems = new Set(kept.items.map((i) => i.id));
  // The website settings the fresh start can't keep (websiteCarryOf): set on a row it removes whose
  // name the file does not bring back — what the file brings back under another name is on the
  // website, and the import publishes the menu at once — and every name whose removed rows were set
  // differently (nothing is carried for it, file or not).
  const carry = websiteCarryOf(db, feeItemIds);
  const fileItems = new Set(ops.items.flatMap((o) => (o.create ? [normalizeName(o.create.name)] : [])));
  const fileCategories = new Set(ops.categories.flatMap((c) => (c.create ? [normalizeName(c.create.name)] : [])));
  const lost =
    carry.setItems.filter((k) => !fileItems.has(k)).length +
    carry.setCategories.filter((k) => !fileCategories.has(k)).length +
    carry.conflictingItems.length +
    carry.conflictingCategories.length;
  return {
    items: live.items
      .filter((i) => !keptItems.has(i.id))
      .map((i) => i.name)
      .sort((a, b) => a.localeCompare(b)),
    categories: live.categories.length - kept.categories.length,
    combos: listCombos(db).length,
    choiceGroups: live.modifierGroups.length,
    ingredients: live.ingredients.length,
    openOrders: countOpenOrders(db),
    websiteSettingsLost: lost,
  };
}

/**
 * What loading the file would do. fresh: as a fresh start — the whole current
 * menu removed first, so every row in the file is new.
 */
export function planMenuImportFromDb(
  db: AppDatabase,
  file: MenuImportFile,
  opts: { fresh?: boolean } = {},
): MenuImportPlan {
  const live = readMenuSnapshot(db);
  // What the file may change on what the till has (Settings → Kitchen & stock; the file wins by default).
  const policy = readMenuImportPolicy(db);
  // The delivery charges are Settings → Delivery areas': left as they are, a fresh start included.
  const feeItemIds = readDeliveryFeeItemIds(db);
  if (!opts.fresh) return planMenuImport(file, live, policy, feeItemIds);
  const plan = planMenuImport(file, emptyMenu(live, feeItemIds), policy, feeItemIds);
  return { ...plan, preview: { ...plan.preview, fresh: freshStartOf(db, live, feeItemIds, plan.ops), untouchedItems: [] } };
}

/**
 * Remove the whole menu — every menu item (with its recipe and choice
 * attachments), combo, choice group, ingredient (with its batch recipe) and
 * category — through the ordinary repositories, so each row syncs and audits.
 * Rows left behind by items deleted earlier are cleared too. Orders keep their
 * own snapshots, so history is unaffected. Returns the number of items removed.
 *
 * The delivery charges stay, with their category (Settings → Delivery areas'
 * items: each area names its own by id, the website checks the fee against
 * it, and a web order already placed carries it).
 */
function clearMenu(db: AppDatabase, actor: Actor, feeItemIds: ReadonlySet<string>): number {
  const ids = (sql: string) => (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);
  const fees = (
    db.prepare(`SELECT id, name, category_id FROM menu_items WHERE deleted_at IS NULL`).all() as Array<{
      id: string;
      name: string;
      category_id: string;
    }>
  ).filter((i) => isDeliveryChargeMenuItem(i, feeItemIds));
  const keptItems = new Set(fees.map((i) => i.id));
  const keptCategories = new Set(fees.map((i) => i.category_id));
  for (const id of ids(`SELECT DISTINCT menu_item_id AS id FROM recipes WHERE deleted_at IS NULL`)) {
    setRecipeForItem(db, id, [], actor);
  }
  for (const id of ids(`SELECT DISTINCT menu_item_id AS id FROM menu_item_modifier_groups WHERE deleted_at IS NULL`)) {
    setItemModifierGroups(db, id, [], actor);
  }
  const items = ids(`SELECT id FROM menu_items WHERE deleted_at IS NULL`).filter((id) => !keptItems.has(id));
  for (const id of items) deleteMenuItem(db, id, actor);
  for (const c of listCombos(db)) deleteCombo(db, c.id, actor);
  for (const g of listModifierGroups(db)) {
    for (const m of listModifiersByGroup(db, g.id)) deleteModifier(db, m.id, actor);
    deleteModifierGroup(db, g.id, actor);
  }
  for (const id of ids(`SELECT DISTINCT ingredient_id AS id FROM batch_recipe_lines WHERE deleted_at IS NULL`)) {
    clearBatchRecipeLines(db, id, actor);
  }
  for (const i of listIngredients(db)) deleteIngredient(db, i.id, actor);
  for (const c of listCategories(db)) if (!keptCategories.has(c.id)) deleteCategory(db, c.id, actor);
  return items.length;
}

/** The menu file's fingerprint: the same file gives the same one on every till. */
export function menuFileSha256(file: MenuImportFile): string {
  return createHash('sha256').update(JSON.stringify(file)).digest('hex');
}

type IngredientUpdate = NonNullable<MenuImportOps['ingredients'][number]['update']>;
type PriceFields = Pick<IngredientUpdate, 'costPerUnitCents' | 'packSize' | 'packPriceCents' | 'priceKind'>;

/** An ingredient update's price (null when it has none) and the rest of it (null when nothing else). */
function splitPrice(u: IngredientUpdate): { price: PriceFields | null; rest: Omit<IngredientUpdate, keyof PriceFields> | null } {
  const { costPerUnitCents, packSize, packPriceCents, priceKind, ...rest } = u;
  const price: PriceFields = {};
  if (costPerUnitCents !== undefined) price.costPerUnitCents = costPerUnitCents;
  if (packSize !== undefined) price.packSize = packSize;
  if (packPriceCents !== undefined) price.packPriceCents = packPriceCents;
  if (priceKind !== undefined) price.priceKind = priceKind;
  return { price: Object.keys(price).length > 0 ? price : null, rest: Object.keys(rest).length > 0 ? rest : null };
}

/** The ingredients already here that will be batches made here once the file is in: a batch recipe now, or one from the file. */
function batchesAfterFile(db: AppDatabase, ops: MenuImportOps): Set<string> {
  const ids = new Set(
    (db.prepare(`SELECT DISTINCT ingredient_id AS id FROM batch_recipe_lines WHERE deleted_at IS NULL`).all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
  for (const b of ops.batches) if ('existingId' in b.ingredient && b.lines.length > 0) ids.add(b.ingredient.existingId);
  return ids;
}

/** The same price, column for column. */
function samePrice(
  a: { costPerUnitCents: number; packSize: number | null; packPriceCents: number | null; priceKind: string },
  b: { costPerUnitCents: number; packSize: number | null; packPriceCents: number | null; priceKind: string },
): boolean {
  return (
    a.costPerUnitCents === b.costPerUnitCents &&
    a.packSize === b.packSize &&
    a.packPriceCents === b.packPriceCents &&
    a.priceKind === b.priceKind
  );
}

/**
 * Write a menu file. Re-plans against the live menu inside one transaction,
 * then goes through the ordinary repositories — every row gets its own sync
 * entry and audit row — plus one audit row recording the import itself.
 * Any failure rolls the whole import back.
 *
 * Prices (costing spec Phase 6, section 8): the till owns ingredient prices.
 * The file's price is written only for a NEW ingredient or one with no price
 * ('unset') — through the one price path as source 'import', each history
 * row with a name-based id from the ingredient and the file's fingerprint
 * (menuFileSha256: sha-256 of its content, so a copy saved with or without
 * a byte-order mark is the same file): importing the same file on both
 * tills gives ONE row per ingredient, which the link settles by id. Every
 * other ingredient keeps its price. The file's price is ALWAYS kept as the
 * sheet's reference (setSheetPrice), shown in Inventory beside the till's.
 *
 * A batch made here is costed from its batch recipe (D4: batch costs are
 * always the till's): once the file's batch recipes are in, a batch whose
 * inputs all have a price takes the price rolled up from them, and the
 * sheet's figure for it is only a reference. A batch with an input still
 * unpriced keeps the price it has (the sheet's only if it had none) and
 * Costing → Alerts says so (a 'batch_unpriced_input' alert named after the
 * file's row for it, so both tills raise the same one). The batches made
 * from a re-priced ingredient are rolled up once, at the end, from the
 * file's recipes (also with name-based ids).
 */
/**
 * A menu file from the costing PC (v0.7.32, services/menu-package-service.ts):
 * the website's package it came in. Never a fresh start.
 */
export interface MenuImportPackage {
  id: string;
  seq: number;
  /** SHA-256 of the file's raw bytes, as the website holds it. */
  sha256: string;
  fileName: string;
  uploadedAt: string;
  generatedAt: string;
  /** Put in by itself (true), or by someone's tap (false). */
  automatic: boolean;
}

export function applyMenuImport(
  db: AppDatabase,
  file: MenuImportFile,
  fileName: string,
  actor: Actor,
  opts: { fresh?: boolean; package?: MenuImportPackage } = {},
): MenuImportSummary {
  // A file from the costing PC is ALWAYS the safe update: nothing is removed.
  if (opts.package && opts.fresh) throw new MenuImportRefusedError('A menu file from the costing PC is never loaded as a fresh start.');
  const fileSha = menuFileSha256(file);
  // No alerts per ingredient: the file's prices only fill ingredients with none (never a jump); its batches are looked at at the end.
  const importPrice: PriceMeta = { source: 'import', rowKey: `import|${fileSha}`, cascade: false, alerts: false };
  const tx = db.transaction((): MenuImportSummary => {
    let removedItems = 0;
    let taxUse: Map<string, number> | undefined;
    /** A fresh start: the website settings of the rows it removes, for the file's rows of the same name. */
    let carry: WebsiteCarry | null = null;
    const feeItemIds = readDeliveryFeeItemIds(db);
    if (opts.fresh) {
      refuseFreshStartWhileBusy(db);
      taxUse = taxUseOf(readMenuSnapshot(db));
      carry = websiteCarryOf(db, feeItemIds);
      removedItems = clearMenu(db, actor, feeItemIds);
    }
    const snapshot = readMenuSnapshot(db);
    // The owner's import rules as they are now, inside the transaction: what the preview showed, or a Save since.
    const { ops, preview } = planMenuImport(
      file,
      taxUse ? { ...snapshot, taxUse } : snapshot,
      readMenuImportPolicy(db),
      feeItemIds,
    );

    const taxCategoryId = ops.createTaxCategory
      ? createTaxCategory(db, ops.createTaxCategory, actor).id
      : ops.taxCategoryId;

    const categoryIds = new Map<string, string>();
    for (const c of ops.categories) {
      const offWebsite = !c.existingId && !!carry && carry.offCategories.has(normalizeName(c.create!.name));
      categoryIds.set(c.fileKey, c.existingId ?? createCategory(db, { ...c.create!, ...(offWebsite ? { isOnWebsite: false } : {}) }, actor).id);
    }

    const ingredientIds = new Map<string, string>();
    /** Ingredients whose price this file wrote, in file order: their batches roll up at the end. */
    const repriced: string[] = [];
    /** The file's price for a batch made here: decided once the file's batch recipes are in. */
    const batchPrices: Array<{ id: string; price: PriceFields }> = [];
    const madeHere = batchesAfterFile(db, ops);
    const writeImportPrice = (id: string, update: IngredientUpdate) => {
      const before = findIngredient(db, id)!;
      const after = updateIngredient(db, { id, ...update }, actor, importPrice);
      if (!samePrice(before, after)) repriced.push(id);
    };
    for (const ing of ops.ingredients) {
      if (ing.existingId) {
        if (ing.convert) convertIngredientToBaseUnit(db, ing.existingId, actor, { priceRowKey: `convert|${fileSha}` });
        if (ing.update) {
          const { price, rest } = splitPrice(ing.update);
          if (price && madeHere.has(ing.existingId)) {
            if (rest) updateIngredient(db, { id: ing.existingId, ...rest }, actor);
            batchPrices.push({ id: ing.existingId, price });
          } else {
            writeImportPrice(ing.existingId, ing.update);
          }
        }
        setSheetPrice(db, ing.existingId, ing.sheet, actor);
        ingredientIds.set(ing.fileKey, ing.existingId);
      } else if (ing.create) {
        const id = createIngredient(db, ing.create, actor, importPrice).id;
        setSheetPrice(db, id, ing.sheet, actor);
        ingredientIds.set(ing.fileKey, id);
        repriced.push(id);
      }
    }
    const ingredientId = (ref: IngredientRef): string => {
      const id = 'existingId' in ref ? ref.existingId : ingredientIds.get(ref.fileKey);
      if (!id) throw new Error('A recipe points at an ingredient that was not created');
      return id;
    };

    for (const b of ops.batches) {
      setBatchRecipe(
        db,
        {
          ingredientId: ingredientId(b.ingredient),
          batchYield: b.batchYield,
          batchMethod: b.batchMethod,
          lines: b.lines.map((l) => ({ inputIngredientId: ingredientId(l.ingredient), qty: l.qty })),
        },
        actor,
        { rollUpKey: `recipe|import|${fileSha}` },
      );
    }

    // Every batch made here that the file names: with every input priced
    // (the file's own recipe and prices now in), its roll-up wins and the
    // sheet's figure is only a reference; with one unpriced it keeps the
    // price it has — the sheet's only when it had none (planned only then)
    // — and Costing → Alerts says so, once the file is in.
    const pricedLater = new Map(batchPrices.map((b) => [b.id, b.price]));
    const fileBatches = [
      ...new Set(
        ops.ingredients.flatMap((o) => {
          const id = o.existingId ?? ingredientIds.get(o.fileKey);
          return id && (madeHere.has(id) || ops.batches.some((b) => 'fileKey' in b.ingredient && b.ingredient.fileKey === o.fileKey)) ? [id] : [];
        }),
      ),
    ];
    const unpricedBatches: string[] = [];
    for (const id of fileBatches) {
      const rolled = loadPriceBook(db).prices.get(id);
      if (!rolled?.batch) continue;
      if (rolled.batch.complete) {
        rollUpBatches(db, [id], `import|${fileSha}`, actor, {
          self: true,
          note: "From its batch recipe (the costing sheet's figure for it is only a reference)",
        });
        continue;
      }
      const price = pricedLater.get(id);
      if (price) writeImportPrice(id, price);
      unpricedBatches.push(id);
    }

    // Every batch made from an ingredient this file re-priced takes its
    // rolled-up price now, from the file's own batch recipes — on this till
    // only, once per batch per triggering price row (apply-remote never
    // rolls up again).
    for (const id of repriced) rollUpBatches(db, [id], importPriceRowId(id, fileSha), actor);

    // A batch made here that kept its price because something in it has no
    // price: Costing → Alerts, named after the file's row for it.
    raiseBatchUnpricedAlerts(
      db,
      unpricedBatches,
      (batchId) => ({ key: importPriceRowId(batchId, fileSha), rowId: importPriceRowId(batchId, fileSha), because: 'import', changedName: null }),
      actor,
    );

    const groupIds = new Map<string, string>();
    const optionIds = new Map<string, string>();
    for (const g of ops.modifierGroups) {
      let gid = g.existingId;
      if (!gid) gid = createModifierGroup(db, g.create!, actor).id;
      else if (g.update) updateModifierGroup(db, { id: gid, ...g.update }, actor);
      groupIds.set(g.groupKey, gid);
      for (const o of g.options) {
        let oid = o.existingId;
        if (!oid) {
          const { removes, ...create } = o.create!;
          oid = createModifier(
            db,
            { modifierGroupId: gid, ...create, removesIngredientId: removes ? ingredientId(removes) : null },
            actor,
          ).id;
        } else if (o.update) {
          const { removes, ...update } = o.update;
          updateModifier(
            db,
            {
              id: oid,
              ...update,
              ...(removes !== undefined ? { removesIngredientId: removes ? ingredientId(removes) : null } : {}),
            },
            actor,
          );
        }
        optionIds.set(`${g.groupKey}|${o.optionKey}`, oid);
      }
    }
    const groupId = (ref: GroupRef): string => {
      const id = 'existingId' in ref ? ref.existingId : groupIds.get(ref.groupKey);
      if (!id) throw new Error('An item points at a choice group that was not created');
      return id;
    };
    const modifierId = (ref: ModifierRef): string => {
      const id = 'existingId' in ref ? ref.existingId : optionIds.get(`${ref.groupKey}|${ref.optionKey}`);
      if (!id) throw new Error('A recipe line points at a choice that was not created');
      return id;
    };

    for (const op of ops.items) {
      let itemId = op.existingId;
      if (!itemId && op.create) {
        const categoryId = categoryIds.get(op.create.categoryFileKey);
        if (!categoryId || !taxCategoryId) throw new Error(`No category or tax for ${op.create.name}`);
        const webAvailability = carry?.items.get(normalizeName(op.create.name));
        itemId = createMenuItem(
          db,
          {
            categoryId,
            name: op.create.name,
            description: op.create.description,
            basePriceCents: op.create.basePriceCents,
            taxCategoryId,
            sortOrder: op.create.sortOrder,
            ...(webAvailability ? { webAvailability } : {}),
          },
          actor,
        ).id;
      } else if (itemId && op.update) {
        const { useImportTax, ...fields } = op.update;
        if (useImportTax && !taxCategoryId) throw new Error('No tax category to move items onto');
        updateMenuItem(db, { id: itemId, ...fields, ...(useImportTax ? { taxCategoryId: taxCategoryId! } : {}) }, actor);
      }
      if (!itemId) continue;
      if (op.attach.length > 0) {
        // Keep what is attached, add the file's groups after it.
        const current = listModifierGroupsForItem(db, itemId);
        let next = Math.max(-1, ...current.map((g) => g.sortOrder)) + 1;
        setItemModifierGroups(
          db,
          itemId,
          [
            ...current.map((g) => ({ modifierGroupId: g.id, sortOrder: g.sortOrder })),
            ...op.attach.map((ref) => ({ modifierGroupId: groupId(ref), sortOrder: next++ })),
          ],
          actor,
        );
      }
      if (op.recipe) {
        setRecipeForItem(
          db,
          itemId,
          op.recipe.map((line) => ({
            ingredientId: ingredientId(line.ingredient),
            qtyPerUnit: line.qty,
            modifierId: line.modifier ? modifierId(line.modifier) : null,
          })),
          actor,
        );
      }
    }

    const pkg = opts.package;
    writeAudit(db, {
      entityType: 'menu_import',
      entityId: uuidv7(),
      action: 'import',
      actorUserId: actor.userId,
      before: null,
      after: {
        fileName,
        fileSha256: fileSha,
        source: file.source,
        fresh: !!opts.fresh,
        removedItems,
        summary: preview.summary,
        ...(pkg
          ? {
              package: {
                id: pkg.id,
                seq: pkg.seq,
                sha256: pkg.sha256,
                fileName: pkg.fileName,
                uploadedAt: pkg.uploadedAt,
                generatedAt: pkg.generatedAt,
                automatic: pkg.automatic,
              },
            }
          : {}),
      },
    });
    if (pkg) {
      // LAST, in the same transaction: the marker travels to the other till
      // after the rows it made, and a failure anywhere leaves neither.
      const s = preview.summary;
      setBusinessSetting(
        db,
        'menu.lastPackage',
        {
          v: 1,
          packageId: pkg.id,
          seq: pkg.seq,
          uploadedAt: pkg.uploadedAt,
          sha256: pkg.sha256,
          fileName: pkg.fileName,
          appliedByDevice: actor.deviceId,
          appliedAt: new Date().toISOString(),
          automatic: pkg.automatic,
          counts: {
            newItems: s.newItems,
            updatedItems: s.updatedItems,
            priceChanges: s.priceChanges,
            newIngredients: s.newIngredients,
            updatedIngredients: s.updatedIngredients,
            newCategories: s.newCategories,
            recipesSet: s.recipesSet,
            choiceGroupsChanged: s.choiceGroupsChanged,
            batchRecipesSet: s.batchRecipesSet,
            skipped: s.skipped,
          },
        },
        actor,
      );
    }
    return { ...preview.summary, removedItems };
  });
  return tx();
}
