/**
 * Settings → Money & discounts → "Buy 1 Get 1 deals": the form's rules (buy1Get1Form.ts) — what is saved, the hours
 * lists, and the words under the card.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUY_1_GET_1_DEALS } from '@cheeseoclock/shared-types';
import {
  buy1Get1Example,
  buy1Get1FromForm,
  buy1Get1ToForm,
  hourOptions,
  hoursNote,
  minuteLabel,
} from './buy1Get1Form';

const form = buy1Get1ToForm(DEFAULT_BUY_1_GET_1_DEALS);

describe('the Buy 1 Get 1 card', () => {
  it('saves what is picked, in the format this version writes; the poster’s rules round-trip', () => {
    expect(form).toEqual({ on: true, opensMinute: 780, closesMinute: 1140, asksSocial: true });
    expect(buy1Get1FromForm(form)).toEqual({ value: { ...DEFAULT_BUY_1_GET_1_DEALS }, problem: null });
    expect(buy1Get1FromForm({ ...form, on: false, asksSocial: false }).value).toEqual({
      v: 1,
      on: false,
      opensMinute: 780,
      closesMinute: 1140,
      asksSocial: false,
    });
  });

  it('refuses the same start and end, in words', () => {
    expect(buy1Get1FromForm({ ...form, opensMinute: 600, closesMinute: 600 })).toEqual({
      value: null,
      problem: 'The Buy 1 Get 1 deals start and end at the same time: pick a different end',
    });
  });

  it('lists every half hour: From 12:00 AM to 11:30 PM, Until 12:30 AM to midnight', () => {
    const from = hourOptions('from', 780);
    expect(from).toHaveLength(48);
    expect(from[0]).toEqual({ minute: 0, label: '12:00 AM' });
    expect(from[from.length - 1]).toEqual({ minute: 1410, label: '11:30 PM' });
    const to = hourOptions('to', 1140);
    expect(to).toHaveLength(48);
    expect(to[0]).toEqual({ minute: 30, label: '12:30 AM' });
    expect(to[to.length - 1]).toEqual({ minute: 1440, label: '12:00 AM (midnight)' });
    expect(to.find((o) => o.minute === 720)?.label).toBe('12:00 PM (noon)');
    expect(to.find((o) => o.minute === 1140)?.label).toBe('7:00 PM');
  });

  it('shows a saved minute between two half hours as it is, in order (never moved)', () => {
    const from = hourOptions('from', 13 * 60 + 15);
    expect(from).toHaveLength(49);
    const i = from.findIndex((o) => o.minute === 795);
    expect(from[i]).toEqual({ minute: 795, label: '1:15 PM' });
    expect(from[i - 1]!.minute).toBe(780);
    expect(from[i + 1]!.minute).toBe(810);
    expect(minuteLabel(0)).toBe('12:00 AM');
    expect(minuteLabel(13 * 60 + 5)).toBe('1:05 PM');
  });

  it('says what the hours mean, past midnight too', () => {
    expect(hoursNote(form)).toBe('Every day 1–7 PM, Karachi time.');
    expect(hoursNote({ opensMinute: 22 * 60, closesMinute: 60 })).toBe('Every day 10 PM–1 AM: past midnight, into the next morning.');
    expect(hoursNote({ opensMinute: 0, closesMinute: 1440 })).toBe('Every day, all day.');
    expect(hoursNote({ opensMinute: 600, closesMinute: 600 })).toBe('Every day, Karachi time.');
  });

  it('works the example: on with the name asked, optional, or off', () => {
    expect(buy1Get1Example(form)).toMatch(/^Buy 1 Get 1 deals are sold from 1 PM to 7 PM\. Outside the hours the till greys them/);
    expect(buy1Get1Example(form)).toMatch(/must type their Instagram or Facebook name/);
    expect(buy1Get1Example({ ...form, asksSocial: false })).toMatch(/name is optional/);
    expect(buy1Get1Example({ ...form, on: false })).toMatch(/^The deals are greyed on the till and hidden on the website/);
    expect(buy1Get1Example({ ...form, opensMinute: 600, closesMinute: 600 })).toBe('Pick the hours to see what they mean.');
  });
});
