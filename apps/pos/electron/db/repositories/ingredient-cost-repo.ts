import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { loadPriceBook } from '../price-book.js';
import { evaluatePriceAlerts, type PriceWritten } from './cost-alert-repo.js';
import { COC_ID_NAMESPACE, type PriceKind, type PriceSource } from '@cheeseoclock/shared-types';
import {
  batchesUsing,
  effectivePack,
  packInUnit,
  sameStoredPrice,
  storedPriceOf,
  toPriceKind,
  typedPricePack,
  unitCostMc,
  type Pack,
  type StoredPrice,
  type TypedPrice,
} from '@cheeseoclock/pos-domain';

/**
 * Ingredient prices and their history (costing spec Phase 4, migration
 * 0034). THE single way a price is written: typed ("Set price", the
 * ingredient form), the menu file, a bill, a Convert and a batch rolled up
 * all come here. Each price written, in ONE transaction:
 *   1. the ingredient's own price columns — the exact pack ("6,000 g for
 *      Rs 2,250"), cost_per_unit_cents in whole paisa only for older
 *      screens, and the price kind — with its sync entry and audit row;
 *   2. one ingredient_costs row (the history), with its sync entry and
 *      audit row;
 *   3. unless told not to, the batches made from it (Cheese Mix from
 *      mozzarella, and anything made with Cheese Mix) take their rolled-up
 *      price, each as a 'batch' row of its own;
 *   4. unless told not to, the price alerts (costing spec Phase 6,
 *      cost-alert-repo evaluatePriceAlerts): a key ingredient that jumped,
 *      a change that costs the menu Rs N a week, a batch that kept its old
 *      price. In its own savepoint: an alert that can't be worked out never
 *      stops the price. A delivery or a menu file looks at all its prices
 *      once, at its end, instead.
 *
 * The roll-up runs ONLY here, on the till that wrote the triggering price.
 * The other till receives the price and the batch rows as rows
 * (apply-remote) and rolls nothing up again: the batch rows' ids are
 * name-based on the triggering row, so both tills hold the same ones.
 *
 * No other repository writes an ingredient's price columns
 * (price-history.db.test.ts scans for it). The costing sheet's price for it
 * (ingredients.sheet_*, costing spec Phase 6: a reference only, never used
 * for costing) is written here too (setSheetPrice), and "Use the sheet's
 * price" turns it into the price (useSheetPrice).
 *
 * The history is APPEND-ONLY: a row, once written, is never edited here —
 * not its price, not its date. A name-based id that is already taken (the
 * same menu file imported again after the price was changed by hand) gets
 * a new row whose id is named after that id and the row it follows
 * (priceRowIdAfter), so two tills doing the same from the same history
 * still write the same row.
 */

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * A name-based id for a history row two tills could each write for the same
 * fact (costing spec D13): the same key gives the same row on every till,
 * and the link settles it by id.
 */
export function priceRowId(ingredientId: string, key: string): string {
  return uuidv5(`ingredient_costs:${ingredientId}|${key}`, COC_ID_NAMESPACE);
}

/** The one starting price of an ingredient, written once per till (services/costing-seed.ts). */
export function seedPriceRowId(ingredientId: string): string {
  return priceRowId(ingredientId, 'seed');
}

/**
 * When a starting price is in force from: the start of time, the same on
 * every till. The starting price stands for everything before price history
 * began, so it must sort before every real change — whichever till writes
 * it, and when. Stamped with a till's boot time, the later till's copy
 * would win on both (the link keeps the later write) and could land AFTER a
 * price typed on the other till in between. When it was written is its
 * created_at (the drawer's "recorded").
 */
export const SEED_EFFECTIVE_AT = '1970-01-01T00:00:00.000Z';

/**
 * The id of a row for a fact whose name-based id is already taken by an
 * earlier row (the same menu file imported again after a price typed by
 * hand): named after that id and the ingredient's newest row now, so the
 * history grows by one row instead of the earlier row being rewritten, and
 * two tills doing the same from the same history write the same row.
 */
