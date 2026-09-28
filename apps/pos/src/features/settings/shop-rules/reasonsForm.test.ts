import { describe, expect, it } from 'vitest';
import { DEFAULT_ORDER_REASONS, type OrderReasonButton } from '@cheeseoclock/shared-types';
import {
  addReason,
  moveReasonUp,
  newReasonId,
  reasonsExample,
  reasonsFromForm,
  reasonsSummary,
  reasonsToForm,
  reasonsWarnings,
} from './reasonsForm';

const b = (id: string, label: string, food: OrderReasonButton['food'] = 'ask'): OrderReasonButton => ({ id, label, food });

describe('reason buttons: the form', () => {
  it('the default round-trips unchanged', () => {
    expect(reasonsFromForm(reasonsToForm(DEFAULT_ORDER_REASONS))).toEqual({ value: DEFAULT_ORDER_REASONS, problem: null });
  });

  it('words are trimmed; the bounds are said in plain words', () => {
    const form = reasonsToForm(DEFAULT_ORDER_REASONS);
    expect(reasonsFromForm({ ...form, cancel: [b('a', '  Test  ')] }).value?.cancel).toEqual([b('a', 'Test')]);
    const cases: Array<[Partial<ReturnType<typeof reasonsToForm>>, string]> = [
      [{ cancel: [] }, 'Keep at least one Cancel button.'],
      [{ refund: Array.from({ length: 9 }, (_, i) => b(`r${i}`, `Test ${i}`)) }, 'At most 8 Refund buttons.'],
      [{ refund: [b('a', '')] }, 'A Refund button needs words.'],
      [{ refund: [b('a', 'x'.repeat(31))] }, `Keep a refund button to 30 letters: “${'x'.repeat(31)}”.`],
      [{ refund: [b('a', 'Same'), b('b', 'SAME')] }, 'Two Refund buttons say “SAME”.'],
      [{ cashOut: Array.from({ length: 9 }, (_, i) => `Test ${i}`) }, 'At most 8 Cash out buttons.'],
      [{ cashOut: ['Gas', 'gas'] }, 'Two Cash out buttons say “gas”.'],
    ];
    for (const [change, problem] of cases) {
      expect({ change, problem: reasonsFromForm({ ...form, ...change }).problem }).toEqual({ change, problem });
    }
  });

  it('a new button: an id from its words, unused in its list; it asks about the food', () => {
    expect(newReasonId('Rider could not find it!', [])).toBe('rider_could_not_find_it');
    expect(newReasonId('Out of stock', ['out_of_stock'])).toBe('out_of_stock_2');
    expect(newReasonId('شکریہ', [])).toBe('reason');
    expect(addReason([b('a', 'One')], ' Two ')).toEqual([b('a', 'One'), b('two', 'Two', 'ask')]);
  });

  it('a Cancel or Refund button with letters the printer has no glyph for: a warning (it prints as "?"), not a refusal', () => {
    // The words print as "Reason: …" on the refund slip and on a cancelled
    // order's receipt and kitchen ticket. Up to the first review this card
    // said nothing, while Extra lines on receipts warns for the same printer.
    const form = {
      cancel: [b('a', 'Customer cancelled'), b('b', 'گاہک نے منع کیا')],
      refund: [b('c', 'Cold 🍕')],
      cashOut: ['گیس'],
    };
    expect(reasonsFromForm(form).value?.cancel.map((x) => x.label)).toEqual(['Customer cancelled', 'گاہک نے منع کیا']);
    expect(reasonsWarnings(form)).toEqual([
      'Cancel button 2 (“گاہک نے منع کیا”): گ ا ہ ک ن ے … print as “?” on a cancelled order’s receipt and kitchen ticket — the receipt printer only has English letters. The screens and Team & leakage show it as typed.',
      'Refund button 1 (“Cold 🍕”): 🍕 prints as “?” on the refund slip — the receipt printer only has English letters. The screens and Team & leakage show it as typed.',
    ]);
    // Cash out words never print: no warning. Today's buttons: none.
    expect(reasonsWarnings({ ...form, cancel: [b('a', 'Test')], refund: [b('c', 'Café — “ok”')] })).toEqual([]);
    expect(reasonsWarnings(reasonsToForm(DEFAULT_ORDER_REASONS))).toEqual([]);
  });

  it('moves a button up', () => {
    const list = [b('a', 'A'), b('b', 'B'), b('c', 'C')];
    expect(moveReasonUp(list, 'c').map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(moveReasonUp(list, 'a').map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('History and the example are built from the values', () => {
    expect(reasonsSummary(DEFAULT_ORDER_REASONS)).toBe(
      'Cancel: Customer cancelled, Refused at the door, Not collected, Wrong order / duplicate, Out of stock · Refund: Customer unhappy, Wrong order, Cancelled by Foodpanda, Out of stock · Cash out: typed',
    );
    const ex = reasonsExample(DEFAULT_ORDER_REASONS);
    expect(ex).toContain('The Cancel box offers 5 buttons and the Refund box 4.');
    expect(ex).toContain('“Refused at the door” answers Made');
    expect(ex).toContain('“Out of stock” answers Not made');
    expect(ex).toContain('Cash out has no buttons: staff type what it was for.');
    expect(reasonsExample({ cancel: [b('a', 'Test')], refund: [b('b', 'Test 2')], cashOut: [] })).toContain(
      'No button answers “Was the food made?”: staff always tap it.',
    );
  });
});
