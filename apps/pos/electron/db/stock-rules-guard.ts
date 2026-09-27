/**
 * The waste reasons' one rule the schema can't check on its own: a reason
 * on the SAVED list can be hidden or renamed, never removed (Settings →
 * Kitchen & stock, 'stock.rules'). Rows keep 'waste:<id>' and Reports group
 * by it, so a removed reason would leave them without a name — and counting
 * this till's rows is not enough: the other till may have booked waste with
 * the reason before its rows get here (sync lag, or the link off). A reason
 * added since the last Save is not saved yet, so no till can have used it:
 * that one can still be taken off. Checked in the main process, inside the
 * save's own transaction (business-settings-repo).
 */
import { BUSINESS_SETTING_READ_SCHEMAS } from '@cheeseoclock/shared-schemas';
import { DEFAULT_STOCK_RULES, type StockRules } from '@cheeseoclock/shared-types';
import { removedWasteReasonIds } from '@cheeseoclock/pos-domain';

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
 * Throws, in the owner's words, when `next` would take a saved reason off
 * the list: "“Spilled” is saved, and waste entries on either till may use
 * it, so it can't be removed: hide it instead." `storedJson`: the value
 * saved now (null when nothing is).
 */
export function assertNoSavedWasteReasonRemoved(storedJson: string | null, next: Pick<StockRules, 'wasteReasons'>): void {
  const before = reasonsOf(storedJson);
  const id = removedWasteReasonIds(before, next.wasteReasons)[0];
  if (id === undefined) return;
  const name = before.find((r) => r.id === id)?.label ?? id;
  throw new Error(
    `“${name}” is saved, and waste entries on either till may use it, so it can't be removed: hide it instead (old entries keep its name).`,
  );
}
