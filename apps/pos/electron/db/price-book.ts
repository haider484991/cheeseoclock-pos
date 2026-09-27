/**
 * Every live ingredient's price as costing uses it (costing spec 4.1): the
 * stored price, or for a batch the price rolled up from its inputs now.
 * Read-only — two queries, then pos-domain effectivePrices. Shared by the
 * Costing page (services/costing-service.ts) and the batch recipe screen
 * (batch-recipe-repo getBatchRecipe), so both show the same figure.
 */
import {
  effectivePrices,
  toPriceKind,
  type BatchInputLine,
  type EffectivePrice,
  type PricedIngredient,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from './connection.js';

export interface BookIngredient extends PricedIngredient {
  currentQty: number;
}

export interface PriceBook {
  ingredients: Map<string, BookIngredient>;
  /** Batch recipe inputs per made-in-house ingredient, in the recipe's order. */
  batchLines: Map<string, BatchInputLine[]>;
  prices: Map<string, EffectivePrice>;
}

export function loadPriceBook(db: AppDatabase): PriceBook {
  const rows = db
    .prepare(
      `SELECT id, name, unit, price_kind, cost_per_unit_cents, pack_size, pack_price_cents, batch_yield, current_qty
         FROM ingredients WHERE deleted_at IS NULL`,
    )
    .all() as Array<{
    id: string;
    name: string;
    unit: string;
    price_kind: string;
    cost_per_unit_cents: number;
    pack_size: number | null;
    pack_price_cents: number | null;
    batch_yield: number | null;
    current_qty: number;
  }>;
  const ingredients = new Map<string, BookIngredient>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        unit: r.unit,
        priceKind: toPriceKind(r.price_kind),
        costPerUnitCents: r.cost_per_unit_cents,
        packSize: r.pack_size,
        packPriceCents: r.pack_price_cents,
        batchYield: r.batch_yield,
        currentQty: r.current_qty,
      },
    ]),
  );
  // A line whose input was deleted is kept: it reads as unpriced (incomplete), not as nothing.
  const lines = db
    .prepare(
      `SELECT ingredient_id, input_ingredient_id, qty FROM batch_recipe_lines
        WHERE deleted_at IS NULL ORDER BY ingredient_id, sort_order, rowid`,
    )
    .all() as Array<{ ingredient_id: string; input_ingredient_id: string; qty: number }>;
  const batchLines = new Map<string, BatchInputLine[]>();
  for (const l of lines) {
    if (!ingredients.has(l.ingredient_id)) continue;
    let list = batchLines.get(l.ingredient_id);
    if (!list) batchLines.set(l.ingredient_id, (list = []));
    list.push({ inputId: l.input_ingredient_id, qty: l.qty });
  }
  return { ingredients, batchLines, prices: effectivePrices([...ingredients.values()], batchLines) };
}
