/**
 * Papers print Pakistan time (UTC+5, no daylight saving) whatever the PC's
 * own zone: release CI runs in UTC (windows-latest), a till's Windows zone
 * can be set wrong, and the FBR invoice already carries the Pakistan day.
 * The helpers live in shared-types (no test runner there) and are tested here,
 * where the papers are made. Each case runs with the machine's zone switched
 * to UTC, New York (behind UTC, with daylight saving) and Karachi.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { paperClock, paperDateTime, paperDayMonthClock } from '@cheeseoclock/shared-types';
import { decodeEscPos } from './escpos-decode.js';
import { goldenCases } from './receipt-goldens.fixture.js';

const ZONES = ['UTC', 'America/New_York', 'Asia/Karachi'] as const;
const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

for (const zone of ZONES) {
  describe(`with the PC's zone set to ${zone}`, () => {
    it('14:35 UTC on 14 Sep is 19:35 in Pakistan, as a text, a Date or epoch ms', () => {
      process.env.TZ = zone;
      const iso = '2026-09-14T14:35:00.000Z';
      for (const at of [iso, new Date(iso), Date.parse(iso)]) {
        expect(paperDateTime(at)).toBe('14/09/2026 19:35');
        expect(paperDayMonthClock(at)).toBe('14/09 19:35');
        expect(paperClock(at)).toBe('19:35');
      }
    });

    it('19:30 UTC is already the next day in Pakistan', () => {
      process.env.TZ = zone;
      expect(paperDateTime('2026-09-14T19:30:00.000Z')).toBe('15/09/2026 00:30');
      expect(paperDayMonthClock('2026-09-14T19:30:00.000Z')).toBe('15/09 00:30');
      expect(paperClock('2026-09-14T19:30:00.000Z')).toBe('00:30');
      // The year rolls over too.
      expect(paperDateTime('2026-12-31T19:00:00.000Z')).toBe('01/01/2027 00:00');
    });

    it('a time that does not read prints nothing', () => {
      process.env.TZ = zone;
      for (const garbage of ['not a time', '', new Date('nope'), Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(paperDateTime(garbage)).toBe('');
        expect(paperDayMonthClock(garbage)).toBe('');
        expect(paperClock(garbage)).toBe('');
      }
    });

    it('the papers print it: a receipt paid at 19:35 and a kitchen ticket made at 19:40, Pakistan time', () => {
      process.env.TZ = zone;
      const paper = (name: string) => {
        const c = goldenCases().find((g) => g.name === name);
        if (!c) throw new Error(`no golden paper ${name}`);
        return decodeEscPos(c.render((b) => b)).map((r) => r.text);
      };
      // The fixtures are Pakistan wall-clock instants on 26 Sep 2026 (19:35 there is 14:35 UTC).
      expect(paper('receipt/full/48').some((x) => /^Cashier: Test Cashier\s+26\/09\/2026 19:35$/.test(x))).toBe(true);
      expect(paper('kitchen/48').some((x) => /^26\/09 19:40\s+Test Cashier$/.test(x))).toBe(true);
    });
  });
}
