import type { ToastAction, ToastVariant } from '../../components/toast/toastQueue';
import type { PrinterFailedPayload } from '../../ipc/client';

/**
 * The note for a receipt or kitchen ticket the printer did not take (the
 * cash drawer has its own words in AppShell). Pure, so it is tested on its
 * own.
 *
 * It names the paper and the order ("Receipt for Order #0041 did not print"):
 * during a rush two orders can fail with the same printer error, and each
 * note keeps its own "Try again" (the action's key is the job) — the only way
 * to still get the ORIGINAL of a paper the till prints by itself; a print
 * button would print a DUPLICATE (the owner's rule).
 *
 * The shift report (v0.7.35) has no job to send again: its note's "Try
 * again" (key 'shift-report:<shiftId>') asks the till to print that shift's
 * report again, and the till prints the ORIGINAL while none came out. It
 * stays until closed, so it still works after the close result is gone —
 * or until that shift's report prints after all: the note has its own id
 * (shiftReportFailedNoteId), and the print that came out closes it.
 */
export interface FailedPrintNote {
  /** The note's own id (the shift report's: shiftReportFailedNoteId); none for the others. */
  id?: string;
  title: string;
  description: string;
  variant: ToastVariant;
  action?: ToastAction;
}

/**
 * The id of the note that a shift's report did not print: one note per
 * shift (a later failure replaces it), closed once a print of that shift's
 * report comes out (printShiftReportAndSay).
 */
export function shiftReportFailedNoteId(shiftId: string): string {
  return `shift-report-failed:${shiftId}`;
}

function kindWords(jobKind: string): string {
  return jobKind === 'kitchen' ? 'kitchen ticket' : jobKind === 'drawer' ? 'cash drawer' : 'receipt';
}

/** The note's title when the shift report did not print. */
export const SHIFT_REPORT_FAILED_TITLE = 'Shift report did not print';
/** After the printer's words: what to do about it. */
export const SHIFT_REPORT_FAILED_NEXT = 'Press Try again, or the owner prints it from Shift history.';
/** The same, on a note with no Try again (the note did not name the shift). */
export const SHIFT_REPORT_FAILED_OWNER = 'The owner can print it from Shift history.';

/** The printer's words as a sentence, so the next one reads on from it. */
function sentence(message: string): string {
  const m = message.trim();
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/**
 * The note for a shift report that did not print ('printer:failed' with
 * jobKind 'shift_report': no job, the shift instead). "Try again" calls
 * `tryShiftReportAgain` with the shift.
 */
function shiftReportNote(payload: PrinterFailedPayload, tryShiftReportAgain?: (shiftId: string) => void): FailedPrintNote {
  const shiftId = payload.shiftId;
  const canTry = !!shiftId && !!tryShiftReportAgain;
  const why = sentence(payload.error?.message || 'Could not print the shift report');
  return {
    ...(shiftId ? { id: shiftReportFailedNoteId(shiftId) } : {}),
    title: SHIFT_REPORT_FAILED_TITLE,
    description: `${why} ${canTry ? SHIFT_REPORT_FAILED_NEXT : SHIFT_REPORT_FAILED_OWNER}`,
    // It stays until closed: the close result may be gone by then.
    variant: 'error',
    ...(canTry && shiftId && tryShiftReportAgain
      ? { action: { label: 'Try again', key: `shift-report:${shiftId}`, onClick: () => tryShiftReportAgain(shiftId) } }
      : {}),
  };
}

export function failedPrintNote(
  payload: PrinterFailedPayload,
  tryAgain: (jobId: string) => void,
  tryShiftReportAgain?: (shiftId: string) => void,
): FailedPrintNote {
  if (payload.jobKind === 'shift_report') return shiftReportNote(payload, tryShiftReportAgain);
  const what = payload.what?.trim() || null;
  const description =
    payload.error?.message ??
    (payload.jobKind === 'kitchen'
      ? 'Could not print kitchen ticket'
      : payload.jobKind === 'drawer'
        ? 'Could not open the cash drawer'
        : 'Could not print receipt');
  if (payload.retrying) {
    return {
      title: `Printer not responding — ${what ?? kindWords(payload.jobKind)} will retry`,
      description,
      // A retry on its way is a warning that clears itself.
      variant: 'warning',
    };
  }
  const jobId = payload.jobId;
  const retryable = !!jobId && (payload.jobKind === 'receipt' || payload.jobKind === 'kitchen');
  return {
    title: what ? `${what} did not print` : 'Print failed',
    description,
    // A final failure stays until closed.
    variant: 'error',
    ...(retryable && jobId ? { action: { label: 'Try again', key: jobId, onClick: () => tryAgain(jobId) } } : {}),
  };
}
