/**
 * Where Enter lands when the app's own yes/no question opens. A question
 * about losing something, and a warning the cashier must read (the till's
 * total and foodpanda's tablet disagree), start on "No": a second Enter
 * pressed out of habit, or a held key, goes back instead of going ahead.
 */
import { describe, expect, it } from 'vitest';
import { confirmFocus } from './ConfirmHost';

describe('the confirm dialog’s first focus', () => {
  it('a routine question starts on Yes', () => {
    expect(confirmFocus('Print the bill again?')).toBe('yes');
  });

  it('a question about losing or replacing something starts on No', () => {
    expect(confirmFocus('Discard order #12? Its 2 items will be dropped.')).toBe('no');
    expect(confirmFocus('  Delete this supplier?')).toBe('no');
  });

  it('the tablet-total warning at Pay starts on "Go back", whatever its words', () => {
    const msg = 'The till says Rs 1,843, the tablet says Rs 1,920 — check the items and the deal.\nPay anyway?';
    expect(confirmFocus(msg)).toBe('yes');
    expect(confirmFocus(msg, { safeDefault: true, yesLabel: 'Pay anyway', noLabel: 'Go back' })).toBe('no');
  });
});
