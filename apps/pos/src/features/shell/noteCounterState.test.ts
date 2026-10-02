/**
 * The note count's pure state (owner, 2 Oct 2026: count the drawer by note
 * at Close shift — Rs 5,000, 1,000, 500, 100, 50, 20 and 10, plus coins and
 * other). The keyboard and the on-screen pad both go through noteCounterKey,
 * so these are the rules for both. Made-up counts.
 */
import { describe, expect, it } from 'vitest';
import { CASH_NOTE_FACE_CENTS } from '@cheeseoclock/shared-types';
import { cashCountTotalCents } from '@cheeseoclock/pos-domain';
import {
  NOTE_COUNTER_OTHER_ROW,
  NOTE_COUNTER_ROW_COUNT,
  noteCounterCell,
  noteCounterClear,
  noteCounterInitial,
  noteCounterKey,
  noteCounterMaxDigits,
  noteCounterOtherIsLarge,
  noteCounterPad,
  noteCounterSelect,
  noteCounterStarted,
  noteCounterToCount,
  type NoteCounterState,
} from './noteCounterState';

/** Press keys one after another. */
function press(state: NoteCounterState, ...keys: string[]): NoteCounterState {
  return keys.reduce(noteCounterKey, state);
}

/** A state with the given rows typed, on row `active`. */
function counted(cells: Partial<Record<number, string>>, active = 0): NoteCounterState {
  const s = noteCounterInitial();
  return { cells: s.cells.map((c, i) => cells[i] ?? c), active };
}

describe('a fresh count', () => {
  it('has eight blank rows (seven notes, then coins and other) and starts on Rs 5,000', () => {
    const s = noteCounterInitial();
    expect(NOTE_COUNTER_ROW_COUNT).toBe(8);
    expect(NOTE_COUNTER_OTHER_ROW).toBe(7);
    expect(s.cells).toEqual(['', '', '', '', '', '', '', '']);
    expect(s.active).toBe(0);
    expect(noteCounterStarted(s)).toBe(false);
  });

  it('takes 4 digits on a note row and 5 on coins and other', () => {
    for (let row = 0; row < NOTE_COUNTER_OTHER_ROW; row++) expect(noteCounterMaxDigits(row)).toBe(4);
    expect(noteCounterMaxDigits(NOTE_COUNTER_OTHER_ROW)).toBe(5);
  });
});

describe('typing digits', () => {
  it('adds them at the end of the chosen row only', () => {
    const s = press(noteCounterInitial(), '1', '2');
    expect(s.cells).toEqual(['12', '', '', '', '', '', '', '']);
    expect(noteCounterCell(s)).toBe('12');
  });

  it("replaces a lone 0: '0' then '7' is '7', and '0' then '0' stays '0'", () => {
    expect(noteCounterCell(press(noteCounterInitial(), '0', '7'))).toBe('7');
    expect(noteCounterCell(press(noteCounterInitial(), '0', '0'))).toBe('0');
    expect(noteCounterCell(press(noteCounterInitial(), '0', '0', '0', '5'))).toBe('5');
    // a 0 after another digit is kept
    expect(noteCounterCell(press(noteCounterInitial(), '1', '0', '0'))).toBe('100');
  });

  it('ignores a 5th digit on a note row and a 6th on coins and other', () => {
    const note = press(noteCounterInitial(), '9', '9', '9', '9');
    expect(noteCounterCell(note)).toBe('9999');
    expect(noteCounterKey(note, '9')).toBe(note);

    const other = press(noteCounterSelect(noteCounterInitial(), NOTE_COUNTER_OTHER_ROW), '9', '9', '9', '9', '9');
    expect(noteCounterCell(other)).toBe('99999');
    expect(noteCounterKey(other, '1')).toBe(other);
  });

  it("ignores '-', '.', ',', 'e' and other keys", () => {
    const s = counted({ 0: '12' });
    for (const key of ['-', '.', ',', 'e', 'E', '+', ' ', 'a', '١', 'Tab', 'Escape', 'Shift', 'F5', '12', '']) {
      expect(noteCounterKey(s, key)).toBe(s);
    }
  });
});

