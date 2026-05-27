import type { Cents } from './money.js';
import type { UUID } from './ids.js';

export interface Shift {
  id: UUID;
  openedByUserId: UUID;
  closedByUserId: UUID | null;
  openedAt: string;
  closedAt: string | null;
  openingCashCents: Cents;
  closingCashCents: Cents | null;
  expectedCashCents: Cents | null;
  varianceCents: Cents | null;
  notes: string | null;
}

export type CashMovementType = 'payout' | 'payin' | 'tip_out';

export interface CashMovement {
  id: UUID;
  shiftId: UUID;
  type: CashMovementType;
  amountCents: Cents;
  reason: string;
  userId: UUID;
  createdAt: string;
}
