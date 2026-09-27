import { describe, expect, it } from 'vitest';
import { AUTO_REFRESH_MAX_DAYS, autoRefreshes, daysSoFar, fmtDateInput, fmtDays, periodFor, tradingDayStart, weekdayIndex } from './dateRange';

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

describe('autoRefreshes: the open report refreshes itself only when it is cheap and useful', () => {
  it('today, this week and this month refresh while on screen', () => {
    for (const preset of ['today', 'thisWeek', 'thisMonth', 'last7'] as const) {
      expect(autoRefreshes(periodFor(preset, SAT_3PM), true)).toBe(true);
    }
  });

  it('never while the window is hidden', () => {
    expect(autoRefreshes(periodFor('today', SAT_3PM), false)).toBe(false);
  });

  it('never for a period that is over (yesterday, last month)', () => {
    expect(autoRefreshes(periodFor('yesterday', SAT_3PM), true)).toBe(false);
    expect(autoRefreshes(periodFor('lastMonth', SAT_3PM), true)).toBe(false);
  });

  it('"Today" left open past 5 am still refreshes once, onto the new trading day', () => {
    const today = periodFor('today', SAT_3PM);
    expect(autoRefreshes(today, true)).toBe(true);
    // The tick recomputes the period with the new clock: Sunday's "Today".
    const next = periodFor('today', new Date('2026-09-27T00:01:00.000Z'));
    expect(next.firstDay).toBe('2026-09-27');
    expect(autoRefreshes(next, true)).toBe(true);
  });

  it('31 days that include today refresh; 32 days never do', () => {
    const thirtyOne = periodFor('custom', SAT_3PM, { from: '2026-08-27', to: '2026-09-26' });
    expect(thirtyOne.days).toBe(AUTO_REFRESH_MAX_DAYS);
    expect(autoRefreshes(thirtyOne, true)).toBe(true);
    const thirtyTwo = periodFor('custom', SAT_3PM, { from: '2026-08-26', to: '2026-09-26' });
    expect(thirtyTwo.days).toBe(32);
    expect(autoRefreshes(thirtyTwo, true)).toBe(false);
  });
});

