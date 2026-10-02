import { create } from 'zustand';
import type { CashCount, ShiftReportAtClose, ShiftReportPrintResult, ShiftSummary } from '@cheeseoclock/shared-types';
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
 *
 * v0.7.35: the figures are the close's own (the 'shifts:close' reply), and
 * the result says what became of the shift report — printing, off, no
 * printer, not made — and, when a 'printer:failed' note for this shift comes
 * in, that it did not print, with Try again (noteShiftReportFailed).
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
   * The shift's takings as the close saved them (v0.7.35: the 'shifts:close'
   * reply, read after the close, so a payment taken while the drawer was
   * being counted is in them — not the figures the close box read when it
   * opened); null on a manager's PIN (the shift's totals never go to a
   * cashier's login), and when the till could not read them back.
   */
  summary: ShiftSummary | null;
  /** The manager (or owner) the shift was closed by. */
  closedByName: string | null;
  /** Unpaid orders carried over to the next shift by this close. */
  carriedUnpaidCount: number;
  /** Closed with a manager's PIN on a cashier's login: shown briefly, and without the expected cash. */
  viaManagerPin: boolean;
  /**
   * What became of the shift report at the close (v0.7.35, the 'shifts:close'
   * reply): printing, off, no printer, or not made. Null when the till did
   * not say.
   */
  reportPrint: ShiftReportAtClose | null;
  /**
   * Why the shift report did not print, in the printer's words: a
   * 'printer:failed' note for this shift (noteShiftReportFailed), or a print
   * from the result that did not come out. Null when nothing failed, or
   * once it printed.
   */
  reportError: string | null;
}

/** How long a close result stays up on a cashier's login (a manager's PIN) before it goes by itself. */
export const PIN_CLOSE_RESULT_MS = 60_000;

export const useShiftCloseOutcome = create<{ outcome: ShiftCloseOutcome | null }>(() => ({ outcome: null }));

let pinCloseTimer: ReturnType<typeof setTimeout> | null = null;
function clearPinCloseTimer(): void {
  if (pinCloseTimer !== null) clearTimeout(pinCloseTimer);
  pinCloseTimer = null;
}

/** The same close (the result is updated in place when its shift report fails or prints). */
function sameClose(a: ShiftCloseOutcome | null, b: ShiftCloseOutcome): boolean {
  return a !== null && a.sessionId === b.sessionId && a.shiftId === b.shiftId;
}

/**
 * Shift report failures that came in before their close result was up (the
 * 'printer:failed' note and the close's reply travel apart): kept for the
 * result, by shift, the last few only.
 */
const earlyReportFailures = new Map<string, string>();
const EARLY_FAILURES_KEPT = 5;

/** Keep the close result on screen (the close box calls this once the shift is closed). */
export function showShiftCloseOutcome(given: ShiftCloseOutcome): void {
  clearPinCloseTimer();
  const early = earlyReportFailures.get(given.shiftId);
  earlyReportFailures.delete(given.shiftId);
  const outcome = early !== undefined && given.reportError === null ? { ...given, reportError: early } : given;
  useShiftCloseOutcome.setState({ outcome });
  if (outcome.viaManagerPin) {
    pinCloseTimer = setTimeout(() => {
      pinCloseTimer = null;
      // Still this close, even after its report line changed: it goes.
      if (sameClose(useShiftCloseOutcome.getState().outcome, outcome)) useShiftCloseOutcome.setState({ outcome: null });
    }, PIN_CLOSE_RESULT_MS);
  }
}

/**
 * The shift report of `shiftId` did not print ('printer:failed', jobKind
 * 'shift_report'): the close result of that shift says so, in amber, with
 * Try again. A failure for any other shift changes nothing on it.
 */
export function noteShiftReportFailed(shiftId: string, message: string): void {
  const { outcome } = useShiftCloseOutcome.getState();
  if (outcome && outcome.shiftId === shiftId) {
    useShiftCloseOutcome.setState({ outcome: { ...outcome, reportError: message } });
    return;
  }
  if (outcome) return;
  // No result up yet: it may be on its way.
  earlyReportFailures.delete(shiftId);
  earlyReportFailures.set(shiftId, message);
  while (earlyReportFailures.size > EARLY_FAILURES_KEPT) {
    const oldest = earlyReportFailures.keys().next().value;
    if (oldest === undefined) break;
    earlyReportFailures.delete(oldest);
  }
}

/**
 * A shift report printed again from the result or from the note (Try
 * again, Print again, Print it): once a paper came out (or, on the "No
 * printer" setup, was saved to its file) the amber line goes; one that did
 * not come out says why.
 */
export function noteShiftReportPrinted(shiftId: string, r: ShiftReportPrintResult): void {
  const { outcome } = useShiftCloseOutcome.getState();
  if (!outcome || outcome.shiftId !== shiftId) return;
  if (r.printed) {
    if (outcome.reportError !== null) useShiftCloseOutcome.setState({ outcome: { ...outcome, reportError: null } });
    return;
  }
  if (r.error) useShiftCloseOutcome.setState({ outcome: { ...outcome, reportError: r.error.message } });
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
