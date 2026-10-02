/**
 * Money on paper (paper-money.ts): the receipt's own formatter, moved out of
 * receipt-renderer.ts for the shift report, plus the shift report's signed
 * figure (OVER / SHORT) and its whole-rupee note faces ("Rs 5,000 x 12").
 * The receipts themselves stay byte for byte what they were: that is
 * receipt-extra-lines.test.ts's fingerprint check of every golden paper.
 * Every figure here is made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CASH_NOTE_FACE_CENTS } from '@cheeseoclock/shared-types';
import { decodeEscPos } from './escpos-decode.js';
import { paperMoney, paperRupees, paperSignedMoney } from './paper-money.js';
import { goldenCases } from './receipt-goldens.fixture.js';
import * as printerCore from './index.js';

/** The money shape on paper: "-1,234,567.89". */
const MONEY_SHAPE = /^-?\d{1,3}(,\d{3})*\.\d{2}$/;

/** A second, independent way to write paperMoney: digits grouped by slicing, no regex. */
function moneyByHand(cents: number): string {
  const n = Math.abs(cents);
  const digits = String(Math.floor(n / 100));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return `${cents < 0 ? '-' : ''}${groups.join(',')}.${String(n % 100).padStart(2, '0')}`;
}

/** Back to cents: "-1,725.00" -> -172500. */
function centsOf(text: string): number {
  const negative = text.startsWith('-');
  const [rupees = '', paisa = ''] = text.replace(/^[-+]/, '').replace(/,/g, '').split('.');
  const value = Number(rupees) * 100 + Number(paisa);
  return negative ? -value : value;
}

/** mulberry32: the same made-up figures on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 3,000 figures from Rs 0.00 to about Rs 90 billion, every size of number, both signs. */
function figures(): number[] {
  const random = seeded(19_501);
  const out: number[] = [];
  for (let i = 0; i < 3_000; i += 1) {
    const digits = 1 + Math.floor(random() * 13);
    const cents = Math.floor(random() * 10 ** digits);
    // Never -0: it is a zero, which the cases above pin on their own.
    out.push(random() < 0.3 && cents > 0 ? -cents : cents);
  }
  return out;
}

describe('paperMoney', () => {
  it('groups rupees in threes and always prints both paisa digits', () => {
    expect(paperMoney(0)).toBe('0.00');
    expect(paperMoney(5)).toBe('0.05');
    expect(paperMoney(99)).toBe('0.99');
    expect(paperMoney(100)).toBe('1.00');
    expect(paperMoney(8_500)).toBe('85.00');
    expect(paperMoney(99_999)).toBe('999.99');
    expect(paperMoney(100_000)).toBe('1,000.00');
    expect(paperMoney(360_000)).toBe('3,600.00');
    expect(paperMoney(306_308)).toBe('3,063.08');
    expect(paperMoney(9_999_999)).toBe('99,999.99');
    expect(paperMoney(16_876_000)).toBe('168,760.00');
    expect(paperMoney(100_000_000)).toBe('1,000,000.00');
    expect(paperMoney(123_456_789_01)).toBe('123,456,789.01');
  });

  it('puts a minus in front of a negative figure, and none on zero', () => {
    expect(paperMoney(-172_500)).toBe('-1,725.00');
    expect(paperMoney(-762_000)).toBe('-7,620.00');
    expect(paperMoney(-10_000)).toBe('-100.00');
    expect(paperMoney(-5)).toBe('-0.05');
    expect(paperMoney(-100_000_000)).toBe('-1,000,000.00');
    expect(paperMoney(-0)).toBe('0.00');
  });

  it('writes 3,000 made-up figures the same as grouping by hand, and they read back to the same cents', () => {
    for (const cents of figures()) {
      const text = paperMoney(cents);
      expect(text).toBe(moneyByHand(cents));
      expect(text).toMatch(MONEY_SHAPE);
      expect(centsOf(text)).toBe(cents);
    }
  });
});