describe('year presets (costing spec Phase 3)', () => {
  it('this year: 1 January to 31 December, so far, against last year by this date', () => {
    const p = periodFor('thisYear', SAT_3PM);
    expect(p).toMatchObject({
      sinceIso: '2026-01-01T00:00:00.000Z',
      untilIso: '2027-01-01T00:00:00.000Z',
      days: 365,
      title: 'This year',
      dates: 'Thu 1 Jan – Thu 31 Dec 2026',
      isCurrent: true,
    });
    expect(p.compare).toEqual({
      sinceIso: '2025-01-01T00:00:00.000Z',
      untilIso: '2025-09-26T10:00:00.000Z',
      label: 'last year by this date',
    });
  });

  it('last 12 months runs to today, from the day after this date a year ago', () => {
    const p = periodFor('last12', SAT_3PM);
    expect(p).toMatchObject({
      sinceIso: '2025-09-27T00:00:00.000Z',
      untilIso: '2026-09-27T00:00:00.000Z',
      days: 365,
      title: 'Last 12 months',
      isCurrent: true,
    });
    expect(p.compare).toEqual({
      sinceIso: '2024-09-27T00:00:00.000Z',
      untilIso: '2025-09-26T10:00:00.000Z',
      label: 'the 12 months before',
    });
  });

  it('last year is the whole calendar year before, against the year before that', () => {
    const p = periodFor('lastYear', SAT_3PM);
    expect(p).toMatchObject({
      sinceIso: '2025-01-01T00:00:00.000Z',
      untilIso: '2026-01-01T00:00:00.000Z',
      days: 365,
      title: 'Last year',
      dates: 'Wed 1 Jan – Wed 31 Dec 2025',
      isCurrent: false,
    });
    expect(p.compare).toEqual({ sinceIso: '2024-01-01T00:00:00.000Z', untilIso: '2025-01-01T00:00:00.000Z', label: 'the year before' });
  });

  it('at 00:30 on 1 January the trading day is still 31 December: "this year" is still the old one', () => {
    const halfPastMidnight = new Date('2026-12-31T19:30:00.000Z'); // 00:30 on 1 Jan 2027 in Pakistan
    expect(periodFor('thisYear', halfPastMidnight)).toMatchObject({
      sinceIso: '2026-01-01T00:00:00.000Z',
      untilIso: '2027-01-01T00:00:00.000Z',
      isCurrent: true,
    });
    expect(periodFor('lastYear', halfPastMidnight).sinceIso).toBe('2025-01-01T00:00:00.000Z');
    expect(periodFor('last12', halfPastMidnight)).toMatchObject({ sinceIso: '2026-01-01T00:00:00.000Z', untilIso: '2027-01-01T00:00:00.000Z' });
  });

  it('at 5 am on 1 January the new year starts; nothing to compare until time has passed', () => {
    const fiveAm = new Date('2027-01-01T00:00:00.000Z');
    const p = periodFor('thisYear', fiveAm);
    expect(p).toMatchObject({ sinceIso: '2027-01-01T00:00:00.000Z', untilIso: '2028-01-01T00:00:00.000Z', days: 365, isCurrent: true });
    expect(p.compare).toBeNull();
    expect(periodFor('lastYear', fiveAm)).toMatchObject({ sinceIso: '2026-01-01T00:00:00.000Z', untilIso: '2027-01-01T00:00:00.000Z' });
    // By 11 am, the same six hours of last 1 January.
    expect(periodFor('thisYear', new Date('2027-01-01T06:00:00.000Z')).compare).toEqual({
      sinceIso: '2026-01-01T00:00:00.000Z',
      untilIso: '2026-01-01T06:00:00.000Z',
      label: 'last year by this date',
    });
  });

  it('29 February: a leap year has 366 days, and last year compares up to 28 February', () => {
    const leapDay = new Date('2028-02-29T10:00:00.000Z'); // 3 pm, Tue 29 Feb 2028
    const year = periodFor('thisYear', leapDay);
    expect(year).toMatchObject({ sinceIso: '2028-01-01T00:00:00.000Z', untilIso: '2029-01-01T00:00:00.000Z', days: 366 });
    expect(year.compare).toEqual({ sinceIso: '2027-01-01T00:00:00.000Z', untilIso: '2027-02-28T10:00:00.000Z', label: 'last year by this date' });
    // The day after, last year's same date again (not a day late).
    expect(periodFor('thisYear', new Date('2028-03-01T10:00:00.000Z')).compare?.untilIso).toBe('2027-03-01T10:00:00.000Z');

    // Twelve months to a 29 February start on 1 March and cover 366 days.
    const twelve = periodFor('last12', leapDay);
    expect(twelve).toMatchObject({ sinceIso: '2027-03-01T00:00:00.000Z', untilIso: '2028-03-01T00:00:00.000Z', days: 366 });
    expect(twelve.compare).toEqual({ sinceIso: '2026-03-01T00:00:00.000Z', untilIso: '2027-03-01T00:00:00.000Z', label: 'the 12 months before' });
    // …and twelve months to the next 28 February still reach back to 29 February.
    expect(periodFor('last12', new Date('2029-02-28T10:00:00.000Z'))).toMatchObject({ sinceIso: '2028-02-29T00:00:00.000Z', days: 366 });

    const lastYear = periodFor('lastYear', new Date('2029-01-10T10:00:00.000Z'));
    expect(lastYear).toMatchObject({ sinceIso: '2028-01-01T00:00:00.000Z', untilIso: '2029-01-01T00:00:00.000Z', days: 366, dates: 'Sat 1 Jan – Sun 31 Dec 2028' });
  });

  it('a year never refreshes by itself (over 31 days)', () => {
    for (const preset of ['thisYear', 'last12', 'lastYear'] as const) {
      expect(autoRefreshes(periodFor(preset, SAT_3PM), true)).toBe(false);
    }
  });
});
