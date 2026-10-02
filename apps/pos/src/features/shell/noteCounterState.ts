import { CASH_NOTE_FACE_CENTS, type CashCount } from '@cheeseoclock/shared-types';

/**
 * The note count in the Close shift box (owner, 2 Oct 2026: "when closing
 * the cash count should have 5000rs x note 1000 x 500 100 and 50 and 20 and
 * 10"), as pure state: eight rows — the seven notes in CASH_NOTE_FACE_CENTS
 * order (Rs 5,000 first, Rs 10 last), then 'Coins and other' in whole
 * rupees — and the row being typed into.
 *
 * The rows are buttons, not text boxes, so the Windows touch keyboard stays
 * down. The physical keys go to noteCounterKey and the on-screen pad goes
 * through noteCounterPad into the same function, so both follow one set of
 * rules. Each row holds what was typed, as digits: '' is a row nobody typed
 * in yet, and it counts as 0.
 */

/** The seven note rows, then 'Coins and other'. */
export const NOTE_COUNTER_ROW_COUNT = CASH_NOTE_FACE_CENTS.length + 1;

/** The 'Coins and other' row: the last one. */
export const NOTE_COUNTER_OTHER_ROW = CASH_NOTE_FACE_CENTS.length;

/** A note row takes up to 4 digits (9,999 notes, CASH_NOTE_COUNT_MAX). */
export const NOTE_COUNTER_NOTE_DIGITS = 4;

/** 'Coins and other' takes up to 5 digits (Rs 99,999, CASH_COUNT_OTHER_MAX_CENTS). */
export const NOTE_COUNTER_OTHER_DIGITS = 5;

/**
 * 'Coins and other' at or above this (Rs 1,000) gets a reminder to count the
 * notes in their own rows. It never stops the close.
 */
export const NOTE_COUNTER_OTHER_LARGE_CENTS = 100_000;

export interface NoteCounterState {
  /** One entry per row, NOTE_COUNTER_ROW_COUNT long: the digits typed, '' when none. */
  readonly cells: readonly string[];
  /** The row being typed into, 0 (Rs 5,000) to NOTE_COUNTER_OTHER_ROW. */
  readonly active: number;
}

/** A fresh count: every row blank, the Rs 5,000 row chosen. */
export function noteCounterInitial(): NoteCounterState {
  return { cells: Array.from({ length: NOTE_COUNTER_ROW_COUNT }, () => ''), active: 0 };
}

/** How many digits a row takes: 4 on a note row, 5 on 'Coins and other'. */
export function noteCounterMaxDigits(row: number): number {
  return row === NOTE_COUNTER_OTHER_ROW ? NOTE_COUNTER_OTHER_DIGITS : NOTE_COUNTER_NOTE_DIGITS;
}

/** What the chosen row holds (the on-screen pad's value). */
export function noteCounterCell(state: NoteCounterState): string {
  return state.cells[state.active] ?? '';
}

function withCell(state: NoteCounterState, cell: string): NoteCounterState {
  if (cell === noteCounterCell(state)) return state;
  const cells = state.cells.slice();
  cells[state.active] = cell;
  return { cells, active: state.active };
}

function withActive(state: NoteCounterState, active: number): NoteCounterState {
  return active === state.active ? state : { cells: state.cells, active };
}

const DIGIT = /^[0-9]$/;

/**
 * One key on the chosen row, by KeyboardEvent.key:
 * - a digit is added at the end; a lone 0 is replaced ('0' then '7' is '7',
 *   '0' then '0' stays '0'); a 5th digit on a note row, or a 6th on 'Coins
 *   and other', is ignored;
 * - 'Backspace' takes off the last digit; 'Delete' clears the row;
 * - 'Enter' and 'ArrowDown' go to the next row and stay on the last;
 *   'ArrowUp' goes to the previous row and stays on the first;
 * - anything else ('-', '.', ',', 'e', letters) changes nothing.
 * Nothing changed gives back the same state object.
 */
export function noteCounterKey(state: NoteCounterState, key: string): NoteCounterState {
  const cell = noteCounterCell(state);
  if (DIGIT.test(key)) {
    if (cell === '0') return withCell(state, key);
    if (cell.length >= noteCounterMaxDigits(state.active)) return state;
    return withCell(state, cell + key);
  }
  switch (key) {
    case 'Backspace':
      return withCell(state, cell.slice(0, -1));
    case 'Delete':
      return withCell(state, '');
    case 'Enter':
    case 'ArrowDown':
      return withActive(state, Math.min(state.active + 1, NOTE_COUNTER_OTHER_ROW));
    case 'ArrowUp':
      return withActive(state, Math.max(state.active - 1, 0));
    default:
      return state;
  }
}

/**
 * The on-screen pad's onChange, as a key: the pad hands back the chosen
 * row's digits with one added (that digit is the key) or one taken off
 * ('Backspace'). Wired straight to the row it would skip the rules above
 * ('0' then '7' would stay '07').
 */
export function noteCounterPad(state: NoteCounterState, next: string): NoteCounterState {
  const cell = noteCounterCell(state);
  if (next.length > cell.length) return noteCounterKey(state, next.slice(-1));
  if (next.length < cell.length) return noteCounterKey(state, 'Backspace');
  return state;
}

/** Choose a row (a tap, or Tab onto it). A row that does not exist changes nothing. */
export function noteCounterSelect(state: NoteCounterState, row: number): NoteCounterState {
  if (!Number.isInteger(row) || row < 0 || row > NOTE_COUNTER_OTHER_ROW) return state;
  return withActive(state, row);
}

/** 'Clear all': every row blank, back on the Rs 5,000 row. */
export function noteCounterClear(_state: NoteCounterState): NoteCounterState {
  return noteCounterInitial();
}

function cellNumber(cell: string | undefined): number {
  return cell === undefined || cell === '' ? 0 : Number.parseInt(cell, 10);
}

/**
 * The count to send with Close shift: a blank row is 0; each note row is
 * {faceCents, count} in CASH_NOTE_FACE_CENTS order; 'Coins and other' is
 * typed in rupees and sent in cents.
 */
export function noteCounterToCount(state: NoteCounterState): CashCount {
  return {
    notes: CASH_NOTE_FACE_CENTS.map((faceCents, row) => ({ faceCents, count: cellNumber(state.cells[row]) })),
    otherCents: cellNumber(state.cells[NOTE_COUNTER_OTHER_ROW]) * 100,
  };
}

/** Anything typed in any row — a single 0 counts (an empty drawer is a count). */
export function noteCounterStarted(state: NoteCounterState): boolean {
  return state.cells.some((cell) => cell !== '');
}

/** 'Coins and other' is Rs 1,000 or more (the reminder, never a block). */
export function noteCounterOtherIsLarge(state: NoteCounterState): boolean {
  return cellNumber(state.cells[NOTE_COUNTER_OTHER_ROW]) * 100 >= NOTE_COUNTER_OTHER_LARGE_CENTS;
}
