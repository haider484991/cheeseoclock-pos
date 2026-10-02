import { NEEDS_MANAGER_PIN, type ShiftReportPrintResult } from '@cheeseoclock/shared-types';
import type { ToastVariant } from '../../components/toast/toastQueue';
import { IpcError, ipc } from '../../ipc/client';
import { askManagerSecret } from '../printing/managerApproval';
import { NO_APPROVAL_MESSAGE } from '../printing/reprint';
import { noteShiftReportPrinted } from './shiftCloseOutcome';

/**
 * The shift report printed again (v0.7.35): the close result's Print again,
 * Try again and Print it, and Try again on the note that it did not print.
 * The till decides what prints ('shifts:printReport': the figures saved at
 * the close, this till's section switches now) and whether it is the
 * ORIGINAL or a DUPLICATE. On a cashier's login (a manager's PIN closed the
 * shift there) it refuses with details.needs 'manager_pin': then this asks
 * for a manager's PIN or password in the app (never the browser's prompt or
 * confirm) and tries again, like a receipt's reprint (reprint.ts).
 */

/** Tries at a manager's secret before giving up (the till also locks after repeated wrong ones). */
const MAX_TRIES = 3;

function needsManager(e: unknown): e is IpcError {
  return e instanceof IpcError && e.code === 'forbidden' && e.details?.['needs'] === NEEDS_MANAGER_PIN;
}

/**
 * What the manager's PIN box promises about the paper. Try again prints the
 * original when the first paper never came out; anything else says
 * DUPLICATE. (Not the receipt's words: this paper names who is signed in.)
 */
export function shiftReportApprovalNote(again: boolean): string {
  return again
    ? 'The shift report prints again from the figures saved at the close. It says DUPLICATE.'
    : 'The shift report prints from the figures saved at the close. If the first paper never came out, this is the original; if it did, this one says DUPLICATE.';
}

/**
 * Print a closed shift's report again. `again: false` is Try again (the
 * ORIGINAL when this till's first paper did not come out); `again: true` is
 * Print again (a DUPLICATE). Throws the till's refusal as it is, or
 * NO_APPROVAL_MESSAGE when the manager's PIN box is cancelled.
 */
export async function printShiftReport(shiftId: string, opts: { again: boolean }): Promise<ShiftReportPrintResult> {
  let approverPin: string | undefined;
  let why = '';
  for (let tries = 0; ; tries += 1) {
    try {
      return await ipc.shifts.printReport({ shiftId, again: opts.again, ...(approverPin ? { approverPin } : {}) });
    } catch (e) {
      if (!needsManager(e) || tries >= MAX_TRIES) throw e;
      const wrong = e.details?.['wrongSecret'] === true;
      if (!wrong) why = e.message;
      const secret = await askManagerSecret(why || e.message, wrong ? e.message : null, null, shiftReportApprovalNote(opts.again));
      if (!secret) throw new Error(NO_APPROVAL_MESSAGE);
      approverPin = secret;
    }
  }
}

/** A toast, as the till's useToast() takes it. */
export interface ShiftReportToast {
  title: string;
  description?: string;
  variant: ToastVariant;
  duration?: number;
}

export const SHIFT_REPORT_SENT = 'Shift report sent to the printer.';
export const SHIFT_REPORT_SENT_DUPLICATE = 'Shift report sent to the printer - it says DUPLICATE.';
export const SHIFT_REPORT_NOT_PRINTED = 'The shift report did not print';
export const SHIFT_REPORT_MAYBE_PRINTED = 'The shift report may have printed';

/** The printer's words as a sentence ("…lid is open." stays as it is; "No receipt printer" gets its full stop). */
function sentence(message: string): string {
  const m = message.trim();
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/**
 * What the toast says after a print of the shift report: what came out and
 * whether it says DUPLICATE; or why not, and what to do. No printer set up
 * is not a printer to check; a paper that may be in the tray is said so,
 * before anyone prints another.
 */
export function shiftReportToast(r: ShiftReportPrintResult): ShiftReportToast {
  if (r.printed) {
    return { title: r.copy === 'original' ? SHIFT_REPORT_SENT : SHIFT_REPORT_SENT_DUPLICATE, variant: 'success' };
  }
  const why = sentence(r.error?.message || 'Unknown print error');
  if (r.error?.code === 'no_printer') return { title: SHIFT_REPORT_NOT_PRINTED, description: why, variant: 'error' };
  if (r.error?.maybeSent) {
    return {
      title: SHIFT_REPORT_MAYBE_PRINTED,
      description: `${why} Look in the printer's tray before you print it again.`,
      variant: 'warning',
      duration: 15_000,
    };
  }
  return { title: SHIFT_REPORT_NOT_PRINTED, description: `${why} Check the receipt printer, then try again.`, variant: 'error' };
}

/** The toast when the till refused, or the manager's PIN box was cancelled: nothing printed. */
export function shiftReportRefusedToast(e: unknown): ShiftReportToast {
  return { title: 'Shift report not printed', description: e instanceof Error ? e.message : String(e), variant: 'error' };
}

/**
 * Print it, say what came out, and let the close result know (its amber
 * line goes once a paper is out). Never throws: a refusal is a toast too.
 */
export async function printShiftReportAndSay(
  shiftId: string,
  again: boolean,
  say: (t: ShiftReportToast) => void,
): Promise<ShiftReportPrintResult | null> {
  try {
    const r = await printShiftReport(shiftId, { again });
    noteShiftReportPrinted(shiftId, r);
    say(shiftReportToast(r));
    return r;
  } catch (e) {
    say(shiftReportRefusedToast(e));
    return null;
  }
}