export function priceRowIdAfter(ingredientId: string, takenId: string, newestRowId: string | null): string {
  return priceRowId(ingredientId, `again|${takenId}|${newestRowId ?? 'none'}`);
}

/** A menu file's price for an ingredient: one per ingredient per file, whichever till imports it. */
export function importPriceRowId(ingredientId: string, fileSha256: string): string {
  return priceRowId(ingredientId, `import|${fileSha256}`);
}

/** A batch's rolled-up price, after the price row that set it off. */
export function batchPriceRowId(batchIngredientId: string, triggerRowId: string): string {
  return priceRowId(batchIngredientId, `batch|${triggerRowId}`);
}

// ---------------------------------------------------------------------------
// Writing a price
// ---------------------------------------------------------------------------

interface PriceCols {
  unit: string;
  name: string;
  cost_per_unit_cents: number;
  pack_size: number | null;
  pack_price_cents: number | null;
  price_kind: string;
}

function readPriceCols(db: AppDatabase, ingredientId: string): PriceCols | undefined {
  return db
    .prepare(
      `SELECT name, unit, cost_per_unit_cents, pack_size, pack_price_cents, price_kind
         FROM ingredients WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(ingredientId) as PriceCols | undefined;
}

function storedOf(r: PriceCols): StoredPrice {
  return {
    costPerUnitCents: Number(r.cost_per_unit_cents),
    packSize: r.pack_size === null ? null : Number(r.pack_size),
    packPriceCents: r.pack_price_cents === null ? null : Number(r.pack_price_cents),
    priceKind: toPriceKind(r.price_kind),
  };
}

/** A price as the ingredient form sends it: an exact pack, or (the older way) a whole-paisa cost per unit. */
export interface PriceInput {
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
}

export interface PriceWrite {
  ingredientId: string;
  price: PriceInput;
  /** What was said about the price ('free', a guess…); omitted = it follows the price (priceKindAfter). */
  priceKind?: PriceKind;
  source: PriceSource;
  supplierId?: string | null;
  purchaseOrderId?: string | null;
  purchaseOrderItemId?: string | null;
  notes?: string | null;
  /**
   * A bill, kept EXACTLY in the history row as it was paid — `size` units
   * for `priceCents` (costing spec 4.1: "the history row is (q, B)") —
   * while the ingredient keeps its usual pack at the bill's price (`price`).
   * Omitted: the history row is the ingredient's new pack.
   */
  historyPack?: Pack | null;
}

export interface PriceWriteOptions {
  /** The history row's id: a name-based one (priceRowId) for a row two tills could both write; else a new uuid v7. */
  id?: string;
  /** Roll the new price up into every batch made from it (default yes). The menu import rolls up once, at its end. */
  cascade?: boolean;
  /**
   * A brand-new ingredient's first price: a history row is written whatever
   * the price, with no earlier price, and the ingredient row's own sync entry
   * and audit row are left to the create that called this (same transaction).
   */
  first?: boolean;
  /** Write a history row even when the price columns stay as they are (a Convert: the same price, in the new unit). */
  force?: boolean;
  /** The unit the price stood in before this write, when it was not the ingredient's unit now (a Convert). */
  previousUnit?: string;
  /**
   * Look at the new price for alerts now (default yes). A delivery, a
   * purchase or the menu file says no and looks at all its prices once, at
   * its end (cost-alert-repo evaluatePriceAlerts with the `written` of each).
   */
  alerts?: boolean;
}

export interface PriceWriteResult {
  /** The history row written, or null when the price already was this (nothing written). */
  entryId: string | null;
  /** Batches whose rolled-up price was written back, bottom-up. */
  rolledUp: string[];
  /** What the alerts need to look at this write later (`alerts: false`); null when nothing was written. */
  written: PriceWritten | null;
}

/**
 * Write an ingredient's price (see the top of this file): the ingredient's
 * price columns, one history row, both synced and audited, and the batches
 * made from it rolled up — one transaction. Nothing is written when the
 * price is already exactly this (unless `first` / `force`).
 */
export function setIngredientPrice(
  db: AppDatabase,
  write: PriceWrite,
  actor: Actor,
  opts: PriceWriteOptions = {},
): PriceWriteResult {
  return db.transaction((): PriceWriteResult => {
    const cur = opts.first ? undefined : readPriceCols(db, write.ingredientId);
    const entryId = writePrice(db, write, actor, opts);
    const rolledUp =
      entryId !== null && opts.cascade !== false && !opts.first ? rollUpBatches(db, [write.ingredientId], entryId, actor) : [];
    const written: PriceWritten | null =
      entryId !== null && cur ? { ingredientId: write.ingredientId, before: storedOf(cur), entryId, source: write.source } : null;
    // Step 4: the alerts, on this till only (never for a brand-new ingredient's first price).
    if (written && opts.alerts !== false) evaluatePriceAlerts(db, [written], actor);
    return { entryId, rolledUp, written };
  })();
}

/**
 * "Set price", as typed (costing spec 4.1): Rs X per kg / litre, for a pack
 * of N, or per piece — kept as that exact pack. 'free' is Rs 0.
 */
export function setTypedPrice(
  db: AppDatabase,
  input: { ingredientId: string; typed: TypedPrice; priceKind?: 'set' | 'estimate' | 'free'; notes?: string | null },
  actor: Actor,
): PriceWriteResult {
  const cur = readPriceCols(db, input.ingredientId);
  if (!cur) throw new Error('Ingredient not found');
  // A batch whose inputs all have a price is costed from its recipe (costing
  // spec D4: batch costs are always the till's). A price typed over it would
  // show in Inventory while Costing, plate costs and sales used the recipe's,
  // and be replaced at the next input change: refused, in plain words.
  const rolled = loadPriceBook(db).prices.get(input.ingredientId);
  if (rolled?.batch?.complete) {
    throw new Error(
      `${cur.name} is made here, so its price is worked out from its batch recipe. ` +
        'To change it, change the price of what goes into it, or its recipe.',
    );
  }
  const price: PriceInput =
    input.priceKind === 'free'
      ? { costPerUnitCents: 0, packSize: null, packPriceCents: null }
      : (() => {
          const pack = typedPricePack(input.typed, cur.unit);
          return { costPerUnitCents: 0, packSize: pack.size, packPriceCents: pack.priceCents };
        })();
  return setIngredientPrice(
    db,
    {
      ingredientId: input.ingredientId,
      price,
      // A typed price above Rs 0 is a real one unless it is said to be a guess.
      priceKind: input.priceKind ?? 'set',
      source: 'manual',
      notes: input.notes ?? null,
    },
    actor,
  );
}

/** The history row as written: every column, for the sync payload and the audit row. */
interface CostEntry {
  id: string;
  ingredientId: string;
  effectiveAt: string;
  unit: string;
  packSize: number;
  packPriceCents: number;
  priceKind: PriceKind;
  unitCostMc: number;
  prevUnitCostMc: number | null;
  source: PriceSource;
  supplierId: string | null;
  purchaseOrderId: string | null;
  purchaseOrderItemId: string | null;
  actorUserId: string | null;
  notes: string | null;
}

/** Steps 1 and 2 of setIngredientPrice, inside the caller's transaction. Returns the history row's id, or null. */
function writePrice(db: AppDatabase, w: PriceWrite, actor: Actor, opts: PriceWriteOptions): string | null {
  const cur = readPriceCols(db, w.ingredientId);
  if (!cur) throw new Error('Ingredient not found');
  const before = storedOf(cur);
  const next = storedPriceOf(w.price, opts.first ? null : before.priceKind, w.priceKind);
  const changed = !sameStoredPrice(before, next);
  if (!changed && !opts.first && !opts.force) return null;
  const now = nowIso();

  if (changed) {
    db.prepare(
      `UPDATE ingredients
          SET cost_per_unit_cents = ?, pack_size = ?, pack_price_cents = ?, price_kind = ?,
              updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(next.costPerUnitCents, next.packSize, next.packPriceCents, next.priceKind, now, w.ingredientId);
    if (!opts.first) {
      enqueueSync(db, { entityType: 'ingredients', entityId: w.ingredientId, op: 'upsert', payload: { id: w.ingredientId, ...next } });
      writeAudit(db, {
        entityType: 'ingredients',
        entityId: w.ingredientId,
        action: 'set_price',
        actorUserId: actor.userId,
        before: { ...before, unit: opts.previousUnit ?? cur.unit },
        after: { ...next, unit: cur.unit, source: w.source },
      });
    }
  }

  // The history row: the bill exactly as paid (a delivery, a purchase), else the new pack.
  const pack = w.historyPack && next.priceKind !== 'free' && next.priceKind !== 'unset' ? w.historyPack : effectivePack(next);
  if (!Number.isSafeInteger(pack.size) || pack.size < 1 || !Number.isSafeInteger(pack.priceCents) || pack.priceCents < 0) {
    throw new Error('A price must be for at least 1 whole unit, at Rs 0 or more in whole paisa');
  }
  // The price before, for the ▲ / ▼: the newest line of its history — what
  // the owner sees as the price before (a batch's starting price is its
  // rolled-up one, while its own columns may still hold the sheet's) — in
  // this row's unit; the stored columns only when there is no history yet.
  const newest = opts.first ? undefined : newestCostRow(db, w.ingredientId);
  const prevPack = opts.first
    ? null
    : newest
      ? toPriceKind(newest.price_kind) === 'unset'
        ? null
        : packInUnit({ size: Number(newest.pack_size), priceCents: Number(newest.pack_price_cents) }, newest.unit, cur.unit)
      : before.priceKind === 'unset'
        ? null
        : packInUnit(effectivePack(before), opts.previousUnit ?? cur.unit, cur.unit);
  let id = opts.id ?? uuidv7();
  // Append-only: a name-based id already taken gets the row after it, named after both.
  for (let tries = 0; opts.id !== undefined && costRowExists(db, id); tries++) {
    id = tries < 8 ? priceRowIdAfter(w.ingredientId, id, newest?.id ?? null) : uuidv7();
  }
  const entry: CostEntry = {
    id,
    ingredientId: w.ingredientId,
    effectiveAt: now,
    unit: cur.unit,
    packSize: pack.size,
    packPriceCents: pack.priceCents,
    priceKind: next.priceKind,
    unitCostMc: unitCostMc(pack),
    prevUnitCostMc: prevPack ? unitCostMc(prevPack) : null,
    source: w.source,
    supplierId: w.supplierId ?? null,
    purchaseOrderId: w.purchaseOrderId ?? null,
    purchaseOrderItemId: w.purchaseOrderItemId ?? null,
    actorUserId: actor.userId,
    notes: w.notes ?? null,
  };
  writeCostRow(db, entry, actor, now);
  return entry.id;
}

