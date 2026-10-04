/**
 * The till's licence, as the card, the banner and the sales guard see it.
 * Worked out in apps/pos/electron/services/licence/licence-core.ts.
 */
export type LicenceState =
  /** No key yet; the 30-day free trial is running. */
  | 'trial'
  /** A genuine key for this till, paid period running. */
  | 'active'
  /** Paid period over; still selling through the grace days, with a reminder. */
  | 'grace'
  /** Trial or grace over: sales are stopped until a key is entered. */
  | 'expired';

export type LicencePlanName = 'starter' | 'pro' | 'business';

export interface LicenceStatus {
  state: LicenceState;
  /** Plain words for the card and the banner. */
  message: string;
  /** This till's Device ID — the vendor needs it to issue a key. */
  deviceId: string;
  plan: LicencePlanName | null;
  shop: string | null;
  licenceId: string | null;
  /** ISO. Trial: when it ends. Licensed: paid until. */
  paidUntil: string | null;
  /** Days until sales stop (trial end, or paid-until plus grace); negative once stopped. */
  daysLeft: number;
  /** False stops new orders and payments; reports, backups and settings stay open. */
  salesAllowed: boolean;
  /** Why a stored key is being ignored (wrong till, not genuine, damaged); null when fine. */
  problem: string | null;
}
