/**
 * Settings → Money & discounts: the approval limit and the F3 buttons, as
 * typed ↔ as saved, and in plain words. The main process checks every value
 * again with the key's schema (shared-schemas business-settings.ts); this
 * only says what is wrong before Save, in the same plain words. Every number
 * in the words comes from the values.
 */
import { formatCents, mostOffWithoutManagerCents, requiresManagerApproval } from '@cheeseoclock/pos-domain';
import {
  APPROVAL_MAX_FLAT_CENTS,
  APPROVAL_MAX_PERCENT,
  PRESET_FLAT_MAX_CENTS,
  PRESET_FLATS_MAX,
  PRESET_PERCENTS_MAX,
  PRESET_REASON_MAX_LENGTH,
  PRESET_REASONS_MAX,
  SHOP_SETTING_FORMAT,
  type ApprovalLimits,
  type DiscountApproval,
  type DiscountPresets,
} from '@cheeseoclock/shared-types';
import { centsFromRupeesText } from './foodpandaWords';
import type { Parsed } from './foodpandaForm';

// ---------------------------------------------------------------- limit --

export interface ApprovalForm {
  percent: string;
  rupees: string;
}

export function approvalToForm(a: ApprovalLimits): ApprovalForm {
  return { percent: String(a.percentOver), rupees: String(a.flatOverCents / 100) };
}

const APPROVAL_MAX_RUPEES = formatCents(APPROVAL_MAX_FLAT_CENTS);

export function approvalFromForm(f: ApprovalForm): Parsed<DiscountApproval> {
  const p = f.percent.trim();
  if (!/^\d{1,3}$/.test(p) || Number(p) > APPROVAL_MAX_PERCENT) {
    return { value: null, problem: `The % limit is a whole % from 0 to ${APPROVAL_MAX_PERCENT}.` };
  }
  const cents = centsFromRupeesText(f.rupees);
  if (cents === null || Number.isNaN(cents) || cents > APPROVAL_MAX_FLAT_CENTS) {
    return { value: null, problem: `The rupee limit is whole rupees, Rs 0 to ${APPROVAL_MAX_RUPEES}.` };
  }
  return { value: { v: SHOP_SETTING_FORMAT['discounts.approval'], percentOver: Number(p), flatOverCents: cents }, problem: null };
}

/** One line for History: "Up to 10% or Rs 500 without a manager". */
export function approvalSummary(a: ApprovalLimits): string {
  if (a.percentOver === 0) return 'Every discount needs a manager';
  if (a.flatOverCents === 0) return `Up to ${a.percentOver}% without a manager; any amount in rupees needs one`;
  return `Up to ${a.percentOver}% or ${formatCents(a.flatOverCents)} without a manager`;
}

/** The two made-up orders the worked example uses. */
export const EXAMPLE_SMALL_ORDER_CENTS = 200_000;
export const EXAMPLE_BIG_ORDER_CENTS = 1_000_000;

/**
 * The limit's worked example: "On a Rs 2,000 order a cashier can give up to
 * 10% off, or up to Rs 200 off in rupees, without a manager. On a Rs 10,000
 * order: up to 10% off, or up to Rs 500 off in rupees. Anything more needs a
 * manager's PIN or password."
 */
export function approvalExample(a: ApprovalLimits): string {
  if (a.percentOver === 0) {
    return "With 0%, every discount needs a manager's PIN or password — even 5% or Rs 50 off.";
  }
  const inRupees = (order: number) => {
    const most = mostOffWithoutManagerCents(a, order);
    return most > 0 ? `or up to ${formatCents(most)} off in rupees` : 'but nothing off in rupees';
  };
  return (
    `On a ${formatCents(EXAMPLE_SMALL_ORDER_CENTS)} order a cashier can give up to ${a.percentOver}% off, ${inRupees(EXAMPLE_SMALL_ORDER_CENTS)}, without a manager. ` +
    `On a ${formatCents(EXAMPLE_BIG_ORDER_CENTS)} order: up to ${a.percentOver}% off, ${inRupees(EXAMPLE_BIG_ORDER_CENTS)}. ` +
    "Anything more needs a manager's PIN or password."
  );
}

// -------------------------------------------------------------- buttons --

/** One box per button; an empty box drops that button. */
export interface PresetsForm {
  percents: string[];
  rupees: string[];
  reasons: string[];
}

const pad = (xs: string[], n: number) => [...xs, ...Array.from({ length: Math.max(0, n - xs.length) }, () => '')].slice(0, n);

