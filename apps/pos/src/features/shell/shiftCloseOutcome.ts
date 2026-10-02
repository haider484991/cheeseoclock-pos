import { create } from 'zustand';
import type { CashCount, ShiftSummary } from '@cheeseoclock/shared-types';
import { useSessionStore } from '../../stores/sessionStore';

/**
 * What a shift close came to — Expected, Counted and Over / Short — kept on
 * screen until the person who closed it taps Done.
 *
 * Closing refreshes the shift status: the top-bar pill turns grey "Open
 * shift", and the close box, which only existed while a shift was open, went
 * with it, so the result vanished the moment it was worked out (audit
 * 2026-09-27). It lives here, outside the widget's "shift open" branch, and is
 * shown to the same login that closed the shift and nobody else: a sign-out,
 * the idle lock or a hand-back to the cashier forgets it (see below), exactly
 * as the old close box went with its login.
 *
 * Closed with a manager's PIN on a cashier's login (owner, 2026-09-27), the
 * login is the cashier's: the manager standing there sees Counted and Over /
 * Short, never the expected cash or the takings, and the result goes by
 * itself after PIN_CLOSE_RESULT_MS — a cashier's login has no idle lock, so
 * it is not left up for the cashier once the manager has walked away.
 */
export interface ShiftCloseOutcome {
  /** The login that closed the shift — the only one the result is shown to. */
  sessionId: string;
  shiftId: string;
  /** What the drawer should have held; null on a manager's PIN (never on a cashier's screen). */
  expectedCents: number | null;
  countedCents: number;
  /**
   * The notes counted (v0.7.35: the close counts the drawer note by note),
   * shown on one line under Counted, on either close; null when the till's
   * reply has none (a shift closed on an older till).
   */
  countedNotes: CashCount | null;
  /** counted − expected: negative is short, positive is over. */
  varianceCents: number;
  /**
   * The shift's takings as the close box had them: null when they had not
   * loaded, and always on a cashier's login (a manager's PIN closed it there,
   * and the shift's totals are never fetched on a cashier's login).
   */
  summary: ShiftSummary | null;
  /** The manager (or owner) the shift was closed by. */
  closedByName: string | null;
  /** Unpaid orders carried over to the next shift by this close. */
  carriedUnpaidCount: number;
  /** Closed with a manager's PIN on a cashier's login: shown briefly, and without the expected cash. */
  viaManagerPin: boolean;
}

/** How long a close result stays up on a cashier's login (a manager's PIN) before it goes by itself. */
export const PIN_CLOSE_RESULT_MS = 60_000;

export const useShiftCloseOutcome = create<{ outcome: ShiftCloseOutcome | null }>(() => ({ outcome: null }));

let pinCloseTimer: ReturnType<typeof setTimeout> | null = null;
function clearPinCloseTimer(): void {
  if (pinCloseTimer !== null) clearTimeout(pinCloseTimer);
  pinCloseTimer = null;
}

/** Keep the close result on screen (the close box calls this once the shift is closed). */
export function showShiftCloseOutcome(outcome: ShiftCloseOutcome): void {
  clearPinCloseTimer();
  useShiftCloseOutcome.setState({ outcome });
  if (outcome.viaManagerPin) {
    pinCloseTimer = setTimeout(() => {
      pinCloseTimer = null;
      if (useShiftCloseOutcome.getState().outcome === outcome) useShiftCloseOutcome.setState({ outcome: null });
    }, PIN_CLOSE_RESULT_MS);
  }
}

/** "Done": the result goes. */
export function dismissShiftCloseOutcome(): void {
  clearPinCloseTimer();
  useShiftCloseOutcome.setState({ outcome: null });
}

/** The result to show to whoever is signed in now: only the login that closed the shift sees it. */
export function outcomeFor(
  outcome: ShiftCloseOutcome | null,
  user: { sessionId: string } | null,
): ShiftCloseOutcome | null {
  return outcome && user && outcome.sessionId === user.sessionId ? outcome : null;
}

// Someone else at the till (sign-out, idle lock, hand back to the cashier):
// the result is forgotten, not left waiting for whoever signs in next.
useSessionStore.subscribe((state) => {
  const { outcome } = useShiftCloseOutcome.getState();
  if (outcome && outcomeFor(outcome, state.user) === null) dismissShiftCloseOutcome();
});
