import { describe, it, expect } from 'vitest';
import { computeTax } from './tax.js';

describe('computeTax', () => {
  it('computes exclusive tax correctly', () => {
    const result = computeTax(10_000, 1600, 'exclusive');
    expect(result.netCents).toBe(10_000);
    expect(result.taxCents).toBe(1_600);
    expect(result.grossCents).toBe(11_600);
  });

  it('computes inclusive tax correctly', () => {
    // PKR 116 inclusive of 16% tax → net 100, tax 16
    const result = computeTax(11_600, 1600, 'inclusive');
    expect(result.netCents).toBe(10_000);
    expect(result.taxCents).toBe(1_600);
    expect(result.grossCents).toBe(11_600);
  });

  it('handles zero-rate tax', () => {
    const result = computeTax(5_000, 0, 'exclusive');
    expect(result.taxCents).toBe(0);
    expect(result.grossCents).toBe(5_000);
  });
});