/** The ingredient's newest history row (the price in force now, as its history says), or undefined. */
function newestCostRow(
  db: AppDatabase,
  ingredientId: string,
): { id: string; unit: string; pack_size: number; pack_price_cents: number; price_kind: string } | undefined {
  return db
    .prepare(
      `SELECT id, unit, pack_size, pack_price_cents, price_kind FROM ingredient_costs
        WHERE ingredient_id = ? AND deleted_at IS NULL
        ORDER BY effective_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ingredientId) as { id: string; unit: string; pack_size: number; pack_price_cents: number; price_kind: string } | undefined;
}

function costRowExists(db: AppDatabase, id: string): boolean {
  return db.prepare(`SELECT 1 AS x FROM ingredient_costs WHERE id = ?`).get(id) !== undefined;
}

/**
 * Insert a history row, with its sync entry and audit row. Append-only: the
 * id is always a new one (writePrice picks the row after a name-based id
 * already taken), so nothing already in the history is ever rewritten.
 */
function writeCostRow(db: AppDatabase, e: CostEntry, actor: Actor, now: string): void {
  db.prepare(
    `INSERT INTO ingredient_costs
       (id, ingredient_id, effective_at, unit, pack_size, pack_price_cents, price_kind, unit_cost_mc,
        prev_unit_cost_mc, source, supplier_id, ref_purchase_order_id, ref_purchase_order_item_id,
        actor_user_id, notes, created_at, updated_at, device_id, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    e.id,
    e.ingredientId,
    e.effectiveAt,
    e.unit,
    e.packSize,
    e.packPriceCents,
    e.priceKind,
    e.unitCostMc,
    e.prevUnitCostMc,
    e.source,
    e.supplierId,
    e.purchaseOrderId,
    e.purchaseOrderItemId,
    e.actorUserId,
    e.notes,
    now,
    now,
    actor.deviceId,
  );
  enqueueSync(db, { entityType: 'ingredient_costs', entityId: e.id, op: 'upsert', payload: e });
  writeAudit(db, { entityType: 'ingredient_costs', entityId: e.id, action: 'create', actorUserId: actor.userId, before: null, after: e });
}

// ---------------------------------------------------------------------------
// Batches roll up (costing spec 4.1, D4: batch costs are always the till's)
// ---------------------------------------------------------------------------

/**
 * Write the rolled-up price back to every batch made from `changedIds`
 * (directly or through other batches), bottom-up, after the change
 * `trigger` (the id of the price row that set it off, or for a batch
 * recipe saved, a key of that save): each batch whose inputs all have a
 * price and whose rolled price is not already its own gets a 'batch'
 * history row, id batchPriceRowId(batch, trigger) — once per batch per
 * trigger, so a second run changes nothing. With `recipeChanged` (their
 * own recipe was just saved) or `self` (the menu file's price for them was
 * set aside: the till's roll-up wins, costing spec D4 / section 8), the
 * changed ids that are batches roll up too, first. A batch with an input
 * still unpriced keeps its own price
 * (Missing costs flags it). A loop is never followed round: its batches
 * cannot be rolled up (effectivePrices) and are left alone.
 *
 * Only ever called on the till that made the change; apply-remote never
 * calls it (arriving rows are already rolled up). Returns the batches written.
 */
export function rollUpBatches(
  db: AppDatabase,
  changedIds: readonly string[],
  trigger: string,
  actor: Actor,
  opts: { recipeChanged?: boolean; self?: boolean; note?: string } = {},
): string[] {
  return db.transaction((): string[] => {
    // One read after the change is written: a complete roll-up is worked
    // from its inputs' prices, never from a batch's own stored price, so
    // every batch's rolled price is known before any is written.
    const book = loadPriceBook(db);
    const written: string[] = [];
    const names = changedIds.map((id) => book.ingredients.get(id)?.name).filter((n): n is string => !!n);
    const why = opts.recipeChanged ? `${names.join(', ')}'s recipe changed` : `${names.join(', ')} changed`;
    const self = opts.recipeChanged || opts.self ? changedIds.filter((id) => book.batchLines.has(id)) : [];
    const order = [...new Set([...self, ...batchesUsing(changedIds, book.batchLines)])];
    for (const batchId of order) {
      const p = book.prices.get(batchId);
      if (!p?.batch?.complete) continue;
      const id = writePrice(
        db,
        {
          ingredientId: batchId,
          price: { costPerUnitCents: 0, packSize: p.pack.size, packPriceCents: p.pack.priceCents },
          priceKind: p.kind,
          source: 'batch',
          notes: opts.note ?? (names.length > 0 ? `From its batch recipe, after ${why}` : 'From its batch recipe'),
        },
        actor,
        { id: batchPriceRowId(batchId, trigger) },
      );
      if (id !== null) written.push(batchId);
    }
    return written;
  })();
}

// ---------------------------------------------------------------------------
// The costing sheet's price: a reference (costing spec Phase 6, section 8)
// ---------------------------------------------------------------------------

/** The costing sheet's price for an ingredient, exactly as the menu file gives it. */
export interface SheetPriceInput {
  packSize: number;
  packPriceCents: number;
  /** 'set', 'estimate' (the file says it is a guess) or 'unset' (the file says Rs 0). */
  priceKind: PriceKind;
}

interface SheetCols {
  name: string;
  unit: string;
  sheet_pack_size: number | null;
  sheet_pack_price_cents: number | null;
  sheet_price_kind: string | null;
  sheet_price_at: string | null;
}

function readSheetCols(db: AppDatabase, ingredientId: string): SheetCols | undefined {
  return db
    .prepare(
      `SELECT name, unit, sheet_pack_size, sheet_pack_price_cents, sheet_price_kind, sheet_price_at
         FROM ingredients WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(ingredientId) as SheetCols | undefined;
}

/**
 * Keep the costing sheet's price for an ingredient as its reference
 * (ingredients.sheet_*): what Inventory shows beside the till's price, and
 * what "Use the sheet's price" would use. Never the price costing uses. The
 * ingredient row with its sync entry and an audit row, one transaction;
 * nothing is written when the sheet already said exactly this. True when
 * written.
 */
export function setSheetPrice(
  db: AppDatabase,
  ingredientId: string,
  sheet: SheetPriceInput,
  actor: Actor,
  opts: {
    /** When the sheet said it (default now: a menu file); a Convert keeps the date it had. */
    at?: string;
    /** The unit the reference was in before (a Convert: the ingredient's unit has just changed). */
    unitBefore?: string;
  } = {},
): boolean {
  if (!Number.isSafeInteger(sheet.packSize) || sheet.packSize < 1 || !Number.isSafeInteger(sheet.packPriceCents) || sheet.packPriceCents < 0) {
    throw new Error("The sheet's price must be for at least 1 whole unit, at Rs 0 or more in whole paisa");
  }
  return db.transaction((): boolean => {
    const cur = readSheetCols(db, ingredientId);
    if (!cur) throw new Error('Ingredient not found');
    const before =
      cur.sheet_pack_size === null || cur.sheet_pack_price_cents === null
        ? null
        : {
            packSize: Number(cur.sheet_pack_size),
            packPriceCents: Number(cur.sheet_pack_price_cents),
            priceKind: toPriceKind(cur.sheet_price_kind),
            at: cur.sheet_price_at,
          };
    if (
      before &&
      before.packSize === sheet.packSize &&
      before.packPriceCents === sheet.packPriceCents &&
      before.priceKind === sheet.priceKind
    ) {
      return false;
    }
    const now = nowIso();
    const at = opts.at ?? now;
    db.prepare(
      `UPDATE ingredients
          SET sheet_pack_size = ?, sheet_pack_price_cents = ?, sheet_price_kind = ?, sheet_price_at = ?,
              updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(sheet.packSize, sheet.packPriceCents, sheet.priceKind, at, now, ingredientId);
    const after = { ...sheet, at };
    enqueueSync(db, { entityType: 'ingredients', entityId: ingredientId, op: 'upsert', payload: { id: ingredientId, sheetPrice: after } });
    writeAudit(db, {
      entityType: 'ingredients',
      entityId: ingredientId,
      action: 'set_sheet_price',
      actorUserId: actor.userId,
      before: { sheetPrice: before, unit: opts.unitBefore ?? cur.unit },
      after: { sheetPrice: after, unit: cur.unit },
    });
    return true;
  })();
}

