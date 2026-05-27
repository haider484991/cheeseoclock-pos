import type { Cents } from '@cheeseoclock/shared-types';
import { multCents, sumCents } from './money.js';

export interface LineModifier {
  priceDeltaCents: Cents | number;
}

export interface LineInput {
  unitPriceCents: Cents | number;
  quantity: number;
  modifiers: LineModifier[];
}

/** Compute a line total (qty * (unit + sum(modifiers))) in cents. */
export function computeLineTotalCents(line: LineInput): Cents {
  const modSum = sumCents(line.modifiers.map((m) => m.priceDeltaCents));
  const perUnit = (line.unitPriceCents as number) + (modSum as number);
  return multCents(perUnit, line.quantity);
}
