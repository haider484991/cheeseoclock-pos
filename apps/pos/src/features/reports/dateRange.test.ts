import { describe, expect, it } from 'vitest';
import { daysSoFar, fmtDateInput, fmtDays, periodFor, tradingDayStart, weekdayIndex } from './dateRange';

// Sat 26 Sep 2026, 3 pm in Pakistan (10:00 UTC).
const SAT_3PM = new Date('2026-09-26T10:00:00.000Z');

describe('trading day (05:00 → 05:00 Pakistan time)', () => {
  it('keeps the small hours in the night before', () => {
    // 00:40 on the 27th in Pakistan is still the 26th's trading day…
    expect(tradingDayStart(new Date('2026-09-26T19:40:00.000Z')).toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(fmtDateInput('2026-09-26T19:40:00.000Z')).toBe('2026-09-26');
    // …and so is 04:59:59…
    expect(fmtDateInput('2026-09-26T23:59:59.999Z')).toBe('2026-09-26');
    // …but 05:00 starts the 27th.
    expect(fmtDateInput('2026-09-27T00:00:00.000Z')).toBe('2026-09-27');
    expect(periodFor('today', new Date('2026-09-26T19:40:00.000Z')).sinceIso).toBe('2026-09-26T00:00:00.000Z');
  });

  it('numbers weekdays from Monday', () => {
    // 1970-01-01 was a Thursday; 2026-09-26 is a Saturday.
    expect(weekdayIndex(0)).toBe(3);
    expect(weekdayIndex(Date.UTC(2026, 8, 26) / 86_400_000)).toBe(5);
    expect(weekdayIndex(Date.UTC(2026, 8, 21) / 86_400_000)).toBe(0);
  });
});

describe('periodFor', () => {
  it('today: so far, against yesterday by this time', () => {
    const p = periodFor('today', SAT_3PM);
    expect(p).toMatchObject({
      sinceIso: '2026-09-26T00:00:00.000Z',
      untilIso: '2026-09-27T00:00:00.000Z',
      days: 1,
      title: 'Today',
      dates: 'Sat 26 Sep 2026',
      isCurrent: true,
    });
    expect(p.compare).toEqual({
      sinceIso: '2026-09-25T00:00:00.000Z',
      untilIso: '2026-09-25T10:00:00.000Z',
      label: 'yesterday by this time',
    });
  });

  it('yesterday: the whole day, against the day before', () => {
    const p = periodFor('yesterday', SAT_3PM);
    expect(p).toMatchObject({ sinceIso: '2026-09-25T00:00:00.000Z', untilIso: '2026-09-26T00:00:00.000Z', isCurrent: false });
    expect(p.compare).toEqual({ sinceIso: '2026-09-24T00:00:00.000Z', untilIso: '2026-09-25T00:00:00.000Z', label: 'the day before' });
  });

  it('this week runs Monday to Sunday, against last week by this time', () => {
    const p = periodFor('thisWeek', SAT_3PM);
    expect(p).toMatchObject({
      sinceIso: '2026-09-21T00:00:00.000Z',
      untilIso: '2026-09-28T00:00:00.000Z',
      days: 7,
      dates: 'Mon 21 Sep – Sun 27 Sep 2026',
      isCurrent: true,
    });
    expect(p.compare).toEqual({
      sinceIso: '2026-09-14T00:00:00.000Z',
      untilIso: '2026-09-19T10:00:00.000Z',
      label: 'last week by this time',
    });
  });

  it('last 7 days includes today', () => {
    const p = periodFor('last7', SAT_3PM);
    expect(p).toMatchObject({ sinceIso: '2026-09-20T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z', days: 7 });
    expect(p.compare?.sinceIso).toBe('2026-09-13T00:00:00.000Z');
    expect(p.compare?.untilIso).toBe('2026-09-19T10:00:00.000Z');
  });

  it('this month compares with last month by the same date', () => {
    const p = periodFor('thisMonth', SAT_3PM);
    expect(p).toMatchObject({ sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-10-01T00:00:00.000Z', days: 30 });
    expect(p.compare).toEqual({
      sinceIso: '2026-08-01T00:00:00.000Z',
      untilIso: '2026-08-26T10:00:00.000Z',
      label: 'last month by this date',
    });
  });

  it('never lets "last month by this date" run into this month', () => {
    // 31 March: February has only 28 days.
    const p = periodFor('thisMonth', new Date('2027-03-31T10:00:00.000Z'));
    expect(p.compare?.sinceIso).toBe('2027-02-01T00:00:00.000Z');
    expect(p.compare?.untilIso).toBe('2027-03-01T00:00:00.000Z');
  });

  it('last month is the whole calendar month, across a new year too', () => {
    const p = periodFor('lastMonth', SAT_3PM);
    expect(p).toMatchObject({
      sinceIso: '2026-08-01T00:00:00.000Z',
      untilIso: '2026-09-01T00:00:00.000Z',
      dates: 'Sat 1 Aug – Mon 31 Aug 2026',
      isCurrent: false,
    });
    expect(p.compare).toEqual({ sinceIso: '2026-07-01T00:00:00.000Z', untilIso: '2026-08-01T00:00:00.000Z', label: 'the month before' });

    const jan = periodFor('lastMonth', new Date('2027-01-10T10:00:00.000Z'));
    expect(jan.sinceIso).toBe('2026-12-01T00:00:00.000Z');
    expect(jan.untilIso).toBe('2027-01-01T00:00:00.000Z');
    expect(jan.compare?.sinceIso).toBe('2026-11-01T00:00:00.000Z');
  });

  it('custom dates cover whole trading days and compare with as many days before', () => {
    const p = periodFor('custom', SAT_3PM, { from: '2026-09-10', to: '2026-09-12' });
    expect(p).toMatchObject({
      sinceIso: '2026-09-10T00:00:00.000Z',
      untilIso: '2026-09-13T00:00:00.000Z',
      days: 3,
      title: 'Your dates',
      isCurrent: false,
    });
    expect(p.compare).toEqual({ sinceIso: '2026-09-07T00:00:00.000Z', untilIso: '2026-09-10T00:00:00.000Z', label: 'the 3 days before' });
    // Picked the wrong way round: swapped, not an error.
    expect(periodFor('custom', SAT_3PM, { from: '2026-09-12', to: '2026-09-10' }).sinceIso).toBe('2026-09-10T00:00:00.000Z');
    // Nonsense falls back to today.
    expect(periodFor('custom', SAT_3PM, { from: '2026-02-30', to: 'x' }).sinceIso).toBe('2026-09-26T00:00:00.000Z');
    // A custom range reaching today is "so far", like the presets.
    const toToday = periodFor('custom', SAT_3PM, { from: '2026-09-25', to: '2026-09-26' });
    expect(toToday.isCurrent).toBe(true);
    expect(toToday.compare?.untilIso).toBe('2026-09-24T10:00:00.000Z');
  });
});

describe('labels', () => {
  it('writes dates the way people read them', () => {
    expect(fmtDays('2026-09-26', '2026-09-26')).toBe('Sat 26 Sep 2026');
    expect(fmtDays('2026-12-28', '2027-01-03')).toBe('Mon 28 Dec 2026 – Sun 3 Jan 2027');
  });

  it('lists the days of a period that have started', () => {
    const month = periodFor('thisMonth', SAT_3PM);
    const days = daysSoFar(month, SAT_3PM);
    expect(days).toHaveLength(26);
    expect(days[0]).toBe('2026-09-01');
    expect(days[25]).toBe('2026-09-26');
  });
});