/**
 * The sheet's reference in a new unit, after a Convert that counts `factor`×
 * as many units (kg → g, l → ml): the same figure, exactly — its pack holds
 * `factor`× as many units for the same money ("1 kg for Rs 1,500" becomes
 * "1,000 g for Rs 1,500"), as the price itself is converted (costing spec
 * 4.1). Kept with the date the sheet said it. Synced and audited
 * (setSheetPrice); nothing when no menu file has named it. True when written.
 */
export function convertSheetPrice(db: AppDatabase, ingredientId: string, factor: number, unitBefore: string, actor: Actor): boolean {
  if (!Number.isSafeInteger(factor) || factor < 1) throw new Error('A unit change multiplies by a whole number');
  const cur = readSheetCols(db, ingredientId);
  if (!cur || cur.sheet_pack_size === null || cur.sheet_pack_price_cents === null || factor === 1) return false;
  return setSheetPrice(
    db,
    ingredientId,
    { packSize: Number(cur.sheet_pack_size) * factor, packPriceCents: Number(cur.sheet_pack_price_cents), priceKind: toPriceKind(cur.sheet_price_kind) },
    actor,
    { ...(cur.sheet_price_at ? { at: cur.sheet_price_at } : {}), unitBefore },
  );
}

/**
 * "Use the sheet's price" (Inventory → Ingredients, costing spec Phase 6):
 * the costing sheet's price for it becomes its price, exactly as the sheet
 * gives it, through the one price path — a typed ('manual') line in its
 * price history, the batches made from it rolled up, the alerts looked at.
 * Refused when the sheet has no price for it (Rs 0), and for a batch made
 * here whose inputs all have a price (its price comes from its recipe).
 */
