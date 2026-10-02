import { NEEDS_MANAGER_PIN, type ReprintResult } from '@cheeseoclock/shared-types';
import { IpcError, ipc } from '../../ipc/client';
import { askManagerSecret } from './managerApproval';

/**
 * "Reprint receipt" from any screen (Live Orders, the order drawer, Order
 * History, the payment screen). The till decides what prints and whether it
 * says DUPLICATE; when it needs a manager's PIN or password for another copy
 * it refuses with details.needs 'manager_pin' — then this asks for one and
 * tries again (a wrong one is asked again, with why).
 */

/** Thrown when the manager prompt is cancelled: nothing was printed. */
export const NO_APPROVAL_MESSAGE = 'Not printed - no manager approval';

/** Tries at a manager's secret before giving up (the till also locks after repeated wrong ones). */
const MAX_TRIES = 3;

function needsManager(e: unknown): e is IpcError {
  return e instanceof IpcError && e.code === 'forbidden' && e.details?.['needs'] === NEEDS_MANAGER_PIN;
}

export async function reprintReceipt(orderId: string, opts: { copy?: 'customer' | 'shop' } = {}): Promise<ReprintResult> {
  let approverPin: string | undefined;
  let why = '';
  for (let tries = 0; ; tries += 1) {
    try {
      return await ipc.printer.reprint(orderId, { ...opts, ...(approverPin ? { approverPin } : {}) });
    } catch (e) {
      if (!needsManager(e) || tries >= MAX_TRIES) throw e;
      const wrong = e.details?.['wrongSecret'] === true;
      if (!wrong) why = e.message;
      const printNo = e.details?.['printNo'];
      const secret = await askManagerSecret(
        why || e.message,
        wrong ? e.message : null,
        typeof printNo === 'number' && Number.isFinite(printNo) ? printNo : null,
      );
      if (!secret) throw new Error(NO_APPROVAL_MESSAGE);
      approverPin = secret;
    }
  }
}

export function reprintKitchen(orderId: string): Promise<ReprintResult> {
  return ipc.printer.reprintKitchen(orderId);
}

/** The paper, as the toast names it. */
const PAPER_WORD: Record<'bill' | 'receipt' | 'void' | 'refund', string> = {
  bill: 'Bill',
  receipt: 'Receipt',
  void: 'Cancelled-order slip',
  refund: 'Refund slip',
};

/**
 * The toast after the order panel sent the till's own failed paper again
 * (next.failedJobId → printer:retryJob): it prints as the original.
 */
export function failedRetryToast(document: 'bill' | 'receipt' | 'void', requeued: boolean): string {
  if (!requeued) return 'Nothing to send again — it already printed.';
  return `${PAPER_WORD[document]} sent to the printer again — it is the one the till owed, so it prints as the original.`;
}

/**
 * What the toast says after a print button: what printed, and that it says
 * DUPLICATE. The owner's rule (27 Sep 2026): only the paper the till prints
 * by itself is the original; a paper printed with a print button is always
 * marked DUPLICATE "Reprint #N" — the first one of its kind too.
 */
export function reprintToast(r: ReprintResult): string {
  if (r.status === 'merged') return 'Already printing — no second copy was made.';
  if (r.document === 'kitchen' || r.document === 'kitchen_cancel' || r.document === 'kitchen_change') {
    // Say what the paper says: the kitchen is told by the cashier too.
    if (r.resent) return 'Kitchen ticket re-sent — the kitchen should check the rail before cooking';
    return r.duplicate ? 'Kitchen ticket sent — marked REPRINT' : 'Kitchen ticket sent to printer';
  }
  const word = PAPER_WORD[r.document];
  if (!r.duplicate) return `${word} sent to the printer.`;
  const n = r.reprintNo && r.reprintNo > 0 ? ` (Reprint #${r.reprintNo})` : '';
  if (r.printNo === 0) return `${word} printed — marked DUPLICATE${n}. A paper printed by hand always says DUPLICATE.`;
  return `${word} printed again — marked DUPLICATE${n}`;
}