export function presetsToForm(p: Pick<DiscountPresets, 'percents' | 'flatCents' | 'reasons'>): PresetsForm {
  return {
    percents: pad(p.percents.map(String), PRESET_PERCENTS_MAX),
    rupees: pad(p.flatCents.map((c) => String(c / 100)), PRESET_FLATS_MAX),
    reasons: pad([...p.reasons], PRESET_REASONS_MAX),
  };
}

const PRESET_FLAT_MAX_RUPEES = formatCents(PRESET_FLAT_MAX_CENTS);

export function presetsFromForm(f: PresetsForm): Parsed<DiscountPresets> {
  const percentsText = f.percents.map((t) => t.trim().replace(/%$/, '').trim()).filter((t) => t !== '');
  if (percentsText.length === 0) return { value: null, problem: 'Keep at least one % button.' };
  if (percentsText.some((t) => !/^\d{1,3}$/.test(t) || Number(t) < 1 || Number(t) > 100)) {
    return { value: null, problem: 'A % button is a whole % from 1 to 100.' };
  }
  const percents = percentsText.map(Number);
  if (new Set(percents).size !== percents.length) return { value: null, problem: 'Two % buttons are the same.' };

  const rupeesText = f.rupees.map((t) => t.trim()).filter((t) => t !== '');
  if (rupeesText.length === 0) return { value: null, problem: 'Keep at least one rupee button.' };
  const flatCents = rupeesText.map((t) => centsFromRupeesText(t));
  if (flatCents.some((c) => c === null || Number.isNaN(c) || c < 100 || c > PRESET_FLAT_MAX_CENTS)) {
    return { value: null, problem: `A rupee button is whole rupees, Rs 1 to ${PRESET_FLAT_MAX_RUPEES}.` };
  }
  const flats = flatCents as number[];
  if (new Set(flats).size !== flats.length) return { value: null, problem: 'Two rupee buttons are the same.' };

  const reasons = f.reasons.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t !== '');
  if (reasons.length === 0) return { value: null, problem: 'Keep at least one reason button.' };
  if (reasons.some((r) => r.length > PRESET_REASON_MAX_LENGTH)) {
    return { value: null, problem: `Keep a reason to ${PRESET_REASON_MAX_LENGTH} letters.` };
  }
  if (new Set(reasons.map((r) => r.toLowerCase())).size !== reasons.length) {
    return { value: null, problem: 'Two reason buttons are the same.' };
  }
  return {
    value: {
      v: SHOP_SETTING_FORMAT['discounts.presets'],
      percents: percents.slice(0, PRESET_PERCENTS_MAX),
      flatCents: flats.slice(0, PRESET_FLATS_MAX),
      reasons: reasons.slice(0, PRESET_REASONS_MAX),
    },
    problem: null,
  };
}

/** One line for History: "10, 20, 25, 50, 100% · Rs 100, Rs 200, Rs 500 · Staff, Friends & family…". */
export function presetsSummary(p: Pick<DiscountPresets, 'percents' | 'flatCents' | 'reasons'>): string {
  return `${p.percents.join(', ')}% · ${p.flatCents.map((c) => formatCents(c)).join(', ')} · ${p.reasons.join(', ')}`;
}

/** A button as the F3 screen would show it on the example order: what it takes off, and the lock. */
export interface PresetPreview {
  label: string;
  offCents: number;
  locked: boolean;
}

/**
 * The buttons on the made-up Rs 2,000 order, each with what it takes off and
 * whether the F3 screen shows the lock (the same rule as the till's:
 * requiresManagerApproval with the saved limit).
 */
export function presetPreview(
  p: Pick<DiscountPresets, 'percents' | 'flatCents'>,
  limits: ApprovalLimits,
  orderCents = EXAMPLE_SMALL_ORDER_CENTS,
): { percent: PresetPreview[]; flat: PresetPreview[] } {
  return {
    percent: p.percents.map((pct) => ({
      label: `${pct}%`,
      offCents: Math.round((orderCents * Math.min(100, pct)) / 100),
      locked: requiresManagerApproval({ type: 'percent', value: pct }, orderCents, limits),
    })),
    flat: p.flatCents.map((c) => ({
      label: formatCents(c),
      offCents: Math.min(c, orderCents),
      locked: requiresManagerApproval({ type: 'flat', value: c }, orderCents, limits),
    })),
  };
}
