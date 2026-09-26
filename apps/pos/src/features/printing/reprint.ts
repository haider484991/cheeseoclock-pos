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

/** What the toast says after a reprint button. */
export function reprintToast(r: ReprintResult): string {
  if (r.status === 'merged') return 'Already on its way to the printer';
  switch (r.document) {
    case 'void':
      return 'Cancelled-order slip sent to printer';
    case 'kitchen':
    case 'kitchen_cancel':
      // Say what the paper says: the kitchen is told by the cashier too.
      if (r.resent) return 'Kitchen ticket re-sent — the kitchen should check the rail before cooking';
      return r.duplicate ? 'Kitchen ticket sent — marked REPRINT' : 'Kitchen ticket sent to printer';
    case 'bill':
      return r.duplicate ? 'Bill sent — marked DUPLICATE' : 'Bill (not paid) sent to printer';
    case 'refund':
      return r.duplicate ? 'Refund slip sent — marked DUPLICATE' : 'Refund slip sent to printer';
    default:
      return r.duplicate ? 'Receipt sent — marked DUPLICATE' : 'Receipt sent to printer';
  }
}
