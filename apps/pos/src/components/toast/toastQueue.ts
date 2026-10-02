/**
 * The rules for the till's pop-up notes, kept pure so they can be tested.
 *
 * At a busy counter a note must say its piece and get out of the way: a
 * "done" note goes in two seconds, a problem stays until someone closes it,
 * and never more than three are on screen at once (owner, 2026-09-26: the
 * old notes piled up over the Pay button and could not be closed).
 */

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  /**
   * The note's id: the caller's own (a note with the same id replaces it, and
   * closing that id closes it), or a fresh one. Never two notes with one id.
   */
  id: string;
  /**
   * This showing of the note (the screen's key; the id when not set): a note
   * replaced under the same id comes up afresh, with its own timer.
   */
  instance?: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  /** ms before auto-dismiss; `Infinity` keeps it until closed. */
  duration: number;
  /** One button on the note ("Try again" on a failed print); pressing it closes the note. */
  action?: ToastAction;
  /**
   * Stays when the person signed in changes (toastsAfterSignOut): a note about
   * the shop (a website order), not about what the last login did.
   */
  keepOnLogout?: boolean;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
  /**
   * What the button acts on ("Try again": the print job's id). Two notes with
   * the same words but a different key are different notes — neither may
   * replace the other and take its button with it.
   */
  key?: string;
}

/** Most notes on screen at once. */
export const MAX_VISIBLE_TOASTS = 3;

const DEFAULT_MS: Record<ToastVariant, number> = {
  success: 2_000,
  info: 5_000,
  warning: 6_000,
  error: Infinity,
};

/** A success note never lingers longer than this, whatever the caller asked. */
const SUCCESS_MAX_MS = 3_000;

/**
 * How long a note stays up. Errors stay until closed — someone has to act on
 * them. Successes are quick. Info and warnings keep a caller's own duration
 * (a low-stock warning or a website order asks for longer on purpose).
 */
export function toastDuration(variant: ToastVariant, requested?: number): number {
  if (variant === 'error') return Infinity;
  if (variant === 'success') return Math.min(requested ?? DEFAULT_MS.success, SUCCESS_MAX_MS);
  if (requested === undefined || !(requested > 0)) return DEFAULT_MS[variant];
  return requested;
}

/** No button on either, or buttons acting on the same thing. */
function sameAction(a: ToastAction | undefined, b: ToastAction | undefined): boolean {
  if (!a && !b) return true;
  return !!a && !!b && a.key !== undefined && a.key === b.key && a.label === b.label;
}

function sameMessage(a: ToastItem, b: ToastItem): boolean {
  return (
    a.variant === b.variant &&
    a.title === b.title &&
    (a.description ?? '') === (b.description ?? '') &&
    sameAction(a.action, b.action)
  );
}

/**
 * Add a note to the list. A note with the same id is replaced (a shift
 * report that printed in the end replaces "did not print"); so is the same
 * message again (its timer starts over) instead of stacking — unless the two
 * carry buttons for different things (two failed prints with the same
 * printer error: each keeps its own "Try again"). Over the limit, the oldest
 * note that closes by itself goes first; notes that stay until closed are
 * kept (the screen shows the newest few and says how many more are waiting).
 */
export function addToast(list: ReadonlyArray<ToastItem>, item: ToastItem, max = MAX_VISIBLE_TOASTS): ToastItem[] {
  const next = list.filter((t) => t.id !== item.id && !sameMessage(t, item));
  next.push(item);
  while (next.length > max) {
    const i = next.findIndex((t) => t.duration !== Infinity);
    if (i === -1) break;
    next.splice(i, 1);
  }
  return next;
}

/** What is on screen (newest last) and how many more are waiting behind it. */
export function visibleToasts(list: ReadonlyArray<ToastItem>, max = MAX_VISIBLE_TOASTS): { shown: ToastItem[]; waiting: number } {
  const shown = list.slice(Math.max(0, list.length - max));
  return { shown, waiting: list.length - shown.length };
}

/** The note with this id closed (nothing when there is none). */
export function removeToast(list: ReadonlyArray<ToastItem>, id: string): ToastItem[] {
  return list.filter((t) => t.id !== id);
}

/**
 * The person signed in changed: a log-out, the idle lock, a hand-back to
 * the cashier, or someone else signing in. The same login read again (the
 * till's 30-second check) is not a change.
 */
export function signedInPersonChanged(before: { id: string } | null, after: { id: string } | null): boolean {
  return before !== null && (after === null || after.id !== before.id);
}

/**
 * The notes left once the person signed in changed (e2e v0.7.35: the
 * owner's "The shift report did not print" stayed up for the cashier who
 * signed in next, over the header's Open shift): only the shop's own,
 * kept on purpose (keepOnLogout, a website order's note).
 */
export function toastsAfterSignOut(list: ReadonlyArray<ToastItem>): ToastItem[] {
  return list.filter((t) => t.keepOnLogout === true);
}
