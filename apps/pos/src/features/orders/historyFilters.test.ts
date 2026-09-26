import { describe, expect, it } from 'vitest';
import {
  historyRange,
  isOwed,
  orderTimeLabel,
  pageLabel,
  paymentLabel,
  shortOrderNumber,
  tradingDayOf,
} from './historyFilters';

// Instants in UTC; Pakistan time is UTC+5 and a trading day runs 05:00 →
// 05:00 PKT, i.e. exactly one UTC date. None of this depends on the time
// zone the tests (or the till) run in.
const pkt = (ymd: string, hhmm: string) => new Date(Date.parse(`${ymd}T${hhmm}:00+05:00`));
const dayStart = (ymd: string) => `${ymd}T00:00:00.000Z`; // 05:00 PKT that day

describe('historyRange', () => {
  // Saturday 26 Sep 2026, 2 pm in Karachi.
  const afternoon = pkt('2026-09-26', '14:00');

  it('Today is the trading day, 05:00 to 05:00', () => {
    expect(historyRange('today', afternoon)).toEqual({
      sinceIso: dayStart('2026-09-26'),
      untilIso: dayStart('2026-09-27'),
    });
  });

  it('after midnight, Today is still the evening that started yesterday', () => {
    expect(historyRange('today', pkt('2026-09-27', '00:40'))).toEqual({
      sinceIso: dayStart('2026-09-26'),
      untilIso: dayStart('2026-09-27'),
    });
    // From 05:00 it is the new day.
    expect(historyRange('today', pkt('2026-09-27', '05:00')).sinceIso).toBe(dayStart('2026-09-27'));
  });

  it('Yesterday is the trading day before', () => {
    expect(historyRange('yesterday', afternoon)).toEqual({
      sinceIso: dayStart('2026-09-25'),
      untilIso: dayStart('2026-09-26'),
    });
  });

  it('This week starts on Monday', () => {
    // 26 Sep 2026 is a Saturday → Monday 21 Sep.
    expect(historyRange('week', afternoon)).toEqual({
      sinceIso: dayStart('2026-09-21'),
      untilIso: dayStart('2026-09-27'),
    });
    // On a Monday it is just today.
    expect(historyRange('week', pkt('2026-09-21', '13:00'))).toEqual({
      sinceIso: dayStart('2026-09-21'),
      untilIso: dayStart('2026-09-22'),
    });
    // 1 am on Monday is still Sunday's trading day → the week that began Mon 21.
    expect(historyRange('week', pkt('2026-09-28', '01:00'))).toEqual({
      sinceIso: dayStart('2026-09-21'),
      untilIso: dayStart('2026-09-28'),
    });
  });

  it('All has no bounds', () => {
    expect(historyRange('all', afternoon)).toEqual({});
  });

  it('Pick dates covers both whole days, in either order', () => {
    const want = { sinceIso: dayStart('2026-09-01'), untilIso: dayStart('2026-09-11') };
    expect(historyRange('custom', afternoon, { from: '2026-09-01', to: '2026-09-10' })).toEqual(want);
    expect(historyRange('custom', afternoon, { from: '2026-09-10', to: '2026-09-01' })).toEqual(want);
  });

  it('Pick dates with one side empty (or unreadable) leaves it open', () => {
    expect(historyRange('custom', afternoon, { from: '2026-09-01' })).toEqual({ sinceIso: dayStart('2026-09-01') });
    expect(historyRange('custom', afternoon, { to: '2026-09-01' })).toEqual({ untilIso: dayStart('2026-09-02') });
    expect(historyRange('custom', afternoon, { from: 'soon' })).toEqual({});
    expect(historyRange('custom', afternoon, {})).toEqual({});
  });

  it('trading days are whole UTC dates', () => {
    expect(tradingDayOf(Date.parse('2026-09-26T00:00:00Z'))).toBe(tradingDayOf(Date.parse('2026-09-26T23:59:59Z')));
    expect(tradingDayOf(Date.parse('2026-09-26T23:59:59Z')) + 1).toBe(tradingDayOf(Date.parse('2026-09-27T00:00:00Z')));
  });
});

describe('labels', () => {
  it('short order number', () => {
    expect(shortOrderNumber('20260926-0042')).toBe('#0042');
  });

  it('page label', () => {
    expect(pageLabel(0, 50, 1234)).toBe('Showing 1–50 of 1,234');
    expect(pageLabel(1200, 34, 1234)).toBe('Showing 1,201–1,234 of 1,234');
    expect(pageLabel(0, 0, 0)).toBe('No orders');
  });

  it('time only for today, date too for earlier days — in Karachi time', () => {
    const now = pkt('2026-09-26', '22:00');
    const today = orderTimeLabel(pkt('2026-09-26', '13:05').toISOString(), now);
    expect(today).toMatch(/1:05/);
    expect(today).not.toMatch(/Sep/);
    expect(orderTimeLabel(pkt('2026-09-24', '21:15').toISOString(), now)).toMatch(/Thu 24 Sep.*9:15/);
    // 00:30 belongs to the previous evening's trading day.
    expect(orderTimeLabel(pkt('2026-09-27', '00:30').toISOString(), pkt('2026-09-27', '01:00'))).not.toMatch(/Sep/);
    expect(orderTimeLabel('garbage')).toBe('');
  });

  it('money owed', () => {
    expect(isOwed({ status: 'delivered', paidAt: null })).toBe(true);
    expect(isOwed({ status: 'sent_to_kitchen', paidAt: '2026-09-26T10:00:00Z' })).toBe(false);
    expect(isOwed({ status: 'void', paidAt: null })).toBe(false);
  });

  it('payment column', () => {
    expect(paymentLabel({ status: 'paid', paidAt: 'x', paymentMethods: ['card', 'cash'] })).toBe('Card + Cash');
    expect(paymentLabel({ status: 'delivered', paidAt: null, paymentMethods: [] })).toBe('Not paid');
    expect(paymentLabel({ status: 'void', paidAt: null, paymentMethods: [] })).toBe('—');
    expect(paymentLabel({ status: 'paid', paidAt: 'x', paymentMethods: [] })).toBe('Free');
  });
});
