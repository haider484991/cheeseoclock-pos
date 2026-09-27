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
 */
export interface FailedPrintNote {
  title: string;
  description: string;
  variant: ToastVariant;
  action?: ToastAction;
}

function kindWords(jobKind: string): string {
  return jobKind === 'kitchen' ? 'kitchen ticket' : jobKind === 'drawer' ? 'cash drawer' : 'receipt';
}

export function failedPrintNote(payload: PrinterFailedPayload, tryAgain: (jobId: string) => void): FailedPrintNote {
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
