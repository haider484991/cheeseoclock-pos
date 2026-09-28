/**
 * Settings → Staff & kitchen → Reason buttons ('orders.reasons'): what is
 * typed ↔ the setting's value, and its words. Pure. The bounds are
 * shared-types' (ORDER_REASONS_MAX, CASH_OUT_REASONS_MAX,
 * ORDER_REASON_LABEL_MAX), the same the main process checks with the key's
 * schema; this only says what is wrong before Save.
 *
 * A button's words are what gets SAVED on the order (or the drawer row) when
 * it is tapped, as if typed: renaming or removing a button never changes a
 * row already saved, and Team & leakage keeps listing old rows by their own
 * words. Any other reason can still be typed, and a reason and the
 * manager's PIN are still needed for every cancel and refund.
 */
import {
  CASH_OUT_REASONS_MAX,
  ORDER_REASON_LABEL_MAX,
  ORDER_REASONS_MAX,
  SHOP_SETTING_FORMAT,
  type OrderReasonButton,
  type OrderReasons,
  type ReasonFoodAnswer,
} from '@cheeseoclock/shared-types';
import { unprintableChars } from '@cheeseoclock/printer-core';
import type { Parsed } from './foodpandaForm';

export interface ReasonsForm {
  cancel: OrderReasonButton[];
  refund: OrderReasonButton[];
  cashOut: string[];
}

export type ReasonList = 'cancel' | 'refund';

/** What each food answer says, on the card. */
export const FOOD_ANSWER_WORDS: Readonly<Record<ReasonFoodAnswer, string>> = Object.freeze({
  ask: 'Ask: staff tap Made or Not made',
  made: 'Says the food was made',
  not_made: 'Says the food was not made',
});

export function reasonsToForm(r: OrderReasons): ReasonsForm {
  return {
    cancel: r.cancel.map((b) => ({ ...b })),
    refund: r.refund.map((b) => ({ ...b })),
    cashOut: [...r.cashOut],
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function labelProblem(label: string, what: string): string | null {
  if (label === '') return `${what} needs words.`;
  if (label.length > ORDER_REASON_LABEL_MAX) return `Keep ${what.toLowerCase()} to ${ORDER_REASON_LABEL_MAX} letters: “${label}”.`;
  if (CONTROL_CHARS.test(label)) return `${what} is one line of plain words.`;
  return null;
}

function listProblem(labels: readonly string[], what: string): string | null {
  const seen = new Set<string>();
  for (const l of labels) {
    const key = l.toLowerCase();
    if (seen.has(key)) return `Two ${what} say “${l}”.`;
    seen.add(key);
  }
  return null;
}

export function reasonsFromForm(f: ReasonsForm): Parsed<OrderReasons> {
  const fail = (problem: string): Parsed<OrderReasons> => ({ value: null, problem });
  const lists: Record<ReasonList, OrderReasonButton[]> = { cancel: [], refund: [] };
  for (const which of ['cancel', 'refund'] as const) {
    const name = which === 'cancel' ? 'Cancel' : 'Refund';
    const buttons = f[which].map((b) => ({ id: b.id, label: b.label.trim(), food: b.food }));
    if (buttons.length === 0) return fail(`Keep at least one ${name} button.`);
    if (buttons.length > ORDER_REASONS_MAX) return fail(`At most ${ORDER_REASONS_MAX} ${name} buttons.`);
    for (const b of buttons) {
      const p = labelProblem(b.label, `A ${name} button`);
      if (p) return fail(p);
    }
    const dup = listProblem(buttons.map((b) => b.label), `${name} buttons`);
    if (dup) return fail(dup);
    lists[which] = buttons;
  }
  const cashOut = f.cashOut.map((l) => l.trim());
  if (cashOut.length > CASH_OUT_REASONS_MAX) return fail(`At most ${CASH_OUT_REASONS_MAX} Cash out buttons.`);
  for (const l of cashOut) {
    const p = labelProblem(l, 'A Cash out button');
    if (p) return fail(p);
  }
  const dup = listProblem(cashOut, 'Cash out buttons');
  if (dup) return fail(dup);
  return { value: { v: SHOP_SETTING_FORMAT['orders.reasons'], cancel: lists.cancel, refund: lists.refund, cashOut }, problem: null };
}

/** Where a tapped Cancel / Refund button's words print, as "Reason: …" (printer-core receipt-renderer). */
const PRINTS_ON: Readonly<Record<ReasonList, string>> = Object.freeze({
  cancel: 'a cancelled order’s receipt and kitchen ticket',
  refund: 'the refund slip',
});

/**
 * A warning for each Cancel or Refund button with letters the receipt
 * printer has no glyph for (Urdu, an emoji): its words print as "?" on the
 * papers that say the reason. Not a refusal: the button saves, and the
 * screens and Team & leakage show it as typed — like Extra lines on
 * receipts (tillSettingsForm extraLinesWarnings). The Cash out words never
 * print, so they get none.
 */
export function reasonsWarnings(f: Pick<ReasonsForm, 'cancel' | 'refund'>): string[] {
  const out: string[] = [];
  for (const which of ['cancel', 'refund'] as const) {
    const name = which === 'cancel' ? 'Cancel' : 'Refund';
    for (const [i, b] of f[which].entries()) {
      const label = b.label.trim();
      const bad = unprintableChars(label);
      if (bad.length === 0) continue;
      const shown = bad.slice(0, 6).join(' ');
      out.push(
        `${name} button ${i + 1} (“${label}”): ${shown}${bad.length > 6 ? ' …' : ''} ${bad.length === 1 ? 'prints' : 'print'} as “?” on ${PRINTS_ON[which]} — the receipt printer only has English letters. The screens and Team & leakage show it as typed.`,
      );
    }
  }
  return out;
}

/** An id for a new button, from its words, unused in its list ("Rain delay" → "rain_delay", then "rain_delay_2"). */
export function newReasonId(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'reason';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!taken.includes(id)) return id;
  }
}

