import { describe, expect, it } from 'vitest';
import { STEP_IN_WARN_BEFORE_MS, stepInClock } from './stepInClock';

const ENDS = '2026-09-26T12:10:00.000Z';
const endsMs = Date.parse(ENDS);

describe('stepInClock', () => {
  it('warns a minute before the till holds the login', () => {
    expect(stepInClock(ENDS, endsMs - 10 * 60_000)).toEqual({
      warnInMs: 10 * 60_000 - STEP_IN_WARN_BEFORE_MS,
      holdInMs: 10 * 60_000,
    });
  });

  it('inside the last minute (a restart, a late screen): warn now', () => {
    expect(stepInClock(ENDS, endsMs - 20_000)).toEqual({ warnInMs: 0, holdInMs: 20_000 });
  });

  it('at or past the time: no warning, hold now', () => {
    expect(stepInClock(ENDS, endsMs)).toEqual({ warnInMs: null, holdInMs: 0 });
    expect(stepInClock(ENDS, endsMs + 5_000)).toEqual({ warnInMs: null, holdInMs: 0 });
  });

  it('a time that cannot be read: nothing to schedule', () => {
    expect(stepInClock('soon', endsMs)).toBeNull();
  });
});