export function useSheetPrice(db: AppDatabase, ingredientId: string, actor: Actor): PriceWriteResult {
  const cur = readSheetCols(db, ingredientId);
  if (!cur) throw new Error('Ingredient not found');
  if (cur.sheet_pack_size === null || cur.sheet_pack_price_cents === null) {
    throw new Error(`The costing sheet has no price for ${cur.name} yet. Import the menu file first.`);
  }
  const kind = toPriceKind(cur.sheet_price_kind);
  if (kind === 'unset') throw new Error(`The costing sheet has no price for ${cur.name} (it says Rs 0).`);
  if (loadPriceBook(db).prices.get(ingredientId)?.batch?.complete) {
    throw new Error(
      `${cur.name} is made here, so its price is worked out from its batch recipe. ` +
        "The sheet's figure for it is only a reference.",
    );
  }
  return setIngredientPrice(
    db,
    {
      ingredientId,
      price: { costPerUnitCents: 0, packSize: Number(cur.sheet_pack_size), packPriceCents: Number(cur.sheet_pack_price_cents) },
      priceKind: kind,
      source: 'manual',
      notes: "The costing sheet's price",
    },
    actor,
  );
}

// ---------------------------------------------------------------------------
// The starting price (services/costing-seed.ts)
// ---------------------------------------------------------------------------

