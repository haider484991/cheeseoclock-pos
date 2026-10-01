/**
 * The notes the watch (alerts:getWatch) puts on the banner, and when they
 * beep. Kept pure so watchNotes.test.ts pins the words and the rules;
 * OrderAlerts.tsx only shows and plays what these say.
 *
 * Three notes, at most one of each, in this order:
 *   - ticket: kitchen tickets this till gave up printing (nobody signed in;
 *     signed in, Live Orders shows "Ticket not printed" on the card);
 *   - unconfirmed: website orders the website has not confirmed for 5
 *     minutes or more (on every screen: someone has to check the internet
 *     before the website cancels them);
 *   - waiting: orders waiting too long (nobody signed in; signed in, the
 *     reminder toasts of eventTones.ts planWaitingReminders do it).
 *
 * The watch carries order numbers, statuses, minutes and times only, so no
 * note can name a customer or show a phone number.
 *
 * Signed in, the till beeps once for each newly unconfirmed order, and a
 * note can be hidden until something new joins it (shownNotes). With nobody
 * signed in it beeps at once for anything new, then again every
 * PIN_REMIND_EVERY_MS while a note is up, until someone signs in; a kitchen
 * ticket only on the "Printer problem" switch, and orders waiting too long
 * only while a shift is open on this till. Never two beeps closer than
 * PIN_TONE_MIN_GAP_MS, never while the new-order chime or the alarm rings,
 * and never for a note that is not on screen (a popup over the banner). A
 * sound switched off keeps the note.
 */
import {
  orderNumberList,
  shortOrderNumber,
  type AlertSoundSettings,
  type AlertWatch,
} from '@cheeseoclock/shared-types';
import { ringsFor } from './alertState';
import { PIN_REMIND_EVERY_MS, describeSignedOutReminders, signedOutDue } from './waitingReminders';

/** Two beeps for the watch's notes are never closer than this. */
export const PIN_TONE_MIN_GAP_MS = 60_000;

export interface WatchNote {
  kind: 'ticket' | 'unconfirmed' | 'waiting';
  /** One per thing it is about (`ticket:<orderId>`, `unconfirmed:<orderId>`, `waiting:<orderId>:<minutes>`): a key not heard yet beeps. */
  keys: string[];
  orderIds: string[];
  title: string;
  detail: string;
}

/**
 * Signed in, for the watch's notes: someone is signed in and the login is
 * not held. A held step-in (a cashier was using this till; the PIN must be
 * typed again) counts as signed out: every guarded read is refused then, so
 * only the PIN screen's notes can still say anything.
 */
export function notesSignedIn(user: { stepInHeld?: boolean } | null): boolean {
  return user !== null && user.stepInHeld !== true;
}

export interface WatchNotesContext {
  /** notesSignedIn. */
  signedIn: boolean;
  /** Settings → Sounds "counter orders too" (waitingIncludesCounter). */
  includeCounter: boolean;
  /** Orders still ringing as a new online order: the chime covers them. */
  ringing: ReadonlySet<string>;
  now: number;
  /** "7:45 pm" (Pakistan time). */
  formatTime: (iso: string) => string;
}

export function watchNotes(watch: AlertWatch, ctx: WatchNotesContext): WatchNote[] {
  const notes: WatchNote[] = [];
  if (!ctx.signedIn) {
    const ticket = ticketNote(watch.ticketsNotPrinted);
    if (ticket) notes.push(ticket);
  }
  const unconfirmed = unconfirmedNote(watch.unconfirmed, ctx);
  if (unconfirmed) notes.push(unconfirmed);
  if (!ctx.signedIn) {
    const waiting = waitingNote(watch, ctx);
    if (waiting) notes.push(waiting);
  }
  return notes;
}

function ticketNote(tickets: AlertWatch['ticketsNotPrinted']): WatchNote | null {
  if (tickets.length === 0) return null;
  const base = {
    kind: 'ticket' as const,
    keys: tickets.map((t) => `ticket:${t.orderId}`),
    orderIds: tickets.map((t) => t.orderId),
  };
  if (tickets.length === 1) {
    return {
      ...base,
      title: `Kitchen ticket for Order ${shortOrderNumber(tickets[0]!.orderNumber)} did not print`,
      detail: 'Sign in and reprint it.',
    };
  }
  return {
    ...base,
    title: `${tickets.length} kitchen tickets did not print`,
    detail: `${orderNumberList(tickets.map((t) => t.orderNumber))} — sign in and reprint them.`,
  };
}

function unconfirmedNote(list: AlertWatch['unconfirmed'], ctx: WatchNotesContext): WatchNote | null {
  if (list.length === 0) return null;
  const base = {
    kind: 'unconfirmed' as const,
    keys: list.map((u) => `unconfirmed:${u.orderId}`),
    orderIds: list.map((u) => u.orderId),
  };
  if (list.length > 1) {
    return {
      ...base,
      title: `The website has not confirmed ${list.length} orders`,
      detail: `${orderNumberList(list.map((u) => u.orderNumber))} — the till keeps trying. Check the internet.`,
    };
  }
  const u = list[0]!;
  const cancels = u.cancelsAt === null ? NaN : Date.parse(u.cancelsAt);
  const time = Number.isFinite(cancels) ? ctx.formatTime(u.cancelsAt!) : '';
  let detail = 'The till keeps trying. Check the internet.';
  if (time && cancels > ctx.now) {
    detail = `The till keeps trying. Check the internet — at ${time} the website cancels it and tells the customer.`;
  } else if (time) {
    // Past its 45 minutes: the till cannot know yet whether the website ran
    // its cancel. Once it can ask, a cancelled order rings its own alarm.
    detail = `The till keeps trying. Check the internet — the website may have cancelled it at ${time}.`;
  }
  return { ...base, title: `The website has not confirmed order ${shortOrderNumber(u.orderNumber)}`, detail };
}

