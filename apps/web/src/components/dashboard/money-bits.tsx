import { cashVarianceVerdict } from '@cheeseoclock/shared-types';
import { money } from '@/lib/dashboard/format';
import { Pill } from './ui';

/**
 * How a counted drawer reads — the till's own rule (shared-types
 * cashVarianceVerdict): under Re 1 either way is matched; otherwise short
 * or over by the amount.
 */
export function VariancePill({ varianceCents }: { varianceCents: number | null }) {
  if (varianceCents === null) return <Pill tone="info">Open</Pill>;
  const v = cashVarianceVerdict(varianceCents);
  if (v === 'matched') return <Pill tone="good">Matches</Pill>;
  if (v === 'short') return <Pill tone="bad">Short {money(-varianceCents)}</Pill>;
  return <Pill tone="warn">Over {money(varianceCents)}</Pill>;
}

export const CASH_MOVE_WORDS: Record<string, string> = {
  payin: 'Cash in',
  payout: 'Cash out',
  tip_out: 'Rider tip',
};

export const DRAWER_KIND_WORDS: Record<string, string> = {
  no_sale: 'Opened, no sale',
  count: 'Opened to count',
  test: 'Test',
  sale: 'Sale',
  refund: 'Refund',
  float: 'Opening float',
  payin: 'Cash in',
  payout: 'Cash out',
  tip_out: 'Rider tip',
};
