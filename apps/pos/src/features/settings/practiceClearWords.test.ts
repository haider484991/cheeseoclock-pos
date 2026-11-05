import { describe, expect, it } from 'vitest';
import type { PracticeClearPreview } from '@cheeseoclock/shared-types';
import {
  practiceClearMissing,
  practiceClearToast,
  practiceConfirmQuestion,
  practiceHistoryLine,
  practiceNothingToClear,
  showPracticeClear,
} from './practiceClearWords';

/** Something typed in the PIN box (made up here, never a real PIN). */
const TYPED = String.fromCharCode(49, 51, 53, 55);

const P = (more: Partial<PracticeClearPreview> = {}): PracticeClearPreview => ({
  orders: 12,
  shifts: 3,
  cashMovements: 2,
  drawerLog: 15,
  customers: 8,
  blocks: [],
  ...more,
});

describe('Clear practice orders: the words', () => {
  it('shows for the owner only, and never on a till with a licence key', () => {
    expect(showPracticeClear('admin', P())).toBe(true);
    expect(showPracticeClear('manager', P())).toBe(false);
    expect(showPracticeClear('cashier', P())).toBe(false);
    expect(showPracticeClear(null, P())).toBe(false);
    expect(showPracticeClear('admin', null)).toBe(false);
    expect(showPracticeClear('admin', P({ blocks: [{ code: 'licensed', message: 'x' }] }))).toBe(false);
    // Any other reason shows the card, with the reason on it.
    expect(showPracticeClear('admin', P({ blocks: [{ code: 'shift_open', message: 'x' }] }))).toBe(true);
  });

  it('says what is on the till', () => {
    expect(practiceHistoryLine(P())).toBe('12 orders, 3 shifts and 2 cash in / out on this till.');
    expect(practiceHistoryLine(P({ orders: 1, shifts: 1, cashMovements: 0 }))).toBe('1 order and 1 shift on this till.');
    expect(practiceHistoryLine(P({ orders: 0, shifts: 0, cashMovements: 0 }))).toBe('No orders or shifts on this till yet.');
  });

  it('asks once more, naming what goes', () => {
    expect(practiceConfirmQuestion(P(), { customers: false, drawerLog: false })).toBe(
      'Delete 12 practice orders, 3 shifts and 2 cash in / out? This can’t be undone.',
    );
    expect(practiceConfirmQuestion(P(), { customers: true, drawerLog: true })).toBe(
      'Delete 12 practice orders, 3 shifts and 2 cash in / out? The saved customers and the drawer log go too. This can’t be undone.',
    );
    expect(practiceConfirmQuestion(P({ cashMovements: 0 }), { customers: false, drawerLog: true })).toBe(
      'Delete 12 practice orders and 3 shifts? The drawer log goes too. This can’t be undone.',
    );
    // The question starts with "Delete", so the window lands on "Keep them".
    expect(practiceConfirmQuestion(P(), { customers: false, drawerLog: false })).toMatch(/^Delete\b/);
  });

  it('greys the button out until it can be pressed', () => {
    expect(practiceClearMissing({ blocked: true, nothing: false, secret: TYPED })).toBe('Sort out what is listed above first.');
    expect(practiceClearMissing({ blocked: false, nothing: true, secret: TYPED })).toBe('There is nothing to clear.');
    expect(practiceClearMissing({ blocked: false, nothing: false, secret: '' })).toBe('Type your owner PIN or password.');
    expect(practiceClearMissing({ blocked: false, nothing: false, secret: TYPED })).toBeNull();
  });

  it('knows when nothing would go', () => {
    const empty = P({ orders: 0, shifts: 0, cashMovements: 0 });
    expect(practiceNothingToClear(empty, { customers: false, drawerLog: false })).toBe(true);
    expect(practiceNothingToClear(empty, { customers: true, drawerLog: false })).toBe(false);
    expect(practiceNothingToClear(P({ orders: 0, shifts: 0, cashMovements: 0, customers: 0 }), { customers: true, drawerLog: false })).toBe(true);
    expect(practiceNothingToClear(P(), { customers: false, drawerLog: false })).toBe(false);
  });

  it('says what was cleared', () => {
    expect(practiceClearToast({ orders: 12, shifts: 3, cashMovements: 0, drawerLog: 0, customers: 0, backupFileName: 'x' })).toBe(
      'Practice orders cleared: 12 orders and 3 shifts. Order numbers start again at 1.',
    );
    expect(practiceClearToast({ orders: 1, shifts: 1, cashMovements: 1, drawerLog: 1, customers: 2, backupFileName: 'x' })).toBe(
      'Practice orders cleared: 1 order, 1 shift, 1 cash in / out, 2 customers and 1 drawer log entry. Order numbers start again at 1.',
    );
  });
});
