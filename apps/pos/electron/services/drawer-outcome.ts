import { DRAWER_TOO_LATE_CODE, type DrawerOutcome, type PrintResult } from '@cheeseoclock/shared-types';

/**
 * What a drawer pulse did, in the words the drawer log keeps (0042) and the
 * counter is told. Pure: no printer, no database — the spooler and
 * drawer-service use it, and it is tested on its own.
 */

/** kickDrawerNow's answer when the printer did not get ready in time: nothing was sent. */
export const PRINTER_STARTING_CODE = 'printer_starting';

/** A queued pulse not sent because a later one (another sale, Open drawer) already opened the drawer. */
export const ALREADY_OPEN_NOTE = 'Opened by a later pulse';
/** A queued pulse dropped because it could no longer go out within a minute of the cash. */
export const TOO_LATE_NOTE = 'The printer did not answer within a minute — was the key used?';
/** A queued pulse for an order that was deleted (as a test) before it went out. */
export const ORDER_GONE_NOTE = 'Order deleted before the drawer opened';

/**
 * Why the drawer did not open, in words for the counter. Never says "try
 * again" when the pulse may already have gone out.
 */
export function drawerFailureText(err?: PrintResult['error']): string {
  if (!err) return 'The printer did not take the drawer pulse.';
  if (err.maybeSent) {
    return 'The printer had a problem mid-way. Check the drawer: if it is shut, use the key. It may still open by itself when the printer is fixed.';
  }
  switch (err.code) {
    case DRAWER_TOO_LATE_CODE:
      return 'The printer was busy or slow for too long, so the till did not open the drawer late.';
    case PRINTER_STARTING_CODE:
      return 'The till is still getting the printer ready, so nothing was sent. Try again in a few seconds.';
    case 'printer_offline':
      return err.message
        ? `The printer is not ready. ${err.message}`
        : 'The printer is off, offline, out of paper or its lid is open.';
    case 'printer_not_sent':
      return `Windows did not take the drawer pulse. Check the printer is on and plugged in. (${err.message})`;
    case 'network_error':
    case 'timeout':
      return "The printer didn't answer. Check it is switched on and connected.";
    case 'no_config':
    case 'bad_printer_name':
      return 'No receipt printer is set up (Settings → Printers).';
    default:
      return err.message || 'The printer did not take the drawer pulse.';
  }
}

/**
 * The drawer log's result for one pulse:
 *  - the printer took it, but no receipt printer is set up → no_printer;
 *  - the printer took it → opened;
 *  - the printer failed after the pulse may have gone out → unsure;
 *  - anything else → not_opened, with why in plain words.
 */
export function drawerOutcome(
  result: Pick<PrintResult, 'ok' | 'error'>,
  noPrinter: boolean,
): { outcome: DrawerOutcome; note: string | null } {
  if (result.ok) return noPrinter ? { outcome: 'no_printer', note: 'No receipt printer is set up' } : { outcome: 'opened', note: null };
  if (result.error?.maybeSent === true) return { outcome: 'unsure', note: drawerFailureText(result.error) };
  return { outcome: 'not_opened', note: drawerFailureText(result.error) };
}
