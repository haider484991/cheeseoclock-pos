/**
 * The owner's stock rules (Settings → Kitchen & stock, 'stock.rules'):
 * the waste reasons with their fixed ids, the stock-take reminders and the
 * reorder multiple. Pure: the Settings card, the Waste screen, Reports and
 * the main process all use these, so they say and do the same thing.
 *
 * The variance's own rules (the "Do this" trigger, the bands, the shortest
 * window) are in variance.ts; the stock bar's multiple is stockFill's
 * (stock-level.ts).
 */
import {
  DEFAULT_STOCK_RULES,
  RESERVED_WASTE_REASON_IDS,
  WASTE_REASONS,
  WASTE_REASON_DEFAULT_LABEL,
  type StockRules,
  type StockTakeReminders,
  type WasteReason,
  type WasteReasonId,
  type WasteReasonSetting,
} from '@cheeseoclock/shared-types';
import { tradingDayOfMs } from './trends.js';

/** One of the seven reasons the till was released with (never removed, only renamed or hidden). */
export function isBuiltInWasteReason(id: string): id is WasteReason {
  return (WASTE_REASONS as readonly string[]).includes(id);
}

/** The name a reason was released with; null for one the owner added. */
export function releasedWasteReasonLabel(id: string): string | null {
  return isBuiltInWasteReason(id) ? WASTE_REASON_DEFAULT_LABEL[id] : null;
}

/** The reasons offered on the Waste screen: the owner's list without the hidden ones, in his order. */
export function visibleWasteReasons(reasons: readonly WasteReasonSetting[]): WasteReasonSetting[] {
  return reasons.filter((r) => !r.hidden);
}

/**
 * The owner's names where they are not the released ones (a renamed
 * reason, or one he added), by id; null when every reason has its released
 * name (Reports then look as they always did).
 */
export function ownerWasteLabels(reasons: readonly WasteReasonSetting[]): Record<WasteReasonId, string> | null {
  const out: Record<WasteReasonId, string> = {};
  for (const r of reasons) if (releasedWasteReasonLabel(r.id) !== r.label) out[r.id] = r.label;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The id for a reason the owner adds, made once from its first name
 * ("Spilled on the floor" → "spilled_on_the_floor") and never changed after:
 * later names only change the label. Never one already taken (hidden ones
 * too) or one Reports keep for themselves.
 */
export function newWasteReasonId(label: string, taken: Iterable<string>): WasteReasonId {
  const used = new Set<string>([...taken, ...RESERVED_WASTE_REASON_IDS]);
  let base = label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .replace(/_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `r_${base}`.replace(/_+$/g, '');
  if (base === 'r' || base === '') base = 'reason';
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!used.has(id)) return id;
  }
}

/** Reasons on `before`'s list that `after` no longer has (hiding one is not removing it). */
export function removedWasteReasonIds(
  before: readonly Pick<WasteReasonSetting, 'id'>[],
  after: readonly Pick<WasteReasonSetting, 'id'>[],
): WasteReasonId[] {
  const kept = new Set(after.map((r) => r.id));
  return before.map((r) => r.id).filter((id) => !kept.has(id));
}

/**
 * "Put back the default" for the stock rules: today's numbers and the seven
 * reasons with their released names — and every reason the owner added that
 * waste rows still use (`inUse`), kept HIDDEN, after them: removing it would
 * leave those rows without a name. With none in use this is exactly the
 * default.
 */
export function stockRulesPutBack(current: Pick<StockRules, 'wasteReasons'>, inUse: ReadonlySet<WasteReasonId>): StockRules {
  const kept = current.wasteReasons
    .filter((r) => !isBuiltInWasteReason(r.id) && inUse.has(r.id))
    .map((r) => ({ id: r.id, label: r.label, hidden: true }));
  return {
    ...DEFAULT_STOCK_RULES,
    bands: { ...DEFAULT_STOCK_RULES.bands },
    reminders: { ...DEFAULT_STOCK_RULES.reminders },
    wasteReasons: [...DEFAULT_STOCK_RULES.wasteReasons.map((r) => ({ ...r })), ...kept],
  };
}

// ---------------------------------------------------------------------------
// Stock-take reminders
// ---------------------------------------------------------------------------

/** A stock take the owner asked to be reminded of, now due. */
export interface StockTakeDue {
  scope: 'key_items' | 'full';
  everyDays: number;
  /** When the last one was finished; null: never. */
  lastAt: string | null;
  /** Trading days since it was finished; null: never. */
  daysSince: number | null;
}

/**
 * Which stock takes are due (Settings → Kitchen & stock; both off by
 * default, so nothing is ever due): the key items when the last key-items
 * OR full stock take (a full count covers them) was finished `everyDays`
 * trading days ago or more, or never; a full one likewise. When both are
 * due only the full one is listed — it counts the key items too. Trading
 * days (from 05:00), so "every 7 days" is due on the same weekday a week on.
 */
export function stockTakesDue(
  reminders: StockTakeReminders,
  last: { keyItemsAt: string | null; fullAt: string | null },
  nowMs: number,
): StockTakeDue[] {
  const today = tradingDayOfMs(nowMs);
  const since = (iso: string | null): number | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.max(0, today - tradingDayOfMs(ms)) : null;
  };
  const due = (everyDays: number | null, lastAt: string | null): number | null | undefined => {
    if (everyDays === null) return undefined;
    const d = since(lastAt);
    return d === null || d >= everyDays ? d : undefined;
  };
  const latestOf = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  const out: StockTakeDue[] = [];
  const fullDays = due(reminders.fullEveryDays, last.fullAt);
  if (fullDays !== undefined && reminders.fullEveryDays !== null) {
    out.push({ scope: 'full', everyDays: reminders.fullEveryDays, lastAt: last.fullAt, daysSince: fullDays });
    return out;
  }
  const keyLast = latestOf(last.keyItemsAt, last.fullAt);
  const keyDays = due(reminders.keyItemsEveryDays, keyLast);
  if (keyDays !== undefined && reminders.keyItemsEveryDays !== null) {
    out.push({ scope: 'key_items', everyDays: reminders.keyItemsEveryDays, lastAt: keyLast, daysSince: keyDays });
  }
  return out;
}