describe('Backspace and Delete', () => {
  it('Backspace takes off the last digit; on a blank row it changes nothing', () => {
    const s = press(noteCounterInitial(), '1', '2', '3', 'Backspace');
    expect(noteCounterCell(s)).toBe('12');
    expect(noteCounterCell(press(s, 'Backspace', 'Backspace'))).toBe('');
    const blank = noteCounterInitial();
    expect(noteCounterKey(blank, 'Backspace')).toBe(blank);
  });

  it('Delete clears the chosen row and no other', () => {
    const s = counted({ 0: '2', 1: '3' }, 1);
    expect(noteCounterKey(s, 'Delete').cells).toEqual(['2', '', '', '', '', '', '', '']);
    expect(noteCounterKey(s, 'Delete').active).toBe(1);
  });

  it('a row taken back to blank is not a count any more', () => {
    expect(noteCounterStarted(press(noteCounterInitial(), '0', 'Backspace'))).toBe(false);
  });
});

describe('moving between rows', () => {
  it('Enter and ArrowDown go to the next row and stop on coins and other', () => {
    let s = noteCounterInitial();
    for (let row = 1; row <= NOTE_COUNTER_OTHER_ROW; row++) {
      s = noteCounterKey(s, row % 2 === 0 ? 'Enter' : 'ArrowDown');
      expect(s.active).toBe(row);
    }
    expect(noteCounterKey(s, 'Enter')).toBe(s);
    expect(noteCounterKey(s, 'ArrowDown')).toBe(s);
  });

  it('ArrowUp goes to the previous row and stops on Rs 5,000', () => {
    let s = noteCounterSelect(noteCounterInitial(), NOTE_COUNTER_OTHER_ROW);
    for (let row = NOTE_COUNTER_OTHER_ROW - 1; row >= 0; row--) {
      s = noteCounterKey(s, 'ArrowUp');
      expect(s.active).toBe(row);
    }
    expect(noteCounterKey(s, 'ArrowUp')).toBe(s);
  });

  it('moving keeps what was typed', () => {
    const s = press(noteCounterInitial(), '2', 'Enter', '3', 'Enter', 'ArrowUp', '1');
    expect(s.cells).toEqual(['2', '31', '', '', '', '', '', '']);
  });

  it('a tap chooses a row; a row that does not exist changes nothing', () => {
    const s = noteCounterInitial();
    expect(noteCounterSelect(s, 4).active).toBe(4);
    expect(noteCounterSelect(s, 0)).toBe(s);
    for (const row of [-1, 8, 1.5, Number.NaN]) expect(noteCounterSelect(s, row)).toBe(s);
  });
});

describe('the on-screen pad goes through the same rules', () => {
  it("'0' then pad '7' is '7' (the pad hands back '07')", () => {
    const s = noteCounterPad(noteCounterInitial(), '0');
    expect(noteCounterCell(s)).toBe('0');
    expect(noteCounterCell(noteCounterPad(s, '07'))).toBe('7');
  });

  it('a 5th pad digit on a note row is ignored, a 6th on coins and other too', () => {
    const note = counted({ 0: '1234' });
    expect(noteCounterPad(note, '12345')).toBe(note);
    const other = counted({ [NOTE_COUNTER_OTHER_ROW]: '12345' }, NOTE_COUNTER_OTHER_ROW);
    expect(noteCounterPad(other, '123456')).toBe(other);
  });

  it('the pad ← is Backspace; ← on a blank row changes nothing', () => {
    const s = counted({ 2: '15' }, 2);
    expect(noteCounterCell(noteCounterPad(s, '1'))).toBe('1');
    const blank = noteCounterInitial();
    expect(noteCounterPad(blank, '')).toBe(blank);
  });

  it('every digit from the pad gives the same state as the key', () => {
    const starts = [counted({}), counted({ 0: '0' }), counted({ 1: '45' }, 1), counted({ 3: '9999' }, 3), counted({ 7: '0' }, 7)];
    for (const s of starts) {
      for (const d of '0123456789') {
        expect(noteCounterPad(s, noteCounterCell(s) + d)).toEqual(noteCounterKey(s, d));
      }
      expect(noteCounterPad(s, noteCounterCell(s).slice(0, -1))).toEqual(noteCounterKey(s, 'Backspace'));
    }
  });
});