function waitingNote(watch: AlertWatch, ctx: WatchNotesContext): WatchNote | null {
  const { due, boardUnused } = signedOutDue(watch.orders, {
    includeCounter: ctx.includeCounter,
    ringing: ctx.ringing,
    timing: watch.timing,
  });
  if (boardUnused || due.length === 0) return null;
  const text = describeSignedOutReminders(due, watch.timing);
  return {
    kind: 'waiting',
    keys: due.map((d) => `waiting:${d.key}`),
    orderIds: [...new Set(due.map((d) => d.orderId))],
    title: text.title,
    detail: text.detail,
  };
}

/**
 * Notes put away with Hide (signed in only), by kind: the keys each one had
 * then. Kept in the alert store and never saved: a restart, a sign-in or a
 * sign-out brings them back.
 */
export type HiddenNotes = Readonly<Partial<Record<WatchNote['kind'], readonly string[]>>>;

export const NO_HIDDEN_NOTES: HiddenNotes = Object.freeze({});

/** Hide: this note, as it is now. */
export function hideNote(hidden: HiddenNotes, note: WatchNote): HiddenNotes {
  return { ...hidden, [note.kind]: [...note.keys] };
}

/**
 * The notes on the banner. Signed in, a hidden note stays away until it has
 * something it did not have when it was hidden (another order joins it); one
 * that only got shorter stays away. Signed out (the PIN screen, or a held
 * step-in) nothing hides: every note shows.
 */
export function shownNotes(notes: readonly WatchNote[], hidden: HiddenNotes, signedIn: boolean): WatchNote[] {
  if (!signedIn) return [...notes];
  return notes.filter((n) => {
    const was = hidden[n.kind];
    return !was || n.keys.some((k) => !was.includes(k));
  });
}

export interface WatchToneContext {
  /** notesSignedIn. */
  signedIn: boolean;
  settings: AlertSoundSettings;
  now: number;
  /** When a note last beeped (0: never). */
  lastToneAt: number;
  /** Keys already heard (signed in, also those that would have been with the sound off). */
  announced: ReadonlySet<string>;
  /** The new-order chime or the alarm is ringing: it has the till's ear. */
  chimeRinging: boolean;
  /**
   * The banner shows the notes now. A popup (a payment, the step-in PIN box,
   * "Close the till?") shrinks it to the pill, which shows no note: a sound
   * never plays without something on screen saying why.
   */
  notesOnScreen: boolean;
  /** A shift is open on this till (the watch's shiftOpen). With none, the shop is closed. */
  shiftOpen: boolean;
}

/**
 * Which sound a note may make with nobody signed in, if any: a kitchen
 * ticket only on "Printer problem" (Settings → Sounds says that switch is
 * its), the others on "Order waiting too long". Orders waiting while no
 * shift is open on this till make none: the shop is closed (website orders
 * are paused then too), and the note still shows.
 */
function signedOutSound(n: WatchNote, ctx: WatchToneContext): 'printer' | 'waiting' | null {
  if (n.kind === 'ticket') return ringsFor('printerProblem', ctx.settings) ? 'printer' : null;
  if (n.kind === 'waiting' && !ctx.shiftOpen) return null;
  return ringsFor('waitingTooLong', ctx.settings) ? 'waiting' : null;
}

/**
 * Whether the notes beep now, and with which sound. `announce`: the keys this
 * round counts as heard (the caller adds them to `announced`, keeping only
 * keys still shown). A key held back by the chime, the 60-second gap or a
 * popup over the banner stays unheard, so it still gets its beep once the
 * note is on screen. With nobody signed in, a note that may not sound
 * (signedOutSound) is not counted as heard either: it neither beeps nor
 * brings the 5-minute repeat.
 */
export function planWatchTone(
  notes: readonly WatchNote[],
  ctx: WatchToneContext,
): { sound: 'printer' | 'waiting' | null; announce: string[] } {
  const quiet = { sound: null, announce: [] as string[] };
  if (notes.length === 0 || ctx.chimeRinging || !ctx.notesOnScreen) return quiet;
  const since = ctx.now - ctx.lastToneAt;

  if (ctx.signedIn) {
    const fresh = notes.flatMap((n) => n.keys).filter((k) => !ctx.announced.has(k));
    // Signed in, only a newly unconfirmed website order beeps, once.
    const freshUnconfirmed = notes.some((n) => n.kind === 'unconfirmed' && n.keys.some((k) => fresh.includes(k)));
    if (!freshUnconfirmed) return { sound: null, announce: fresh };
    if (since < PIN_TONE_MIN_GAP_MS) return quiet;
    return { sound: ringsFor('waitingTooLong', ctx.settings) ? 'waiting' : null, announce: fresh };
  }

  const audible = notes.filter((n) => signedOutSound(n, ctx) !== null);
  if (audible.length === 0) return quiet;
  const fresh = audible.flatMap((n) => n.keys).filter((k) => !ctx.announced.has(k));
  const due = (fresh.length > 0 && since >= PIN_TONE_MIN_GAP_MS) || since >= PIN_REMIND_EVERY_MS;
  if (!due) return quiet;
  const sound = audible.some((n) => n.kind === 'ticket') ? 'printer' : 'waiting';
  return { sound, announce: fresh };
}
