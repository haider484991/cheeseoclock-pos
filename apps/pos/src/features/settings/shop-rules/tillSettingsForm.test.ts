import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENING_FLOAT, DEFAULT_PC_POWER, type TillPowerStatus } from '@cheeseoclock/shared-types';
import {
  KEEP_AWAKE_HELP,
  KEEP_AWAKE_LABEL,
  PC_POWER_NEVER_CHANGED,
  extraLinesFromForm,
  extraLinesSummary,
  extraLinesToForm,
  extraLinesWarnings,
  openingFloatExample,
  openingFloatFromForm,
  openingFloatSummary,
  openingFloatToForm,
  pcPowerStatusLines,
  pcPowerSummary,
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

describe('this computer: the words', () => {
  it('History reads both answers, for all four', () => {
    expect(pcPowerSummary({ keepAwake: true, startWithWindows: true })).toBe('Kept awake for website orders · starts with Windows');
    expect(pcPowerSummary({ keepAwake: true, startWithWindows: false })).toBe('Kept awake for website orders · opened by hand');
    expect(pcPowerSummary({ keepAwake: false, startWithWindows: true })).toBe('Windows decides when it sleeps · starts with Windows');
    expect(pcPowerSummary({ keepAwake: false, startWithWindows: false })).toBe('Windows decides when it sleeps · opened by hand');
    expect(pcPowerSummary(DEFAULT_PC_POWER)).toBe('Kept awake for website orders · starts with Windows');
  });

  it('the owner’s words for keeping it awake, and what never changed means', () => {
    expect(KEEP_AWAKE_LABEL).toBe('Keep this computer awake while it takes website orders');
    expect(KEEP_AWAKE_HELP).toBe(
      'While this till takes website orders (a shift is open and online orders are on), the screen stays on and the computer does not go to sleep. Closing a laptop’s lid or pressing the power button still puts it to sleep.',
    );
    expect(PC_POWER_NEVER_CHANGED).toBe('Never changed: this computer stays awake while it takes website orders, and the till starts with Windows.');
  });

  const status = (over: Partial<TillPowerStatus>): TillPowerStatus => ({
    keepAwake: 'on',
    startWithWindows: 'on',
    openedAt: '2026-10-01T09:00:00.000Z',
    lastSleep: null,
    ...over,
  });

  it('keep awake: whether it is held awake right now, in one line each', () => {
    const first = (keepAwake: TillPowerStatus['keepAwake']) => pcPowerStatusLines(status({ keepAwake }))[0];
    expect(first('on')).toEqual({
      tone: 'good',
      text: 'Awake now: this till is taking website orders, so Windows won’t let the screen or the computer sleep.',
    });
    expect(first('idle')).toEqual({
      tone: 'off',
      text: 'Not held awake now: this till is not taking website orders (no shift open, or online orders off). It is kept awake again when it does.',
    });
    expect(first('off')).toEqual({ tone: 'off', text: 'Windows may put this computer to sleep.' });
    expect(first('failed')).toEqual({ tone: 'warn', text: 'Could not keep this computer awake: restart the till. The log file has the reason.' });
  });

  it('start with Windows: "Turn it back on" only when Windows has it switched off or missing', () => {
    const second = (startWithWindows: TillPowerStatus['startWithWindows']) => pcPowerStatusLines(status({ startWithWindows }))[1];
    expect(second('on')).toEqual({ tone: 'good', text: 'Starts with Windows: yes.' });
    expect(second('off')).toEqual({ tone: 'off', text: 'The till does not start with Windows.' });
    expect(second('offInWindows')).toEqual({
      tone: 'warn',
      text: 'Windows has this switched off (Task Manager → Startup apps).',
      action: 'turnBackOn',
    });
    expect(second('missing')).toEqual({ tone: 'warn', text: 'Windows did not take it.', action: 'turnBackOn' });
    expect(second('notInstalled')).toEqual({ tone: 'off', text: 'Only the installed till can start with Windows.' });
  });

  it('the last sleep: from and to, or only from while it never woke; no line when it never slept', () => {
    const at = (iso: string) =>
      new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    expect(pcPowerStatusLines(status({}))).toHaveLength(2);
    expect(
      pcPowerStatusLines(status({ lastSleep: { sleptAt: '2026-10-01T18:05:00.000Z', wokeAt: '2026-10-01T19:40:00.000Z' } }))[2],
    ).toEqual({ tone: 'off', text: `Last time this computer slept: ${at('2026-10-01T18:05:00.000Z')} to ${at('2026-10-01T19:40:00.000Z')}.` });
    expect(pcPowerStatusLines(status({ lastSleep: { sleptAt: '2026-10-01T18:05:00.000Z', wokeAt: null } }))[2]).toEqual({
      tone: 'off',
      text: `Last time this computer slept: ${at('2026-10-01T18:05:00.000Z')}.`,
    });
  });
});
