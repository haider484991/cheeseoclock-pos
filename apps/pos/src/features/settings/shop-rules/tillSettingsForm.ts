/**
 * The "this till" cards' forms and words (what is typed ↔ the setting's
 * value), pure: the receipt's extra lines (Settings → Shop & logo) and the
 * opening float (Settings → Staff & kitchen). The bounds are shared-types'
 * (RECEIPT_EXTRA_LINES_MAX / _LINE_MAX_CHARS, OPENING_FLOAT_MAX_CENTS), the
 * same ones the main process checks with the key's schema; this only says
 * what is wrong before Save. Every sentence is built from the values.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import { unprintableChars } from '@cheeseoclock/printer-core';
import {
  OPENING_FLOAT_MAX_CENTS,
  RECEIPT_EXTRA_LINE_MAX_CHARS,
  RECEIPT_EXTRA_LINES_MAX,
  type OpeningFloatSetting,
} from '@cheeseoclock/shared-types';
import type { Parsed } from './foodpandaForm';

// ---------------------------------------------------------------------------
// Receipt extra lines
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** One box per line the receipt can take, the saved ones first. */
export function extraLinesToForm(lines: readonly string[]): string[] {
  return Array.from({ length: RECEIPT_EXTRA_LINES_MAX }, (_, i) => lines[i] ?? '');
}

/** The lines to save: each trimmed, empty boxes left out, in order. */
export function extraLinesFromForm(form: readonly string[]): Parsed<string[]> {
  const lines: string[] = [];
  for (const [i, text] of form.entries()) {
    const line = text.trim();
    if (line === '') continue;
    if (line.length > RECEIPT_EXTRA_LINE_MAX_CHARS) {
      return { value: null, problem: `Line ${i + 1} is ${line.length} letters: keep each line to ${RECEIPT_EXTRA_LINE_MAX_CHARS}.` };
    }
    if (CONTROL_CHARS.test(line)) {
      return { value: null, problem: `Line ${i + 1} has a character the printer would take as a command: type it again.` };
    }
    lines.push(line);
  }
  if (lines.length > RECEIPT_EXTRA_LINES_MAX) return { value: null, problem: `At most ${RECEIPT_EXTRA_LINES_MAX} lines.` };
  return { value: lines, problem: null };
}

/**
 * A warning for each line with letters the receipt printer has no glyph
 * for: they print as "?" (an Urdu word, an emoji). Not a refusal: the line
 * saves and prints, with question marks.
 */
export function extraLinesWarnings(form: readonly string[]): string[] {
  const out: string[] = [];
  for (const [i, text] of form.entries()) {
    const bad = unprintableChars(text.trim());
    if (bad.length === 0) continue;
    const shown = bad.slice(0, 6).join(' ');
    out.push(
      `Line ${i + 1}: ${shown}${bad.length > 6 ? ' …' : ''} ${bad.length === 1 ? 'prints' : 'print'} as “?” — the receipt printer only has English letters.`,
    );
  }
  return out;
}

/** One line for History. */
export function extraLinesSummary(lines: readonly string[]): string {
  if (lines.length === 0) return 'No extra lines';
  return lines.map((l) => `“${l}”`).join(' · ');
}

/** Where they print, from the values. */
export function extraLinesExample(lines: readonly string[]): string {
  if (lines.length === 0) {
    return `Nothing prints under the thank-you line. Add up to ${RECEIPT_EXTRA_LINES_MAX} lines of up to ${RECEIPT_EXTRA_LINE_MAX_CHARS} letters each: your Instagram, the Wi-Fi password, an offer.`;
  }
  const which = lines.length === 1 ? 'This line prints' : `These ${lines.length} lines print`;
  return `${which} under the thank-you line on every customer receipt and bill from this till, and on the receipt shown after Pay. Never on kitchen tickets, the shop's copy, refund slips or cancelled orders. A long line carries on to the next row.`;
}

// ---------------------------------------------------------------------------
// Opening float
// ---------------------------------------------------------------------------

export interface OpeningFloatForm {
  mode: OpeningFloatSetting['mode'];
  /** The fixed amount as typed, in rupees. */
  rupees: string;
}

export function openingFloatToForm(s: OpeningFloatSetting): OpeningFloatForm {
  return { mode: s.mode, rupees: String(s.fixedCents / 100) };
}

export function openingFloatFromForm(f: OpeningFloatForm): Parsed<OpeningFloatSetting> {
  const t = f.rupees.trim().replace(/,/g, '');
  const whole = /^\d{1,6}$/.test(t) ? Number(t) * 100 : null;
  const max = OPENING_FLOAT_MAX_CENTS;
  if (f.mode === 'fixed') {
    if (whole === null || whole > max) {
      return { value: null, problem: `The fixed float is a whole number of rupees from Rs 0 to ${formatCents(max)}.` };
    }
    return { value: { mode: 'fixed', fixedCents: whole }, problem: null };
  }
  // The last count keeps no amount: it is then the default's own value, so
  // the card says Default, and trying a fixed amount and coming back is no
  // change. (The box keeps what was typed until Save, for switching back.)
  return { value: { mode: 'lastCount', fixedCents: 0 }, problem: null };
}

/** One line for History. */
export function openingFloatSummary(s: OpeningFloatSetting): string {
  return s.mode === 'fixed' ? `${formatCents(s.fixedCents)} every shift` : "The last shift's count";
}

/** What the Open shift box will do, from the values. */
export function openingFloatExample(s: OpeningFloatSetting): string {
  const start =
    s.mode === 'fixed'
      ? `The Open shift box on this till starts on ${formatCents(s.fixedCents)} every shift, whatever the last shift closed with.`
      : "The Open shift box on this till starts on what its last shift closed with: the cash left in the drawer overnight. A first shift starts at Rs 0.";
  return `${start} Whoever opens still counts the drawer and types the float, and closing stays a blind count.`;
}
