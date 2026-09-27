/**
 * The waste reasons' one rule the schema can't check on its own: a reason
 * that waste rows use can be hidden, never removed (Settings → Kitchen &
 * stock, 'stock.rules'). Rows keep 'waste:<id>' and Reports group by it, so
 * a removed reason would leave them without a name. Checked in the main
 * process, inside the save's own transaction (business-settings-repo), so
 * a waste row booked a moment before the save still counts.
 */
import { BUSINESS_SETTING_READ_SCHEMAS } from '@cheeseoclock/shared-schemas';
import { DEFAULT_STOCK_RULES, type StockRules, type WasteReasonId } from '@cheeseoclock/shared-types';
import { removedWasteReasonIds } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from './connection.js';

/** How many live waste rows (every till's) keep each of these reasons. */
export function wasteReasonUse(db: AppDatabase, ids: readonly WasteReasonId[]): Map<WasteReasonId, number> {
  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'waste' AND detail = ? AND deleted_at IS NULL`,
  );
  return new Map(ids.map((id) => [id, Number((count.get(`waste:${id}`) as { n: number } | undefined)?.n ?? 0)]));
}

/** The reasons of a stored 'stock.rules' value (its raw JSON), or the released seven when none reads. */
function reasonsOf(storedJson: string | null): StockRules['wasteReasons'] {
  if (storedJson === null) return DEFAULT_STOCK_RULES.wasteReasons;
  try {
    const parsed = BUSINESS_SETTING_READ_SCHEMAS['stock.rules'].safeParse(JSON.parse(storedJson));
    return parsed.success ? parsed.data.wasteReasons : DEFAULT_STOCK_RULES.wasteReasons;
  } catch {
    return DEFAULT_STOCK_RULES.wasteReasons;
  }
}

/**
 * Throws, in the owner's words, when `next` would remove a reason waste
 * rows still use: "“Spilled” is on 3 waste entries, so it can't be
 * removed: hide it instead." `storedJson`: the value saved now (null when
 * nothing is).
 */
export function assertNoUsedWasteReasonRemoved(db: AppDatabase, storedJson: string | null, next: Pick<StockRules, 'wasteReasons'>): void {
  const before = reasonsOf(storedJson);
  const removed = removedWasteReasonIds(before, next.wasteReasons);
  if (removed.length === 0) return;
  const use = wasteReasonUse(db, removed);
  for (const id of removed) {
    const n = use.get(id) ?? 0;
    if (n > 0) {
      const name = before.find((r) => r.id === id)?.label ?? id;
      throw new Error(
        `“${name}” is on ${n} waste ${n === 1 ? 'entry' : 'entries'}, so it can't be removed: hide it instead (old entries keep its name).`,
      );
    }
  }
}