/**
 * One 'seed' history row for every live ingredient with no price history
 * yet: the price costing used for it when price history started on this
 * till — its own price, or for a batch whose inputs all have a price, the
 * price rolled up from them (what Reports' estimates used until now, so
 * older takes are priced exactly as before). In force from the start of
 * time (SEED_EFFECTIVE_AT), so it always comes before every real change.
 * Name-based ids: the other till's starting rows are the same rows and
 * settle by id. The ingredients themselves are not touched (nothing
 * already written is rewritten, costing spec section 7). Each row synced
 * and audited; one transaction.
 * Returns how many rows were written (0 the second time).
 */
export function writeSeedPrices(db: AppDatabase, actor: Actor): number {
  return db.transaction((): number => {
    const book = loadPriceBook(db);
    const hasHistory = db.prepare(`SELECT 1 AS x FROM ingredient_costs WHERE ingredient_id = ? LIMIT 1`);
    const now = nowIso();
    let n = 0;
    const ids = [...book.ingredients.keys()].sort();
    for (const ingredientId of ids) {
      const id = seedPriceRowId(ingredientId);
      if (hasHistory.get(ingredientId) !== undefined) continue;
      const ing = book.ingredients.get(ingredientId)!;
      const p = book.prices.get(ingredientId);
      const pack = p?.pack ?? effectivePack(ing);
      const kind = p?.kind ?? ing.priceKind;
      writeCostRow(
        db,
        {
          id,
          ingredientId,
          effectiveAt: SEED_EFFECTIVE_AT,
          unit: ing.unit,
          packSize: pack.size,
          packPriceCents: pack.priceCents,
          priceKind: kind,
          unitCostMc: unitCostMc(pack),
          prevUnitCostMc: null,
          source: 'seed',
          supplierId: null,
          purchaseOrderId: null,
          purchaseOrderItemId: null,
          actorUserId: actor.userId,
          notes: p?.source === 'batch' ? 'Rolled up from its batch recipe' : null,
        },
        actor,
        now,
      );
      n++;
    }
    return n;
  })();
}
