/**
 * Reading the price history (ingredient_costs, migration 0034): one
 * ingredient's entries for the Price history drawer, every ingredient's
 * newest entry for the Ingredients list, and "the price in force at a time"
 * for Reports' estimates (costing spec 4.5, Phase 4).
 *
 * Read-only, and free of Electron and of every write path: the Reports
 * worker thread (services/analytics/worker.ts) loads this file too, on its
 * own read-only connection. Writing a price is ingredient-cost-repo's alone.
 */
import {
  knownPrices,
  priceInForce,
  toPriceKind,
  type Pack,
} from '@cheeseoclock/pos-domain';
import {
  PRICE_SOURCES,
  type IngredientPriceTag,
  type PriceHistoryEntry,
  type PriceKind,
  type PriceSource,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';

/** A stored source as the type; anything unknown (a newer till's) reads as 'manual'. */
export function toPriceSource(v: string | null | undefined): PriceSource {
  return (PRICE_SOURCES as readonly string[]).includes(v ?? '') ? (v as PriceSource) : 'manual';
}

interface CostRow {
  id: string;
  ingredient_id: string;
  effective_at: string;
  unit: string;
  pack_size: number;
  pack_price_cents: number;
  price_kind: string;
  unit_cost_mc: number;
  prev_unit_cost_mc: number | null;
  source: string;
  created_at: string;
}

const COST_COLUMNS = `c.id, c.ingredient_id, c.effective_at, c.unit, c.pack_size, c.pack_price_cents, c.price_kind,
  c.unit_cost_mc, c.prev_unit_cost_mc, c.source, c.created_at`;

function tagOf(r: CostRow): IngredientPriceTag {
  return {
    source: toPriceSource(r.source),
    effectiveAt: r.effective_at,
    unit: r.unit,
    packSize: Number(r.pack_size),
    packPriceCents: Number(r.pack_price_cents),
    priceKind: toPriceKind(r.price_kind),
    unitCostMc: Number(r.unit_cost_mc),
    prevUnitCostMc: r.prev_unit_cost_mc === null ? null : Number(r.prev_unit_cost_mc),
  };
}

/**
 * One ingredient's price history, newest first, with who / which supplier /
 * which purchase order by name (idx_ingredient_costs_ingredient_time).
 */
export function listPriceHistory(db: AppDatabase, ingredientId: string, limit = 200): PriceHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT ${COST_COLUMNS}, c.supplier_id, c.ref_purchase_order_id, c.actor_user_id, c.notes,
              s.name AS supplier_name, po.reference_no AS po_ref, u.full_name AS actor_name
         FROM ingredient_costs c
         LEFT JOIN suppliers s ON s.id = c.supplier_id
         LEFT JOIN purchase_orders po ON po.id = c.ref_purchase_order_id
         LEFT JOIN users u ON u.id = c.actor_user_id
        WHERE c.ingredient_id = ? AND c.deleted_at IS NULL
        ORDER BY c.effective_at DESC, c.rowid DESC
        LIMIT ?`,
    )
    .all(ingredientId, Math.max(1, Math.min(500, Math.floor(limit)))) as Array<
    CostRow & {
      supplier_id: string | null;
      ref_purchase_order_id: string | null;
      actor_user_id: string | null;
      notes: string | null;
      supplier_name: string | null;
      po_ref: string | null;
      actor_name: string | null;
    }
  >;
  return rows.map((r) => ({
    ...tagOf(r),
    recordedAt: r.created_at,
    id: r.id as PriceHistoryEntry['id'],
    ingredientId: r.ingredient_id as PriceHistoryEntry['ingredientId'],
    supplierId: r.supplier_id as PriceHistoryEntry['supplierId'],
    supplierName: r.supplier_name,
    purchaseOrderId: r.ref_purchase_order_id as PriceHistoryEntry['purchaseOrderId'],
    purchaseOrderRef: r.ref_purchase_order_id ? (r.po_ref ?? r.ref_purchase_order_id.slice(0, 8)) : null,
    actorUserId: r.actor_user_id as PriceHistoryEntry['actorUserId'],
    actorName: r.actor_name,
    notes: r.notes,
  }));
}

/** Every ingredient's newest price history entry (for the Ingredients list), by ingredient id. */
export function latestPriceTags(db: AppDatabase): Map<string, IngredientPriceTag> {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT ${COST_COLUMNS},
                ROW_NUMBER() OVER (PARTITION BY c.ingredient_id ORDER BY c.effective_at DESC, c.rowid DESC) AS rn
           FROM ingredient_costs c
          WHERE c.deleted_at IS NULL)
        WHERE rn = 1`,
    )
    .all() as CostRow[];
  return new Map(rows.map((r) => [r.ingredient_id, tagOf(r)]));
}

/** A price from the history: the pack as it was kept, in the unit it was kept in. */
export interface DatedPrice {
  effectiveAt: string;
  unit: string;
  pack: Pack;
  kind: PriceKind;
}

export interface PriceHistoryBook {
  /**
   * The KNOWN price of an ingredient in force at `atIso` (pos-domain
   * knownPriceInForce): the latest entry with a price at or before it, else
   * its earliest entry with a price — older takes use the starting price,
   * and an ingredient still unpriced when the history started uses the
   * first price it was given. Undefined when no entry has a price (the
   * caller then uses the price now).
   */
  priceAt(ingredientId: string, atIso: string): DatedPrice | undefined;
}

/**
 * Every ingredient's price history, oldest first, for looking prices up by
 * date (Reports' estimates). One read of a small table: a row per price
 * change, not per sale.
 */
export function loadPriceHistory(db: AppDatabase): PriceHistoryBook {
  const rows = db
    .prepare(
      `SELECT ingredient_id, effective_at, unit, pack_size, pack_price_cents, price_kind
         FROM ingredient_costs
        WHERE deleted_at IS NULL
        ORDER BY ingredient_id, effective_at, rowid`,
    )
    .all() as Array<Pick<CostRow, 'ingredient_id' | 'effective_at' | 'unit' | 'pack_size' | 'pack_price_cents' | 'price_kind'>>;
  const byIngredient = new Map<string, DatedPrice[]>();
  for (const r of rows) {
    let list = byIngredient.get(r.ingredient_id);
    if (!list) byIngredient.set(r.ingredient_id, (list = []));
    list.push({
      effectiveAt: r.effective_at,
      unit: r.unit,
      pack: { size: Number(r.pack_size), priceCents: Number(r.pack_price_cents) },
      kind: toPriceKind(r.price_kind),
    });
  }
  // Only the entries with a price, once (knownPriceInForce's rule, without filtering per take).
  const known = new Map([...byIngredient].map(([id, list]) => [id, knownPrices(list)]));
  return { priceAt: (id, at) => priceInForce(known.get(id) ?? [], at) };
}
