/**
 * Settings → Kitchen & stock, the stock rules card: what is typed ↔ the
 * 'stock.rules' value, and the waste-reason list's edits. The bounds are the
 * owner's (shared-types STOCK_RULE_BOUNDS, the same ones the main process
 * checks with the key's schema); this only says what is wrong before Save.
 * A reason's id is made once, from its first name, and never changes: a
 * rename changes only the label, so old waste rows follow it.
 */
import { newWasteReasonId, isBuiltInWasteReason } from '@cheeseoclock/pos-domain';
import {
  SHOP_SETTING_FORMAT,
  STOCK_RULE_BOUNDS,
  STOCK_RULE_BPS_STEP,
  WASTE_REASONS_MAX,
  WASTE_REASON_LABEL_MAX,
  type StockRules,
  type WasteReasonSetting,
} from '@cheeseoclock/shared-types';
import type { Parsed } from './foodpandaForm';

export interface StockRulesForm {
  /** "Do this" from over this % of food sales. */
  doThis: string;
  good: string;
  ok: string;
  needsWork: string;
  minWindowDays: string;
  keyItemsOn: boolean;
  keyItemsDays: string;
  fullOn: boolean;
  fullDays: string;
  reorderMultiple: string;
  reasons: WasteReasonSetting[];
}

/** What a reminder's days box shows while it is off (a suggestion, not saved). */
export const SUGGESTED_KEY_ITEMS_DAYS = 7;
export const SUGGESTED_FULL_DAYS = 30;

/** 250 → "2.5", 300 → "3". */
export function pctText(bps: number): string {
  return String(bps / 100);
}

export function stockRulesToForm(r: StockRules): StockRulesForm {
  return {
    doThis: pctText(r.varianceDoThisBps),
    good: pctText(r.bands.goodUnderBps),
    ok: pctText(r.bands.okUpToBps),
    needsWork: pctText(r.bands.needsWorkUpToBps),
    minWindowDays: String(r.varianceMinWindowDays),
    keyItemsOn: r.reminders.keyItemsEveryDays !== null,
    keyItemsDays: String(r.reminders.keyItemsEveryDays ?? SUGGESTED_KEY_ITEMS_DAYS),
    fullOn: r.reminders.fullEveryDays !== null,
    fullDays: String(r.reminders.fullEveryDays ?? SUGGESTED_FULL_DAYS),
    reorderMultiple: String(r.reorderMultiple),
    reasons: r.wasteReasons.map((x) => ({ id: x.id, label: x.label, hidden: x.hidden })),
  };
}

/** A share as typed ("3", "2.5", "2.5%") → basis points in tenths of a %, within the bounds; null otherwise. */
export function bpsFromShareText(text: string, [lo, hi]: readonly [number, number]): number | null {
  const t = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,2}(\.\d)?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= lo && bps <= hi && bps % STOCK_RULE_BPS_STEP === 0 ? bps : null;
}

function wholeIn(text: string, [lo, hi]: readonly [number, number]): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= lo && n <= hi ? n : null;
}

const pctRange = ([lo, hi]: readonly [number, number]) => `${lo / 100}% to ${hi / 100}%`;