describe('paperSignedMoney', () => {
  it("gives OVER a '+', keeps SHORT's '-', and leaves a match plain", () => {
    expect(paperSignedMoney(25_000)).toBe('+250.00');
    expect(paperSignedMoney(1)).toBe('+0.01');
    expect(paperSignedMoney(250_000_00)).toBe('+250,000.00');
    expect(paperSignedMoney(-10_000)).toBe('-100.00');
    expect(paperSignedMoney(0)).toBe('0.00');
    expect(paperSignedMoney(-0)).toBe('0.00');
  });

  it('is paperMoney with a + above zero, for every made-up figure', () => {
    for (const cents of figures()) {
      expect(paperSignedMoney(cents)).toBe(cents > 0 ? `+${paperMoney(cents)}` : paperMoney(cents));
      expect(centsOf(paperSignedMoney(cents))).toBe(cents);
    }
  });
});

describe('paperRupees', () => {
  it('writes the seven note faces of the count as whole rupees, in the owner\'s order', () => {
    expect(CASH_NOTE_FACE_CENTS.map(paperRupees)).toEqual(['5,000', '1,000', '500', '100', '50', '20', '10']);
  });

  it('groups like paperMoney, with no paisa', () => {
    expect(paperRupees(0)).toBe('0');
    expect(paperRupees(100)).toBe('1');
    expect(paperRupees(10_000_000)).toBe('100,000');
    expect(paperRupees(123_456_789_00)).toBe('123,456,789');
    expect(paperRupees(-100_000)).toBe('-1,000');
    for (const cents of figures()) {
      const whole = cents - (cents % 100);
      expect(paperRupees(whole)).toBe(paperMoney(whole).slice(0, -3));
    }
  });

  it('keeps the paisa of a figure that is not whole rupees, never rounding it away', () => {
    expect(paperRupees(750)).toBe('7.50');
    expect(paperRupees(100_001)).toBe('1,000.01');
    expect(paperRupees(-50)).toBe('-0.50');
  });

  it("makes the sample paper's CASH COUNTED rows with paperMoney", () => {
    const counted: Array<[number, number, string, string]> = [
      [500_000, 12, 'Rs 5,000 x 12', '60,000.00'],
      [100_000, 24, 'Rs 1,000 x 24', '24,000.00'],
      [50_000, 15, 'Rs 500 x 15', '7,500.00'],
      [10_000, 31, 'Rs 100 x 31', '3,100.00'],
      [5_000, 14, 'Rs 50 x 14', '700.00'],
      [2_000, 18, 'Rs 20 x 18', '360.00'],
      [1_000, 23, 'Rs 10 x 23', '230.00'],
    ];
    for (const [face, count, label, amount] of counted) {
      expect(`Rs ${paperRupees(face)} x ${count}`).toBe(label);
      expect(paperMoney(face * count)).toBe(amount);
    }
  });
});

describe('no locale, ASCII only', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never asks the PC's locale (toLocaleString or Intl)", () => {
    const refuse = () => {
      throw new Error('a paper must not follow the PC locale');
    };
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(refuse);
    vi.spyOn(Intl, 'NumberFormat').mockImplementation(refuse);
    expect(paperMoney(16_876_000)).toBe('168,760.00');
    expect(paperSignedMoney(25_000)).toBe('+250.00');
    expect(paperRupees(500_000)).toBe('5,000');
  });

  it('prints only digits, commas, a point and a sign', () => {
    for (const cents of figures()) {
      for (const text of [paperMoney(cents), paperSignedMoney(cents), paperRupees(cents)]) {
        expect(text).toMatch(/^[-+]?[0-9,.]+$/);
      }
    }
  });
});

describe('the package and the receipts', () => {
  it('index.ts exports the three helpers', () => {
    expect(printerCore.paperMoney).toBe(paperMoney);
    expect(printerCore.paperSignedMoney).toBe(paperSignedMoney);
    expect(printerCore.paperRupees).toBe(paperRupees);
  });

  it('every figure with paisa on every golden paper is written the paperMoney way', () => {
    const cases = goldenCases();
    expect(cases.length).toBeGreaterThan(0);
    let seen = 0;
    for (const c of cases) {
      for (const row of decodeEscPos(c.render((b) => b))) {
        for (const figure of row.text.match(/-?[0-9][0-9,]*\.[0-9]{2}(?![0-9])/g) ?? []) {
          expect({ paper: c.name, figure: paperMoney(centsOf(figure)) }).toEqual({ paper: c.name, figure });
          seen += 1;
        }
      }
    }
    // The papers carry thousands of figures; a decode that found none would prove nothing.
    expect(seen).toBeGreaterThan(1_000);
  });
});
