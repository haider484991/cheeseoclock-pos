/**
 * ORACLE: the Pakistani till's money and phone answers must never move.
 *
 * Every test here compares the LIVE function against the frozen v0.7.51 copy
 * in baseline-v0.7.51.ts, with no shop locale set and (once there is one) with
 * the default locale. Cheese O'Clock runs two live tills; the international
 * edition must be invisible to them.
 *
 * These tests pass today and must still pass after every phase. A failure
 * means Pakistan's behaviour changed — fix the live code, never the baseline.
 */
import { describe, it, expect } from 'vitest';
import { formatCents, formatNumber } from '../money.js';
import { normalizePhone } from '@cheeseoclock/shared-types';
import { baselineFormatCents, baselineNormalizePhone, seededRandom } from './baseline-v0.7.51.js';

describe('formatCents stays what the pilot prints', () => {
  const edges = [
    0, 1, 9, 10, 50, 99, 100, 101, 110, 150, 999, 1000, 1001,
    64110, 360000, 99999, 100000, 100001, 250050, 999999, 1000000,
    -1, -100, -641_10, -1_725_00, 123_456_789, 2_147_483_647,
  ];

  it('matches the baseline on the edge cases', () => {
    for (const cents of edges) {
      expect(formatCents(cents), `cents=${cents}`).toBe(baselineFormatCents(cents));
      expect(formatCents(cents, { showSymbol: false }), `cents=${cents} bare`).toBe(
        baselineFormatCents(cents, { showSymbol: false }),
      );
    }
  });

  it('matches the baseline on 100k seeded bills', () => {
    const rnd = seededRandom(0x51_07_51);
    for (let i = 0; i < 100_000; i++) {
      // Bills from a few paisa to Rs 1,000,000, plus the odd negative (refunds).
      const magnitude = Math.floor(rnd() * 100_000_000);
      const cents = rnd() < 0.05 ? -magnitude : magnitude;
      const live = formatCents(cents);
      const frozen = baselineFormatCents(cents);
      if (live !== frozen) {
        throw new Error(`formatCents(${cents}) = ${live}, pilot printed ${frozen}`);
      }
    }
  });

  it('still shows the symbol by default and both paisa digits on part rupees', () => {
    // The two rules the comment in money.ts promises, asserted outright so a
    // locale rewrite cannot quietly drop them for Pakistan.
    expect(formatCents(400000)).toBe('Rs 4,000');
    expect(formatCents(64110)).toBe('Rs 641.10');
    expect(formatCents(64110, { showSymbol: false })).toBe('641.10');
  });
});

describe('formatNumber replaces the loose Intl calls without changing them', () => {
  /**
   * About 70 Intl calls around the till passed 'en-PK' straight in, bypassing
   * formatCents. The sweep routes them through formatNumber. That is only
   * safe if formatNumber gives the identical text for the default locale —
   * which is what this proves, option by option.
   */
  const shapes: Array<{ name: string; opts?: Parameters<typeof formatNumber>[1]; intl: Intl.NumberFormatOptions }> = [
    { name: 'plain', intl: {} },
    { name: 'max 1', opts: { maxFractionDigits: 1 }, intl: { maximumFractionDigits: 1 } },
    { name: 'max 2', opts: { maxFractionDigits: 2 }, intl: { maximumFractionDigits: 2 } },
    {
      name: 'min 1 max 2',
      opts: { minFractionDigits: 1, maxFractionDigits: 2 },
      intl: { minimumFractionDigits: 1, maximumFractionDigits: 2 },
    },
    {
      name: 'max 2, no grouping',
      opts: { maxFractionDigits: 2, useGrouping: false },
      intl: { maximumFractionDigits: 2, useGrouping: false },
    },
  ];

  it('matches a direct en-PK Intl call on every shape the till uses', () => {
    const rnd = seededRandom(0x1a_7b_01);
    const values = [0, 1, 7, 10, 99, 100, 1000, 12345, 1_234_567, 0.5, 1.25, 99.995, -42, -0.75];
    for (let i = 0; i < 20_000; i++) values.push(rnd() * 2_000_000 - 100_000);
    for (const shape of shapes) {
      const direct = new Intl.NumberFormat('en-PK', shape.intl);
      for (const v of values) {
        const mine = formatNumber(v, shape.opts);
        const theirs = direct.format(v);
        if (mine !== theirs) {
          throw new Error(`formatNumber(${v}) [${shape.name}] = ${mine}, the till printed ${theirs}`);
        }
      }
    }
  });
});

describe('normalizePhone stays what the pilot stores', () => {
  const edges = [
    '03001234567', '+92 300 1234567', '0092-300-1234567', '300 1234567',
    '  ali  ', '', '   ', null, undefined, '+923001234567', '923001234567',
    '92300123456', '0300-123-4567', '+92(300)1234567', '03001234567 ',
    '1234567890', '12345678901', '+1 415 555 0123', '07700 900123',
    '+44 7700 900123', '000', '+', '++92300123456', '0', '00',
  ];

  it('matches the baseline on the edge cases', () => {
    for (const raw of edges) {
      expect(normalizePhone(raw), `raw=${JSON.stringify(raw)}`).toBe(baselineNormalizePhone(raw));
    }
  });

  it('matches the baseline on 100k seeded inputs', () => {
    const rnd = seededRandom(0x92_03_00);
    const noise = [' ', '-', '(', ')', '+', '.', '/'];
    for (let i = 0; i < 100_000; i++) {
      const digits = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () =>
        String(Math.floor(rnd() * 10)),
      ).join('');
      const lead = rnd();
      let raw = lead < 0.25 ? '0' + digits : lead < 0.5 ? '+92' + digits : lead < 0.7 ? '0092' + digits : digits;
      // Sprinkle the punctuation a real person types.
      if (rnd() < 0.5) {
        const at = Math.floor(rnd() * raw.length);
        raw = raw.slice(0, at) + noise[Math.floor(rnd() * noise.length)] + raw.slice(at);
      }
      const live = normalizePhone(raw);
      const frozen = baselineNormalizePhone(raw);
      if (live !== frozen) {
        throw new Error(`normalizePhone(${JSON.stringify(raw)}) = ${live}, pilot stored ${frozen}`);
      }
    }
  });

  it('keeps the canonical +92 form the customer rows are keyed on', () => {
    // One duplicate-customer guard asserted outright: every spelling of the
    // same human must still collapse to one row.
    const same = ['03001234567', '+92 300 1234567', '0092-300-1234567', '300 1234567'];
    const canonical = same.map((s) => normalizePhone(s));
    expect(new Set(canonical).size, canonical.join(' ')).toBe(1);
    expect(canonical[0]).toBe('+923001234567');
  });
});