export function stockRulesFromForm(f: StockRulesForm): Parsed<StockRules> {
  const fail = (problem: string): Parsed<StockRules> => ({ value: null, problem });
  const doThis = bpsFromShareText(f.doThis, STOCK_RULE_BOUNDS.varianceDoThisBps);
  if (doThis === null) return fail(`“Do this” from: ${pctRange(STOCK_RULE_BOUNDS.varianceDoThisBps)}, at most one decimal.`);
  const band = STOCK_RULE_BOUNDS.bandBps;
  const good = bpsFromShareText(f.good, band);
  const ok = bpsFromShareText(f.ok, band);
  const needsWork = bpsFromShareText(f.needsWork, band);
  if (good === null || ok === null || needsWork === null) return fail(`Each rating is ${pctRange(band)}, at most one decimal.`);
  if (!(good < ok && ok < needsWork)) return fail('The ratings go up in order: Good, then OK, then Needs work.');
  const minWindowDays = wholeIn(f.minWindowDays, STOCK_RULE_BOUNDS.varianceMinWindowDays);
  if (minWindowDays === null) {
    const [lo, hi] = STOCK_RULE_BOUNDS.varianceMinWindowDays;
    return fail(`The shortest stretch between stock takes: ${lo} to ${hi} days.`);
  }
  let keyItemsEveryDays: number | null = null;
  if (f.keyItemsOn) {
    keyItemsEveryDays = wholeIn(f.keyItemsDays, STOCK_RULE_BOUNDS.keyItemsEveryDays);
    if (keyItemsEveryDays === null) {
      const [lo, hi] = STOCK_RULE_BOUNDS.keyItemsEveryDays;
      return fail(`The key-items reminder: every ${lo} to ${hi} days.`);
    }
  }
  let fullEveryDays: number | null = null;
  if (f.fullOn) {
    fullEveryDays = wholeIn(f.fullDays, STOCK_RULE_BOUNDS.fullEveryDays);
    if (fullEveryDays === null) {
      const [lo, hi] = STOCK_RULE_BOUNDS.fullEveryDays;
      return fail(`The full stock take reminder: every ${lo} to ${hi} days.`);
    }
  }
  const reorderMultiple = wholeIn(f.reorderMultiple, STOCK_RULE_BOUNDS.reorderMultiple);
  if (reorderMultiple === null) {
    const [lo, hi] = STOCK_RULE_BOUNDS.reorderMultiple;
    return fail(`A full stock bar: ${lo} to ${hi} times the low level.`);
  }
  const reasonProblem = wasteReasonsProblem(f.reasons);
  if (reasonProblem) return fail(reasonProblem);
  return {
    value: {
      v: SHOP_SETTING_FORMAT['stock.rules'],
      varianceDoThisBps: doThis,
      bands: { goodUnderBps: good, okUpToBps: ok, needsWorkUpToBps: needsWork },
      varianceMinWindowDays: minWindowDays,
      reminders: { keyItemsEveryDays, fullEveryDays },
      reorderMultiple,
      wasteReasons: f.reasons.map((r) => ({ id: r.id, label: r.label.trim(), hidden: r.hidden })),
    },
    problem: null,
  };
}

/** What is wrong with the waste reasons as typed, in plain words; null when nothing is. */
export function wasteReasonsProblem(reasons: readonly WasteReasonSetting[]): string | null {
  const seen = new Set<string>();
  for (const r of reasons) {
    const label = r.label.trim();
    if (label === '') return 'A waste reason needs a name.';
    if (label.length > WASTE_REASON_LABEL_MAX) return `Keep a waste reason to ${WASTE_REASON_LABEL_MAX} letters.`;
    if (/[\r\n\t]/.test(label)) return 'A waste reason is one line.';
    const key = label.toLowerCase();
    if (seen.has(key)) return `Two waste reasons are called “${label}”.`;
    seen.add(key);
  }
  if (reasons.length > WASTE_REASONS_MAX) return `At most ${WASTE_REASONS_MAX} waste reasons, hidden ones included.`;
  if (!reasons.some((r) => !r.hidden)) return 'Keep at least one waste reason on the Waste screen.';
  return null;
}

/**
 * A reason the owner adds: its id made from the name (fixed from now on),
 * shown on the Waste screen, put before "Other" when Other is last.
 */
export function addWasteReason(reasons: readonly WasteReasonSetting[], label: string): WasteReasonSetting[] {
  const name = label.trim();
  const added: WasteReasonSetting = { id: newWasteReasonId(name, reasons.map((r) => r.id)), label: name, hidden: false };
  const last = reasons[reasons.length - 1];
  return last?.id === 'other' ? [...reasons.slice(0, -1), added, last] : [...reasons, added];
}

/** A new name: the id stays, so every old waste row shows the new name. */
export function renameWasteReason(reasons: readonly WasteReasonSetting[], id: string, label: string): WasteReasonSetting[] {
  return reasons.map((r) => (r.id === id ? { ...r, label } : r));
}

/** Hide from the Waste screen (old rows keep the name in Reports and the history), or show again. */
export function setWasteReasonHidden(reasons: readonly WasteReasonSetting[], id: string, hidden: boolean): WasteReasonSetting[] {
  return reasons.map((r) => (r.id === id ? { ...r, hidden } : r));
}

/**
 * Take a reason the owner added off the list. The till's own seven can't be
 * (hide them instead); a reason that old waste entries use is refused by
 * the main process on Save ("hide it instead").
 */
export function removeWasteReason(reasons: readonly WasteReasonSetting[], id: string): WasteReasonSetting[] {
  return isBuiltInWasteReason(id) ? [...reasons] : reasons.filter((r) => r.id !== id);
}

/** Two stock-rules values are the same, whatever order their fields were written in. */
export function sameStockRules(a: StockRules, b: StockRules): boolean {
  const canon = (v: unknown): string =>
    JSON.stringify(v, (_k, x: unknown) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)))
        : x,
    );
  return canon(a) === canon(b);
}
