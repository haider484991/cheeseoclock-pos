import { useEffect, useRef } from 'react';
import { cn } from '@cheeseoclock/ui';
import { cashCountTotalCents, formatCents } from '@cheeseoclock/pos-domain';
import { CASH_NOTE_FACE_CENTS } from '@cheeseoclock/shared-types';
import {
  NOTE_COUNTER_OTHER_ROW,
  noteCounterStarted,
  noteCounterToCount,
  type NoteCounterState,
} from './noteCounterState';

/**
 * The note count in the Close shift box (owner, 2 Oct 2026: "when closing
 * the cash count should have 5000rs x note 1000 x 500 100 and 50 and 20 and
 * 10"; always by note, closing only). Eight rows — the seven notes, Rs 5,000
 * first, then 'Coins and other' in rupees — and the total the till adds up.
 *
 * The rows are buttons, not text boxes: a tap (or Tab) chooses the row, and
 * the keyboard or the on-screen pad beside it types into it (the box's
 * onKeyDown and the pad both go through noteCounterState). No text box, so
 * the Windows touch keyboard stays down. Nothing here knows what the drawer
 * should hold: the count is blind.
 */

/** One row's label, and the small words under it (Rs 10 and Coins and other only). */
export interface NoteCounterRowLabel {
  /** data-note-row: the note in rupees ('5000' … '10'), or 'other'. */
  key: string;
  label: string;
  sub: string | null;
}

/** The eight rows, in order: 'Rs 5,000' … 'Rs 10', then 'Coins and other'. */
export const NOTE_COUNTER_ROWS: readonly NoteCounterRowLabel[] = [
  ...CASH_NOTE_FACE_CENTS.map((faceCents) => ({
    key: String(faceCents / 100),
    label: formatCents(faceCents),
    // The Rs 10 row counts the notes and the coins together.
    sub: faceCents === 1_000 ? 'note or coin' : null,
  })),
  { key: 'other', label: 'Coins and other', sub: 'Rs 5, 2, 1 coins, in rupees' },
];

/** The question 'Clear all' asks first (never the browser's own confirm()). */
export const CLEAR_ALL_QUESTION = 'Clear every row of this count?';

/** The CSS selector of the first row (Rs 5,000): where the box puts the keyboard when it opens. */
export const NOTE_COUNTER_FIRST_ROW = `[data-note-row="${NOTE_COUNTER_ROWS[0]?.key ?? '5000'}"]`;

function cellNumber(cell: string): number {
  return cell === '' ? 0 : Number.parseInt(cell, 10);
}

/**
 * What a keydown in the Close shift box does with the note count:
 * - 'count': it goes to noteCounterKey (digits, Backspace, Delete, Enter,
 *   ArrowUp, ArrowDown), and the browser does nothing else with it;
 * - 'held': a digit key held down (it would type 5555 notes): stopped, and
 *   nothing typed;
 * - null: left alone — a key with Ctrl, Alt or the Windows key, a key while
 *   an input method is composing, a key in a text box (the closing note, the
 *   reason for unpaid orders), Enter on a button reached with Tab (Cancel,
 *   Close shift: Enter presses it), and every other key (Tab, Escape…).
 * Enter on a row always goes to the next row: the rows are buttons too.
 */
export function noteCounterKeyAction(k: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  /** The key went to a text box. */
  typing: boolean;
  /** The key went to a button that answers Enter itself (keys.ts ownsEnter). */
  ownsEnter: boolean;
  /** The key went to one of the count's rows. */
  onRow: boolean;
}): 'count' | 'held' | null {
  if (k.ctrlKey || k.altKey || k.metaKey || k.isComposing || k.typing) return null;
  if (/^[0-9]$/.test(k.key)) return k.repeat ? 'held' : 'count';
  switch (k.key) {
    case 'Enter':
      return k.ownsEnter && !k.onRow ? null : 'count';
    case 'Backspace':
    case 'Delete':
    case 'ArrowUp':
    case 'ArrowDown':
      return 'count';
    default:
      return null;
  }
}

export function NoteCounter({
  state,
  onSelect,
  onClear,
}: {
  state: NoteCounterState;
  /** A tap on a row, or Tab onto it. */
  onSelect: (row: number) => void;
  /** 'Clear all' (the box asks first). */
  onClear: () => void;
}) {
  const totalCents = cashCountTotalCents(noteCounterToCount(state));
  const started = noteCounterStarted(state);
  const rowsRef = useRef<HTMLDivElement>(null);

  // Enter and the arrows move the row: when the keyboard is on a row, it
  // moves with them, so Tab and the focus ring stay where the typing goes.
  // A tap on the pad leaves the keyboard where it is.
  useEffect(() => {
    const rows = rowsRef.current;
    const focused = typeof document === 'undefined' ? null : document.activeElement;
    if (!rows || !(focused instanceof HTMLElement) || !rows.contains(focused)) return;
    if (focused.dataset['noteRow'] === undefined) return;
    const row = rows.querySelectorAll<HTMLButtonElement>('[data-note-row]')[state.active];
    if (row && row !== focused) row.focus();
  }, [state.active]);

  return (
    <div>
      <div ref={rowsRef} className="flex flex-col gap-1">
        {NOTE_COUNTER_ROWS.map((r, i) => {
          const cell = state.cells[i] ?? '';
          const other = i === NOTE_COUNTER_OTHER_ROW;
          const active = i === state.active;
          const faceCents = other ? 100 : (CASH_NOTE_FACE_CENTS[i] ?? 0);
          const lineCents = faceCents * cellNumber(cell);
          return (
            <button
              key={r.key}
              type="button"
              data-note-row={r.key}
              aria-pressed={active}
              onFocus={() => onSelect(i)}
              onClick={() => onSelect(i)}
              className={cn(
                'flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left outline-none transition-colors',
                active
                  ? 'bg-amber-50 ring-2 ring-amber-400 dark:bg-amber-950/40 dark:ring-amber-500'
                  : 'hover:bg-stone-50 dark:hover:bg-stone-800',
              )}
            >
              <span className="w-[170px] shrink-0 leading-tight">
                <span className="block text-sm font-semibold text-stone-800 dark:text-stone-100">{r.label}</span>
                {r.sub && <span className="block text-[11px] text-stone-500 dark:text-stone-400">{r.sub}</span>}
              </span>
              <span className="w-3 shrink-0 text-center text-stone-400" aria-hidden="true">
                {other ? '' : '×'}
              </span>
              <span
                className={cn(
                  'w-24 shrink-0 text-right font-mono text-lg',
                  cell === '' ? 'text-stone-300 dark:text-stone-600' : 'text-stone-900 dark:text-stone-100',
                )}
              >
                {other ? `Rs ${cell === '' ? '0' : cell}` : cell === '' ? '0' : cell}
              </span>
              <span className="w-3 shrink-0 text-center text-stone-400" aria-hidden="true">
                =
              </span>
              <span className="min-w-0 flex-1 text-right font-mono text-sm text-stone-700 dark:text-stone-200">
                {cell === '' ? '—' : formatCents(lineCents)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-stone-200 px-3 pt-2 dark:border-stone-700">
        <button
          type="button"
          onClick={onClear}
          disabled={!started}
          className="rounded text-sm font-medium text-stone-500 underline-offset-2 hover:text-stone-800 hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:no-underline dark:text-stone-400 dark:hover:text-stone-100"
        >
          Clear all
        </button>
        <p className="text-xl font-bold text-stone-900 dark:text-stone-50">
          Counted cash <span className="font-mono">{formatCents(totalCents)}</span>
        </p>
      </div>
    </div>
  );
}
