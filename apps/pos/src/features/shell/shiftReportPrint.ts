import { NEEDS_MANAGER_PIN, type ShiftReportPrintResult } from '@cheeseoclock/shared-types';
import type { ToastVariant } from '../../components/toast/toastQueue';
import { IpcError, ipc } from '../../ipc/client';
import { shiftReportFailedNoteId } from '../printing/failedPrintNote';
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
/** The "No printer" setup: the paper went to its file (Settings → Printers), as every paper there. */
export const SHIFT_REPORT_SAVED_NO_PRINTER = 'Shift report saved (no receipt printer set up).';
export const SHIFT_REPORT_NOT_SAVED = 'The shift report was not saved';

/** The printer's words as a sentence ("…lid is open." stays as it is; "No receipt printer" gets its full stop). */
function sentence(message: string): string {
  const m = message.trim();
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/**
 * What the toast says after a print of the shift report: what came out and
 * whether it says DUPLICATE; or why not, and what to do. On the "No
 * printer" setup it went to that setup's file: said in a note that goes by
 * itself (nothing is wrong: e2e v0.7.35 showed a sticky red "did not print"
 * for every report on such a till), and no printer to check when the file
 * could not be written. A paper that may be in the tray is said so, before
 * anyone prints another.
 */
export function shiftReportToast(r: ShiftReportPrintResult): ShiftReportToast {
  if (r.toFile) {
    return r.printed
      ? { title: SHIFT_REPORT_SAVED_NO_PRINTER, variant: 'info' }
      : { title: SHIFT_REPORT_NOT_SAVED, description: sentence(r.error?.message || 'Unknown error'), variant: 'error' };
  }
  if (r.printed) {
    return { title: r.copy === 'original' ? SHIFT_REPORT_SENT : SHIFT_REPORT_SENT_DUPLICATE, variant: 'success' };
  }
  const why = sentence(r.error?.message || 'Unknown print error');
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

/** Where a print of the shift report says what came out: the till's notes (useToast()). */
export interface ShiftReportNotes {
  toast: (t: ShiftReportToast & { id: string }) => void;
  dismiss: (id: string) => void;
}

/**
 * The id of the note a print of a shift's report leaves (what came out, or
 * why not, or the refusal): the next print of that shift replaces it.
 */
export function shiftReportPrintNoteId(shiftId: string): string {
  return `shift-report-print:${shiftId}`;
}

/**
 * Print it, say what came out, and let the close result know (its amber
 * line goes once a paper is out). Once one comes out (or is saved, on "No
 * printer"), that shift's "did not print" notes go too: the one the till
 * sent (shiftReportFailedNoteId) and an earlier print's (e2e v0.7.35: the
 * red note stayed up after Try again had printed it, and its own Try again
 * printed a DUPLICATE). Never throws: a refusal is a note too.
 */
export async function printShiftReportAndSay(
  shiftId: string,
  again: boolean,
  notes: ShiftReportNotes,
): Promise<ShiftReportPrintResult | null> {
  const id = shiftReportPrintNoteId(shiftId);
  try {
    const r = await printShiftReport(shiftId, { again });
    noteShiftReportPrinted(shiftId, r);
    if (r.printed) notes.dismiss(shiftReportFailedNoteId(shiftId));
    notes.toast({ ...shiftReportToast(r), id });
    return r;
  } catch (e) {
    notes.toast({ ...shiftReportRefusedToast(e), id });
    return null;
  }
}
