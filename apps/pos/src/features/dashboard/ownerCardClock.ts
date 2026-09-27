/**
 * When the Dashboard's "This week" card hides its figures again (costing
 * spec §2, Phase 7). The till stands at the counter: the figures show only
 * after a tap, and go away again
 *  - after 2 minutes;
 *  - on the idle lock (the login ended on its own) or any change of who is
 *    signed in;
 *  - when a stepping-in login starts, changes or is held
 *    (StepInHold: the PIN box goes over the page).
 * Pure, so each rule is tested alone (ownerCardClock.test.ts).
 */

/** How long the figures stay on screen after the tap. */
export const OWNER_CARD_SHOW_MS = 2 * 60_000;

/** Who is at the till, as far as the card cares. */
export interface CardLogin {
  /** "id:role", or null when nobody is signed in (the PIN pad). */
  who: string | null;
  /** A manager's stepping-in login: when the till holds it (null for a normal login). */
  stepInEndsAt: string | null;
  /** The stepping-in login is held until the PIN is typed again. */
  stepInHeld: boolean;
}

/** The tap that showed the figures: when, and who was signed in then. */
export interface CardShown {
  atMs: number;
  who: string;
  stepInEndsAt: string | null;
}

export type CardHideReason = 'timeout' | 'signedOut' | 'otherLogin' | 'stepIn';

/** Why the figures must hide now, or null while they may stay. */
export function cardHideReason(shown: CardShown, login: CardLogin, nowMs: number): CardHideReason | null {
  if (login.who === null) return 'signedOut';
  if (login.who !== shown.who) return 'otherLogin';
  if (login.stepInHeld || login.stepInEndsAt !== shown.stepInEndsAt) return 'stepIn';
  if (nowMs - shown.atMs >= OWNER_CARD_SHOW_MS) return 'timeout';
  return null;
}

/** How long until the 2 minutes are up (0: now). */
export function cardHidesInMs(shown: CardShown, nowMs: number): number {
  return Math.max(0, shown.atMs + OWNER_CARD_SHOW_MS - nowMs);
}

/** May the figures be shown to this login at all? Not while nobody is signed in, nor while a stepping-in login is held. */
export function cardMayShow(login: CardLogin): boolean {
  return login.who !== null && !login.stepInHeld;
}
