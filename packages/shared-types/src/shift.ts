import type { Cents } from './money.js';
import type { UUID } from './ids.js';

export interface Shift {
  id: UUID;
  deviceId: string;
  openedByUserId: UUID;
  openedByName: string;
  closedByUserId: UUID | null;
  closedByName: string | null;
  openedAt: string;
  closedAt: string | null;
  openingCashCents: Cents;
  /** Manager's drawer count at close. Null while open. */
  countedCashCents: Cents | null;
  /** Computed at close: opening + cash sales − cash refunds. */
  expectedCashCents: Cents | null;
  /** counted − expected (negative = short, positive = over). */
  varianceCents: Cents | null;
  notes: string | null;
}

/** Per-shift summary numbers used by the close dialog + history view. */
export interface ShiftSummary {
  shiftId: UUID;
  orderCount: number;
  paidOrderCount: number;
  refundedOrderCount: number;
  voidedOrderCount: number;
  totalRevenueCents: Cents;
  totalRefundsCents: Cents;
  netRevenueCents: Cents;
  cashSalesCents: Cents;
  cashRefundsCents: Cents;
  /** opening + cashSales − cashRefunds. */
  expectedCashCents: Cents;
  byMethod: Array<{
    method: string;
    salesCents: Cents;
    refundCents: Cents;
    netCents: Cents;
  }>;
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