/** Add a button at the end of a list; it asks about the food until told otherwise. */
export function addReason(list: readonly OrderReasonButton[], label: string): OrderReasonButton[] {
  const words = label.trim();
  return [...list, { id: newReasonId(words, list.map((b) => b.id)), label: words, food: 'ask' }];
}

/** Move a button one place up (towards the front of the box). */
export function moveReasonUp(list: readonly OrderReasonButton[], id: string): OrderReasonButton[] {
  const i = list.findIndex((b) => b.id === id);
  if (i <= 0) return [...list];
  const out = [...list];
  [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
  return out;
}

/** One line for History. */
export function reasonsSummary(r: Pick<OrderReasons, 'cancel' | 'refund' | 'cashOut'>): string {
  const labels = (xs: ReadonlyArray<{ label: string }>) => xs.map((x) => x.label).join(', ');
  const cashOut = r.cashOut.length === 0 ? 'typed' : r.cashOut.join(', ');
  return `Cancel: ${labels(r.cancel)} · Refund: ${labels(r.refund)} · Cash out: ${cashOut}`;
}

/** What the boxes will show, from the values. */
export function reasonsExample(r: Pick<OrderReasons, 'cancel' | 'refund' | 'cashOut'>): string {
  const madeOnes = [...r.cancel, ...r.refund].filter((b) => b.food !== 'ask');
  const food =
    madeOnes.length === 0
      ? 'No button answers “Was the food made?”: staff always tap it.'
      : `${madeOnes.map((b) => `“${b.label}” ${b.food === 'made' ? 'answers Made' : 'answers Not made'}`).join('; ')} — only while nobody has answered, and never once the food has left the shop (then it counts as waste).`;
  const cash =
    r.cashOut.length === 0
      ? 'Cash out has no buttons: staff type what it was for.'
      : `Cash out offers ${r.cashOut.map((l) => `“${l}”`).join(', ')}.`;
  return `The Cancel box offers ${r.cancel.length} button${r.cancel.length === 1 ? '' : 's'} and the Refund box ${r.refund.length}. ${food} ${cash} Any other reason can still be typed, every cancel and refund still needs a reason and a manager’s PIN, and the words tapped are what is saved and listed in Team & leakage.`;
}
