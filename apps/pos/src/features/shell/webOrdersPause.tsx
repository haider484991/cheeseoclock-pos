import { PauseCircle } from 'lucide-react';
import type { WebOrdersPauseView } from '@cheeseoclock/shared-types';
import { useWebOrdersPause } from '../notifications/useAlertWatch';

/*
 * "Website orders are paused": closing the last shift on this till pauses
 * website orders (the owner's switch stays on), and opening a shift starts
 * them again (web-orders-shift-pause.ts). The words name this till, so they
 * stay true if a second till ever holds the website link.
 */

/** The PIN screen's notice: one line, "Website orders are paused — sign in and open a shift." */
export const WEB_PAUSED_TITLE = 'Website orders are paused';
export const WEB_PAUSED_LOGIN_TEXT = 'sign in and open a shift.';
export const WEB_PAUSED_LOGIN_LINE = `${WEB_PAUSED_TITLE} — ${WEB_PAUSED_LOGIN_TEXT}`;
/** The second line of "No shift is open" on Checkout and Live Orders. */
export const WEB_PAUSED_BANNER_TEXT = 'Website orders are paused too. Opening the shift starts them again.';
/** The top bar's pill, next to "Open shift". */
export const WEB_PAUSED_PILL = 'Website paused';
export const WEB_PAUSED_PILL_TITLE =
  'Website orders are paused: no shift is open on this till. Open a shift to take them again.';
/** The Open shift box. */
export const OPEN_RESUMES_WEBSITE_TEXT = 'Opening the shift starts website orders again.';
/** The close box, before "Close shift": a warning, not a gate. */
export const CLOSE_PAUSES_WEBSITE_TEXT = 'Closing this shift pauses website orders until a shift is opened again.';
export const CLOSE_PAUSES_WEBSITE_NOTE = 'Orders already placed still come in and print.';

/**
 * Say so only on the till's yes: the owner's switch is on, this till paused
 * website orders, and the website link is set. A till with no link (or with
 * the switch off) never says it.
 */
export function showWebOrdersPaused(v: WebOrdersPauseView | undefined | null): boolean {
  return !!v && v.paused && v.websiteLinkSet;
}

/**
 * The PIN screen's notice (LoginPage, in the card under the logo): the amber
 * of the "why the till is back here" note, nothing until the till has said
 * yes. One line, so the keypad's Enter row stays on a 700 px window: 360 px
 * of words and icon in Segoe UI 14 px (383 in Inter) against 372 px inside
 * the card (388 on a short window, where the card's padding is 1.5rem).
 * On a short window (LoginPage SHORT_SCREEN_MAX_HEIGHT) its spacing is
 * tighter too: 40 px with its gap, from 70.
 */
export function WebOrdersPausedNotice() {
  const pause = useWebOrdersPause();
  if (!showWebOrdersPaused(pause)) return null;
  return (
    <div
      role="status"
      className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-center text-sm text-amber-900 ring-1 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800 [@media(max-height:820px)]:mb-2 [@media(max-height:820px)]:py-1.5"
    >
      <PauseCircle className="mr-1.5 inline h-4 w-4 shrink-0 align-[-0.1875rem]" aria-hidden="true" />
      <span className="font-semibold">{WEB_PAUSED_TITLE}</span> — {WEB_PAUSED_LOGIN_TEXT}
    </div>
  );
}
