/**
 * Price alerts (costing spec Phase 6): when a price change is worth telling
 * the owner about, in the rules' own words, pure so they are tested.
 *
 *  - A KEY ingredient (cheese, chicken, patties, dough, oil, boxes — or
 *    whatever the owner picks) whose price moves more than the jump
 *    threshold (default 10%, the same figure as D1's purchase guard), or a
 *    key batch made from it that moves that much with it: an alert.
 *  - ANY price change whose effect on the menu comes to at least the weekly
 *    threshold (default Rs 1,000 a week at this till's sales): an alert.
 *  - Nothing else: a small change to a minor ingredient stays quiet.
 * The band changes (a dish moving over its target) go in the Monday digest,
 * with a 1-point margin (plate-cost bandWithHysteresis).
 */
import type { CostAlertSettings } from '@cheeseoclock/shared-types';
import { PRICE_GUARD_BPS } from './purchase.js';

/** A key ingredient's price moving more than this is an alert (and D1's guard asks): 10%. */
export const DEFAULT_ALERT_JUMP_BPS = PRICE_GUARD_BPS;
/** A price change costing at least this much a week is an alert: Rs 1,000. */
export const DEFAULT_ALERT_IMPACT_WEEK_CENTS = 100_000;

/**
 * The key ingredients the till suggests by name until the owner picks
 * (costing spec, owner question for Phase 8: mozzarella / Cheese Mix,
 * chicken, patties, dough / flour, oil and boxes).
 */
const KEY_NAME = /\b(mozzarella|cheese\s*mix|chicken|patt(?:y|ies)|dough|flour|oil|box(?:es)?)\b/i;

export function suggestedKeyIngredient(name: string): boolean {
  return KEY_NAME.test(name);
}

export interface ResolvedAlertSettings {
  jumpBps: number;
  impactWeekCents: number;
  keyIds: ReadonlySet<string>;
  /** Nothing saved: the key ingredients are the suggestions by name. */
  keysSuggested: boolean;
}

/** The thresholds in force: what was saved, or the defaults with the suggested key ingredients. */
export function resolveAlertSettings(
  saved: CostAlertSettings | null,
  ingredients: Iterable<{ id: string; name: string }>,
): ResolvedAlertSettings {
  if (saved) {
    return {
      jumpBps: saved.jumpBps,
      impactWeekCents: saved.impactWeekCents,
      keyIds: new Set(saved.keyIngredientIds),
      keysSuggested: false,
    };
  }
  const keyIds = new Set<string>();
  for (const i of ingredients) if (suggestedKeyIngredient(i.name)) keyIds.add(i.id);
  return { jumpBps: DEFAULT_ALERT_JUMP_BPS, impactWeekCents: DEFAULT_ALERT_IMPACT_WEEK_CENTS, keyIds, keysSuggested: true };
}

/** A move of more than the threshold, either way (null = nothing to compare with: never a jump). */
export function isPriceJump(changeBps: number | null, jumpBps: number): boolean {
  return changeBps !== null && Math.abs(changeBps) > jumpBps;
}

/**
 * Whether a price change is an alert: a key ingredient (or a key batch made
 * from it) jumped, or what it does to the menu comes to at least the weekly
 * threshold either way. A change that moves nothing on the menu is never
 * one on the weekly rule, even with a threshold of Rs 0.
 */
export function priceChangeAlerts(x: { keyJump: boolean; impactWeekCents: number }, s: { impactWeekCents: number }): boolean {
  if (x.keyJump) return true;
  const impact = Math.abs(x.impactWeekCents);
  return impact > 0 && impact >= s.impactWeekCents;
}

/**
 * The trading week a moment falls in, as its Monday (YYYY-MM-DD). The
 * trading day is the UTC date (05:00 PKT to 04:59), and weeks start on
 * Monday (Reports' dateRange), so the Monday digest is due from 05:00 PKT.
 */
export function tradingWeekOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('Not a date');
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - sinceMonday);
  return day.toISOString().slice(0, 10);
}
