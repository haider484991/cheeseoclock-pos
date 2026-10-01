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
 * Signed in, the till beeps once for each newly unconfirmed order. With
 * nobody signed in it beeps at once for anything new, then again every
 * PIN_REMIND_EVERY_MS while a note is up, until someone signs in; never two
 * beeps closer than PIN_TONE_MIN_GAP_MS, and never while the new-order chime
 * or the alarm rings. A sound switched off keeps the note.
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

export interface WatchToneContext {
  /** notesSignedIn. */
  signedIn: boolean;
  settings: AlertSoundSettings;
  now: number;
  /** When a note last beeped (0: never). */
  lastToneAt: number;
  /** Keys already heard (or that would have been, with the sound off). */
  announced: ReadonlySet<string>;
  /** The new-order chime or the alarm is ringing: it has the till's ear. */
  chimeRinging: boolean;
}

/**
 * Whether the notes beep now, and with which sound. `announce`: the keys this
 * round counts as heard (the caller adds them to `announced`, keeping only
 * keys still shown). A key held back by the chime or the 60-second gap stays
 * unheard, so it still gets its beep.
 */
export function planWatchTone(
  notes: readonly WatchNote[],
  ctx: WatchToneContext,
): { sound: 'printer' | 'waiting' | null; announce: string[] } {
  const quiet = { sound: null, announce: [] as string[] };
  if (notes.length === 0 || ctx.chimeRinging) return quiet;
  const fresh = notes.flatMap((n) => n.keys).filter((k) => !ctx.announced.has(k));
  const since = ctx.now - ctx.lastToneAt;

  if (ctx.signedIn) {
    // Signed in, only a newly unconfirmed website order beeps, once.
    const freshUnconfirmed = notes.some((n) => n.kind === 'unconfirmed' && n.keys.some((k) => fresh.includes(k)));
    if (!freshUnconfirmed) return { sound: null, announce: fresh };
    if (since < PIN_TONE_MIN_GAP_MS) return quiet;
    return { sound: ringsFor('waitingTooLong', ctx.settings) ? 'waiting' : null, announce: fresh };
  }

  const due = (fresh.length > 0 && since >= PIN_TONE_MIN_GAP_MS) || since >= PIN_REMIND_EVERY_MS;
  if (!due) return quiet;
  let sound: 'printer' | 'waiting' | null = null;
  if (notes.some((n) => n.kind === 'ticket') && ringsFor('printerProblem', ctx.settings)) sound = 'printer';
  else if (ringsFor('waitingTooLong', ctx.settings)) sound = 'waiting';
  return { sound, announce: fresh };
}
