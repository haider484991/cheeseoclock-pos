import { hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser, DrawerOpenResult, PrintResult } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { recordDrawerOpen } from '../db/repositories/drawer-open-repo.js';
import { getCurrentShift } from '../db/repositories/shift-repo.js';
import { verifyManagerPin } from './auth-service.js';
import { drawerFailureText, printSpooler } from './print-spooler.js';
import { DEFAULT_RECEIPT_CONFIG, getReceiptPrinterConfig, isNoPrinter } from './printer-config.js';

/**
 * Opening the cash drawer by hand — who may, and what is kept on record.
 *
 *  - Open drawer (no sale): a manager or the owner opens it directly; a
 *    cashier needs a manager's PIN or password, like cash in / out.
 *  - Open drawer to count: part of closing the shift, so only someone who
 *    can close it, and only while a shift is open.
 *  - Test drawer: Settings → Printers (printer.manage is checked by the
 *    handler).
 *
 * Every open is saved (row + audit, drawer-open-repo) BEFORE the pulse goes
 * out, so it is on record even when the printer then fails. The approval rules
 * live here rather than in the IPC handler so they can be tested.
 */

export class DrawerOpenRefused extends Error {
  constructor(
    readonly code: 'forbidden' | 'precondition_failed' | 'validation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DrawerOpenRefused';
  }
}

export interface OpenDrawerRequest {
  kind: 'no_sale' | 'count';
  reason?: string | null;
  /** A manager's PIN or password, when a cashier asks. Whatever the sign-in rules accept. */
  approverPin?: string;
}

export async function openDrawerNoSale(
  db: AppDatabase,
  session: AuthenticatedUser,
  deviceId: string,
  req: OpenDrawerRequest,
): Promise<DrawerOpenResult> {
  if (req.kind !== 'no_sale' && req.kind !== 'count') {
    throw new DrawerOpenRefused('validation_failed', 'Unknown way to open the drawer');
  }
  if (req.reason !== undefined && req.reason !== null && typeof req.reason !== 'string') {
    throw new DrawerOpenRefused('validation_failed', 'The reason must be text');
  }
  let approvedByUserId: string | null = null;
  if (req.kind === 'count') {
    // Counting the drawer is closing the shift: the same people, only then.
    if (!hasCapability(session.role, 'shift.close')) {
      throw new DrawerOpenRefused('forbidden', 'Only a manager or the owner can open the drawer to count it');
    }
    if (!getCurrentShift(db, deviceId)) {
      throw new DrawerOpenRefused('precondition_failed', 'No shift is open on this till — nothing to count');
    }
  } else if (!hasCapability(session.role, 'cash.movement')) {
    // No digit or length rules here: the sign-in rules decide what a valid
    // PIN or password is (verifyManagerPin).
    const pin = typeof req.approverPin === 'string' ? req.approverPin : '';
    if (pin.trim() === '') {
      throw new DrawerOpenRefused(
        'precondition_failed',
        "A manager's PIN or password is needed to open the drawer without a sale",
      );
    }
    try {
      approvedByUserId = (await verifyManagerPin(db, pin)).approverUserId;
    } catch (e) {
      throw new DrawerOpenRefused('forbidden', e instanceof Error ? e.message : 'Manager approval failed');
    }
  }

  // On record first (audit before action). Then the pulse, with the person
  // watching "Opening…" (a printer still starting up gets a moment first).
  const open = recordDrawerOpen(
    db,
    { kind: req.kind, reason: req.reason ?? null, approvedByUserId },
    { userId: session.id, deviceId },
  );
  const result = await printSpooler.kickDrawerNow({ watched: true });
  return {
    id: open.id,
    opened: result.ok,
    unsure: result.error?.maybeSent === true,
    noPrinter: isNoPrinter(getReceiptPrinterConfig(db) ?? DEFAULT_RECEIPT_CONFIG),
    message: result.ok ? null : drawerFailureText(result.error),
  };
}

/** Test drawer (Settings → Printers): on record as a test, then one pulse. */
export async function testDrawer(
  db: AppDatabase,
  session: AuthenticatedUser,
  deviceId: string,
): Promise<PrintResult> {
  recordDrawerOpen(db, { kind: 'test' }, { userId: session.id, deviceId });
  const result = await printSpooler.kickDrawerNow({ watched: true });
  if (result.ok || !result.error) return result;
  // The settings page shows the message as it is: make it the plain one.
  return { ...result, error: { ...result.error, message: drawerFailureText(result.error) } };
}
