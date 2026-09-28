import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENING_FLOAT } from '@cheeseoclock/shared-types';
import {
  extraLinesFromForm,
  extraLinesSummary,
  extraLinesToForm,
  extraLinesWarnings,
  openingFloatExample,
  openingFloatFromForm,
  openingFloatSummary,
  openingFloatToForm,
} from './tillSettingsForm';

describe('receipt extra lines: the form', () => {
  it('one box per line (three), the saved ones first', () => {
    expect(extraLinesToForm([])).toEqual(['', '', '']);
    expect(extraLinesToForm(['Insta @test.example'])).toEqual(['Insta @test.example', '', '']);
  });

  it('saves the lines trimmed, in order, empty boxes left out; none at all is fine (the default)', () => {
    expect(extraLinesFromForm(['  Insta @test.example ', '', 'Wi-Fi: TestShop'])).toEqual({
      value: ['Insta @test.example', 'Wi-Fi: TestShop'],
      problem: null,
    });
    expect(extraLinesFromForm(['', ' ', ''])).toEqual({ value: [], problem: null });
  });

  it('64 letters a line; a control character is refused', () => {
    expect(extraLinesFromForm(['x'.repeat(64)]).value).toEqual(['x'.repeat(64)]);
    expect(extraLinesFromForm(['', 'x'.repeat(65)])).toEqual({ value: null, problem: 'Line 2 is 65 letters: keep each line to 64.' });
    expect(extraLinesFromForm(['Bell\u0007'])).toEqual({
      value: null,
      problem: 'Line 1 has a character the printer would take as a command: type it again.',
    });
  });

  it('a letter the printer has no glyph for is a warning, not a refusal (it prints as "?")', () => {
    expect(extraLinesFromForm(['شکریہ', 'Thanks 🍕']).value).toEqual(['شکریہ', 'Thanks 🍕']);
    expect(extraLinesWarnings(['شکریہ', 'Café — “good”', 'Thanks 🍕'])).toEqual([
      'Line 1: ش ک ر ی ہ print as “?” — the receipt printer only has English letters.',
      'Line 3: 🍕 prints as “?” — the receipt printer only has English letters.',
    ]);
  });

  it('History reads the lines', () => {
    expect(extraLinesSummary([])).toBe('No extra lines');
    expect(extraLinesSummary(['A', 'B'])).toBe('“A” · “B”');
  });
});

describe('opening float: the form', () => {
  it('the default reads as the last count', () => {
    expect(openingFloatToForm(DEFAULT_OPENING_FLOAT)).toEqual({ mode: 'lastCount', rupees: '0' });
    expect(openingFloatFromForm({ mode: 'lastCount', rupees: '0' })).toEqual({ value: DEFAULT_OPENING_FLOAT, problem: null });
    expect(openingFloatSummary(DEFAULT_OPENING_FLOAT)).toBe("The last shift's count");
  });

  it('fixed: whole rupees from Rs 0 to Rs 100,000', () => {
    expect(openingFloatFromForm({ mode: 'fixed', rupees: '5,000' })).toEqual({ value: { mode: 'fixed', fixedCents: 500_000 }, problem: null });
    expect(openingFloatFromForm({ mode: 'fixed', rupees: '100000' }).value).toEqual({ mode: 'fixed', fixedCents: 10_000_000 });
    expect(openingFloatFromForm({ mode: 'fixed', rupees: '0' }).value).toEqual({ mode: 'fixed', fixedCents: 0 });
    for (const rupees of ['100001', '50.5', '', '-5', 'abc']) {
      expect({ rupees, problem: openingFloatFromForm({ mode: 'fixed', rupees }).problem }).toEqual({
        rupees,
        problem: 'The fixed float is a whole number of rupees from Rs 0 to Rs 100,000.',
      });
    }
    expect(openingFloatSummary({ mode: 'fixed', fixedCents: 500_000 })).toBe('Rs 5,000 every shift');
  });

  it('back to the last count saves the default itself: no amount is kept, so the card says Default again', () => {
    // Up to the first review a fixed amount typed and left was kept
    // ({ lastCount, 3000 }): the till behaved as the default, but the card
    // showed no "Default", offered "Put back the default", and switching to
    // a fixed amount and back said "Not saved yet".
    for (const rupees of ['3000', '0', 'x', '']) {
      expect({ rupees, value: openingFloatFromForm({ mode: 'lastCount', rupees }).value }).toEqual({ rupees, value: DEFAULT_OPENING_FLOAT });
    }
  });

  it('the example says the count is still typed and the close stays blind', () => {
    for (const s of [DEFAULT_OPENING_FLOAT, { mode: 'fixed' as const, fixedCents: 500_000 }]) {
      expect(openingFloatExample(s)).toContain('still counts the drawer and types the float, and closing stays a blind count');
    }
    expect(openingFloatExample({ mode: 'fixed', fixedCents: 500_000 })).toContain('starts on Rs 5,000 every shift');
  });
});
