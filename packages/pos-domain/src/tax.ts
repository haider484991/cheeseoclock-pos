import type { Cents, Bps } from '@cheeseoclock/shared-types';
import { applyBps } from './money.js';

/**
 * Tax-exclusive: customer-shown line price excludes tax. Tax is added on top.
 *   gross = net + tax     where tax = net * rate
 *
 * Tax-inclusive: customer-shown line price already includes tax. Tax is the
 * portion of that price attributable to the tax rate.
 *   gross = net + tax     where net = gross / (1 + rate)
 */

export type TaxMode = 'inclusive' | 'exclusive';

export interface TaxBreakdown {
  /** The pre-tax amount. */
  netCents: Cents;
  /** The tax portion. */
  taxCents: Cents;
  /** netCents + taxCents. */
  grossCents: Cents;
  rateBps: Bps;
}

export function computeTax(
  amountCents: Cents | number,
  rateBps: Bps | number,
  mode: TaxMode,
): TaxBreakdown {
  const amount = amountCents as number;
  const rate = rateBps as number;

  if (mode === 'exclusive') {
    const tax = applyBps(amount, rate);
    return {
      netCents: amount as Cents,
      taxCents: tax,
      grossCents: (amount + (tax as number)) as Cents,
      rateBps: rate as Bps,
    };
  }

  // inclusive: amount is the gross. net = gross / (1 + rate/10000)
  const denom = 10_000 + rate;
  const net = Math.round((amount * 10_000) / denom);
  const tax = amount - net;
  return {
    netCents: net as Cents,
    taxCents: tax as Cents,
    grossCents: amount as Cents,
    rateBps: rate as Bps,
  };
}