describe('Clear all', () => {
  it('blanks every row and goes back to Rs 5,000', () => {
    const s = counted({ 0: '2', 3: '7', 7: '35' }, 5);
    expect(noteCounterClear(s)).toEqual(noteCounterInitial());
  });
});

describe('the count that is sent', () => {
  it("the owner's example: 5,000 × 2, 1,000 × 3, 500 × 1, 100 × 7, 10 × 4 and coins Rs 35", () => {
    const s = press(noteCounterInitial(), '2', 'Enter', '3', 'Enter', '1', 'Enter', '7', 'Enter', 'Enter', 'Enter', '4', 'Enter', '3', '5');
    const count = noteCounterToCount(s);
    expect(count).toEqual({
      notes: [
        { faceCents: 500_000, count: 2 },
        { faceCents: 100_000, count: 3 },
        { faceCents: 50_000, count: 1 },
        { faceCents: 10_000, count: 7 },
        { faceCents: 5_000, count: 0 },
        { faceCents: 2_000, count: 0 },
        { faceCents: 1_000, count: 4 },
      ],
      otherCents: 3_500,
    });
    expect(cashCountTotalCents(count)).toBe(1_427_500);
  });

  it('the rows are always the seven notes in their order, whatever was typed', () => {
    expect(noteCounterToCount(noteCounterInitial()).notes.map((n) => n.faceCents)).toEqual([...CASH_NOTE_FACE_CENTS]);
  });

  it('blank rows are 0, never NaN, and every figure is a safe whole number', () => {
    const blank = noteCounterToCount(noteCounterInitial());
    expect(blank.notes.every((n) => n.count === 0)).toBe(true);
    expect(blank.otherCents).toBe(0);

    const full = noteCounterToCount(counted({ 0: '9999', 1: '9999', 2: '9999', 3: '9999', 4: '9999', 5: '9999', 6: '9999', 7: '99999' }));
    for (const n of [...blank.notes, ...full.notes]) expect(Number.isSafeInteger(n.count)).toBe(true);
    for (const v of [blank.otherCents, full.otherCents]) expect(Number.isSafeInteger(v)).toBe(true);
    expect(full.otherCents).toBe(9_999_900);
    expect(Number.isSafeInteger(cashCountTotalCents(full))).toBe(true);
  });

  it("coins and other is typed in rupees: '35' is 3,500 cents", () => {
    expect(noteCounterToCount(counted({ [NOTE_COUNTER_OTHER_ROW]: '35' })).otherCents).toBe(3_500);
  });

  it('a lone 0 row is a count of 0', () => {
    expect(noteCounterToCount(counted({ 0: '0' })).notes[0]).toEqual({ faceCents: 500_000, count: 0 });
  });
});

describe('started', () => {
  it('false while every row is blank, true once any row has something, a single 0 included', () => {
    expect(noteCounterStarted(noteCounterInitial())).toBe(false);
    expect(noteCounterStarted(counted({ 4: '0' }))).toBe(true);
    expect(noteCounterStarted(counted({ [NOTE_COUNTER_OTHER_ROW]: '5' }))).toBe(true);
  });
});

describe('coins and other is large', () => {
  it('Rs 999 is not, Rs 1,000 is', () => {
    expect(noteCounterOtherIsLarge(counted({ [NOTE_COUNTER_OTHER_ROW]: '999' }))).toBe(false);
    expect(noteCounterOtherIsLarge(counted({ [NOTE_COUNTER_OTHER_ROW]: '1000' }))).toBe(true);
    expect(noteCounterOtherIsLarge(noteCounterInitial())).toBe(false);
  });

  it('only coins and other counts, never a note row', () => {
    expect(noteCounterOtherIsLarge(counted({ 0: '9999', 6: '9999' }))).toBe(false);
  });
});
