import {
  NEEDS_MANAGER_PIN,
  type AuthenticatedUser,
  type ReceiptCopy,
  type ReprintResult,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { IpcGuardError } from '../ipc/registry.js';
import { verifyManagerPin } from './auth-service.js';
import { printSpooler, type ReprintPlan } from './print-spooler.js';
import { reprintApproval, reprintRulesOf, type ReprintApproval } from './reprint-policy.js';
import { readStaffTiming } from '../db/business-settings-read.js';

/**
 * "Reprint receipt" from any screen: decides whether this person may print
 * the paper again now (reprint-policy.ts), checks a manager's PIN or password
 * when they may not, and queues it. The handler's own guard (who may see the
 * order at all) runs before this.
 *
 * Refused for want of approval: IpcGuardError 'forbidden' with details
 * `{ needs: 'manager_pin', document, printNo }` (and `wrongSecret: true` when
 * the one given was not a manager's) — the screen asks and sends it again.
 */
export async function reprintWithApproval(
  db: AppDatabase,
  session: AuthenticatedUser,
  req: { orderId: string; copy?: ReceiptCopy; approverPin?: string },
): Promise<ReprintResult> {
  const copy: ReceiptCopy = req.copy === 'shop' ? 'shop' : 'customer';
  // The owner's reprint rule (Settings → Staff & kitchen timing), read now.
  const rules = reprintRulesOf(readStaffTiming(db));
  const decide = (plan: ReprintPlan): ReprintApproval =>
    reprintApproval({
      role: session.role,
      document: plan.document,
      copy,
      status: plan.status,
      lastActivityAt: plan.lastActivityAt,
      nowMs: Date.now(),
      priorManual: plan.priorManual,
      priorAll: plan.priorAll,
      fbrCopy: plan.fbrCopy,
      orderLabel: plan.orderLabel,
      rules,
    });
  const refuse = (plan: ReprintPlan, why: string, wrongSecret = false): IpcGuardError =>
    new IpcGuardError({
      code: 'forbidden',
      message: why,
      details: {
        needs: NEEDS_MANAGER_PIN,
        document: plan.document,
        printNo: plan.priorAll,
        ...(wrongSecret ? { wrongSecret: true } : {}),
      },
    });

  const plan = printSpooler.planReprint(req.orderId, copy);
  let approvedByUserId: string | null = null;
  const first = decide(plan);
  // Joining a paper that is still waiting to print adds no paper: no approval.
  if (first.approval && !plan.openJob) {
    const secret = req.approverPin?.trim() ?? '';
    if (!secret) throw refuse(plan, first.why);
    try {
      approvedByUserId = (await verifyManagerPin(db, secret)).approverUserId;
    } catch (e) {
      throw refuse(plan, e instanceof Error ? e.message : 'Manager approval failed', true);
    }
  }
  return printSpooler.reprintReceipt(req.orderId, {
    copy,
    requestedByUserId: session.id,
    approvedByUserId,
    // The PIN check was awaited: look again right before queueing (another
    // press may have printed meanwhile).
    check: (now) => {
      if (approvedByUserId) return;
      const again = decide(now);
      if (again.approval) throw refuse(now, again.why);
    },
  });
}
