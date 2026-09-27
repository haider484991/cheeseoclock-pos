import type { AppDatabase } from '../db/connection.js';

/**
 * Read-only stock figures for screens outside Inventory (Reports' "running
 * low" note). Moved here from the retired reports-service.ts (costing spec
 * Phase 2): low stock is about this till's own count (current_qty), not a
 * sales report.
 */

export interface LowStockItem {
  ingredientId: string;
  name: string;
  unit: string;
  currentQty: number;
  lowThreshold: number;
}

/** Active ingredients at or under their low-stock level on this till, the furthest under first. */
export function getLowStock(db: AppDatabase): LowStockItem[] {
  return db
    .prepare(
      `SELECT id AS ingredientId, name, unit, current_qty AS currentQty, low_threshold AS lowThreshold
         FROM ingredients
        WHERE deleted_at IS NULL AND is_active = 1 AND current_qty <= low_threshold
        ORDER BY (current_qty - low_threshold), name`,
    )
    .all() as LowStockItem[];
}
