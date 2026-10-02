/**
 * Settings → Staff & kitchen timing: what is typed ↔ the setting's value.
 * Each field is a whole number within the owner's bounds (shared-types
 * STAFF_TIMING_BOUNDS / KITCHEN_TIMING_BOUNDS, the same ones the main process
 * checks with the key's schema); this only says what is wrong before Save.
 */
import {
  KITCHEN_TIMING_BOUNDS,
  SHOP_SETTING_FORMAT,
  STAFF_TIMING_BOUNDS,
  type KitchenTiming,
  type StaffTiming,
} from '@cheeseoclock/shared-types';
import type { Parsed } from './foodpandaForm';

type StaffField = Exclude<keyof StaffTiming, 'v'>;
type KitchenField = Exclude<keyof KitchenTiming, 'v'>;

export type StaffTimingForm = Record<StaffField, string>;
export type KitchenTimingForm = Record<KitchenField, string>;

/** Each field in words, for the labels and the problems, and its unit. */
export const STAFF_FIELDS: ReadonlyArray<{ field: StaffField; label: string; unit: string; help: string }> = [
  {
    field: 'idleLogoutMin',
    label: 'Sign out an idle owner or manager after',
    unit: 'minutes',
    help: 'Nobody touching the till for this long ends an owner or manager login. It can’t be switched off. Cashiers are never signed out for being idle.',
  },
  {
    field: 'maxLoginHours',
    label: 'Longest a login lasts',
    unit: 'hours',
    help: 'Every login, cashiers’ too, ends this long after it began; they sign in again.',
  },
  {
    field: 'stepInMin',
    label: 'A manager stepping in gets',
    unit: 'minutes',
    help: 'A manager or the owner signing in on a till a cashier was just using. Then the till asks for their PIN again, or they hand back to the cashier.',
  },
  {
    field: 'freeReprints',
    label: 'Free reprints of a paid receipt',
    unit: 'copies',
    help: 'What a cashier may print again by hand for the order in front of them. More needs a manager. 0 = every copy needs a manager. The copy that adds the FBR number, when the receipt first printed without it, is always free and never counted.',
  },
  {
    field: 'reprintWindowMin',
    label: 'Free reprints only within',
    unit: 'minutes of the sale',
    help: 'After this an order is “older”: a cashier needs a manager to print it again. Orders still on Live Orders always count.',
  },
];

export const KITCHEN_FIELDS: ReadonlyArray<{ field: KitchenField; label: string; unit: string; help: string }> = [
  { field: 'amberMin', label: 'Card turns amber after', unit: 'minutes', help: 'On Live Orders, counted from when the order was sent to the kitchen.' },
  { field: 'redMin', label: 'Card turns red after', unit: 'minutes', help: 'More than amber. The header counts the red ones.' },
  {
    field: 'notStartedMin',
    label: '“Not started” reminder after',
    unit: 'minutes',
    help: 'A website order still in New this long after it came in gets a soft beep and a note.',
  },
  {
    field: 'notDoneMin',
    label: '“Not done” reminder after',
    unit: 'minutes',
    help: 'More than “not started”. An order still in New, Preparing or Ready this long gets another.',
  },
];

function wholeIn(text: string, [lo, hi]: readonly [number, number]): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= lo && n <= hi ? n : null;
}

export function staffToForm(t: StaffTiming): StaffTimingForm {
  return {
    idleLogoutMin: String(t.idleLogoutMin),
    maxLoginHours: String(t.maxLoginHours),
    stepInMin: String(t.stepInMin),
    freeReprints: String(t.freeReprints),
    reprintWindowMin: String(t.reprintWindowMin),
  };
}

export function staffFromForm(f: StaffTimingForm): Parsed<StaffTiming> {
  const out: Partial<Record<StaffField, number>> = {};
  for (const { field, label, unit } of STAFF_FIELDS) {
    const bounds = STAFF_TIMING_BOUNDS[field];
    const n = wholeIn(f[field], bounds);
    if (n === null) return { value: null, problem: `${label}: a whole number from ${bounds[0]} to ${bounds[1]} ${unit.split(' ')[0]}.` };
    out[field] = n;
  }
  const v = out as Record<StaffField, number>;
  return { value: { v: SHOP_SETTING_FORMAT['staff.timing'], ...v }, problem: null };
}

export function kitchenToForm(t: KitchenTiming): KitchenTimingForm {
  return {
    amberMin: String(t.amberMin),
    redMin: String(t.redMin),
    notStartedMin: String(t.notStartedMin),
    notDoneMin: String(t.notDoneMin),
  };
}

export function kitchenFromForm(f: KitchenTimingForm): Parsed<KitchenTiming> {
  const out: Partial<Record<KitchenField, number>> = {};
  for (const { field, label, unit } of KITCHEN_FIELDS) {
    const bounds = KITCHEN_TIMING_BOUNDS[field];
    const n = wholeIn(f[field], bounds);
    if (n === null) return { value: null, problem: `${label}: a whole number from ${bounds[0]} to ${bounds[1]} ${unit}.` };
    out[field] = n;
  }
  const v = out as Record<KitchenField, number>;
  if (v.redMin <= v.amberMin) return { value: null, problem: 'A card turns red after it turns amber: give red more minutes.' };
  if (v.notDoneMin <= v.notStartedMin) {
    return { value: null, problem: 'The “not done” reminder comes after “not started”: give it more minutes.' };
  }
  return { value: { v: SHOP_SETTING_FORMAT['kitchen.timing'], ...v }, problem: null };
}
