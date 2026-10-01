import type { CloseTillAsk } from '@cheeseoclock/shared-types';

/**
 * Closing the till window by mistake (v0.7.33). X or Alt+F4 used to close
 * the window and quit the till, and the website went on taking orders until
 * the till's last heartbeat went stale 3 minutes later — orders nobody would
 * cook. Now, while the website takes orders through this till (the link
 * ready, the owner's switch on, no shift pause), the close is held and the
 * screen asks "Close the till?" first.
 *
 * It never asks, and the window closes as before, when:
 *  - the app is quitting (app.quit: an update's "Restart now", install on
 *    quit) or Windows is shutting down, restarting or signing out — a held
 *    window there would read "This app is preventing shutdown". A Windows
 *    end-session that leaves the till running (an installer, the Restart
 *    Manager) lets it close without asking for SESSION_END_REARM_MS only;
 *    after that it asks again;
 *  - the screen cannot ask (crashed, or Windows says it is not responding);
 *  - the screen does not say the question is up within ASK_ACK_TIMEOUT_MS:
 *    a till that will not close sends people to Task Manager or the power
 *    button, and a dead screen cannot show orders anyway.
 * Once the screen says the question is up, it waits for the person with no
 * time limit. "Close the till" first tells the website "not accepting"
 * (GOODBYE_TIMEOUT_MS at most), so customers stop ordering at once.
 *
 * Pure: Electron, the website bridge and the clock come in through `deps`
 * (see till-close-hub.ts for the real ones), so the rules are unit-tested.
 * Nothing here throws: a problem here closes the window, as before.
 */

/** The screen has this long to say "Close the till?" is up; then the till closes anyway. */
export const ASK_ACK_TIMEOUT_MS = 5_000;
/** "Close the till" waits this long at most for the website to hear "not accepting". */
export const GOODBYE_TIMEOUT_MS = 2_000;
/**
 * A Windows end-session lets the window close without asking; if the till is
 * still running this long after the last one, Windows did not end it (an
 * installer, the Restart Manager), and the next close asks again.
 */
export const SESSION_END_REARM_MS = 30_000;

/** Why the window may close without asking. */
export type CloseAllowReason = 'quit' | 'session-end' | 'answered' | 'no-answer';

export interface TillCloseDeps {
  /** What closing would stop; null = nothing (the website takes no orders through this till). */
  impact(): { openWebOrders: number } | null;
  /** The screen is there and answering (not crashed, not "Not responding"). */
  screenCanAsk(): boolean;
  /** Bring the till to the front and put the question on screen; false = it could not be sent. */
  ask(req: CloseTillAsk): boolean;
  /** Close the window for real (it asks again, and is let through). */
  closeWindow(): void;
  /** Tell the website "not accepting" now. */
  sayClosing(): Promise<void>;
  newId(): string;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

interface Pending {
  ask: CloseTillAsk;
  /** The screen said the question is up: no time limit any more. */
  acked: boolean;
  timer: unknown;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class TillCloseGuard {
  private allowed: CloseAllowReason | null = null;
  private pending: Pending | null = null;
  /** Asks again SESSION_END_REARM_MS after the last session end (sessionEndOver). */
  private sessionEndTimer: unknown = null;

  constructor(private readonly deps: TillCloseDeps) {}

  /**
   * The window's 'close': 'keep-open' = the caller cancels it (the question
   * is on its way, or already up); 'close' = let it close. Never throws.
   */
  onCloseRequested(): 'close' | 'keep-open' {
    try {
      if (this.allowed) return this.letClose();
      let impact: { openWebOrders: number } | null;
      try {
        impact = this.deps.impact();
      } catch (e) {
        this.deps.warn('Till window: could not tell whether website orders are on; closing', { error: errorText(e) });
        return this.letClose();
      }
      if (!impact) return this.letClose();
      if (!this.deps.screenCanAsk()) {
        this.deps.warn('Till window: the screen cannot ask (crashed or not responding); closing');
        return this.letClose();
      }
      // A second X while the question is up: the same question to the front
      // again, and the clock it started with keeps running.
      if (this.pending) return this.deps.ask(this.pending.ask) ? 'keep-open' : this.letClose();
      const ask: CloseTillAsk = { requestId: this.deps.newId(), openWebOrders: impact.openWebOrders };
      this.deps.info('Till window: asked before closing (website orders are on)', { openWebOrders: ask.openWebOrders });
      if (!this.deps.ask(ask)) return this.letClose();
      const pending: Pending = { ask, acked: false, timer: null };
      pending.timer = this.deps.schedule(() => this.noAnswer(pending), ASK_ACK_TIMEOUT_MS);
      this.pending = pending;
      return 'keep-open';
    } catch (e) {
      this.deps.warn('Till window: the close question failed; closing', { error: errorText(e) });
      return this.letClose();
    }
  }

  /** The screen has the question up (system:closeShown). `pending` false = out of date. */
  shown(requestId: string): { pending: boolean } {
    const p = this.pending;
    if (!p || p.ask.requestId !== requestId) return { pending: false };
    if (!p.acked) {
      p.acked = true;
      this.deps.cancel(p.timer);
    }
    return { pending: true };
  }

  /**
   * The person's answer (system:closeAnswer). Closing answers at once and
   * closes a moment later, so the reply reaches the screen before it goes.
   */
  answer(requestId: string, close: boolean): { closing: boolean } {
    const p = this.pending;
    if (!p || p.ask.requestId !== requestId) return { closing: false };
    this.drop();
    if (!close) {
      this.deps.info('Till window: kept open');
      return { closing: false };
    }
    this.allowed = 'answered';
    this.deps.info('Till window: closed by hand while website orders were on', { openWebOrders: p.ask.openWebOrders });
    void this.goodbyeThenClose();
    return { closing: true };
  }

  /**
   * Close without asking from now on: the app is quitting, or Windows is
   * ending the session. A question already up is dropped. A session end
   * never replaces a stronger reason (sessionEndCancelled would undo it),
   * and lasts SESSION_END_REARM_MS from the last one (sessionEndOver).
   */
  allowClose(why: CloseAllowReason): void {
    if (why !== 'session-end' || this.allowed === null) this.allowed = why;
    this.drop();
    this.stopSessionEndTimer();
    if (this.allowed === 'session-end') {
      this.sessionEndTimer = this.deps.schedule(() => this.sessionEndOver(), SESSION_END_REARM_MS);
    }
  }

  /** Windows called the shutdown off (another app refused it): ask again before closing. */
  sessionEndCancelled(): void {
    if (this.allowed !== 'session-end') return;
    this.stopSessionEndTimer();
    this.allowed = null;
    this.deps.info('Till window: Windows did not shut down after all; asking again before closing');
  }

  /**
   * The screen crashed: its question went with it. The screen reloads by
   * itself (index.ts), and the next X asks again.
   */
  screenGone(): void {
    this.drop();
  }

  private letClose(): 'close' {
    this.drop();
    return 'close';
  }

  private drop(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (!p.acked) this.deps.cancel(p.timer);
  }

  /**
   * The till still runs SESSION_END_REARM_MS after Windows' last session end
   * (an installer or the Restart Manager asked, and nothing ended): ask again
   * before closing. A quit, an answer or a no-answer is never undone.
   */
  private sessionEndOver(): void {
    try {
      this.sessionEndTimer = null;
      if (this.allowed !== 'session-end') return;
      this.allowed = null;
      this.deps.info('Till window: Windows did not end the session; asking again before closing');
    } catch (e) {
      this.deps.warn('Till window: could not ask again after a session end', { error: errorText(e) });
    }
  }

  private stopSessionEndTimer(): void {
    if (this.sessionEndTimer === null) return;
    this.deps.cancel(this.sessionEndTimer);
    this.sessionEndTimer = null;
  }

  private noAnswer(p: Pending): void {
    try {
      if (this.pending !== p || p.acked) return;
      this.pending = null;
      this.allowed = 'no-answer';
      this.deps.warn('Till window: the screen did not show the close question in 5 s; closing');
      this.deps.closeWindow();
    } catch (e) {
      this.deps.warn('Till window: could not close after no answer', { error: errorText(e) });
    }
  }

  private async goodbyeThenClose(): Promise<void> {
    let limit: unknown = null;
    try {
      const said = Promise.resolve()
        .then(() => this.deps.sayClosing())
        .catch((e: unknown) => this.deps.warn('Till window: could not tell the website the till is closing', { error: errorText(e) }));
      const timeUp = new Promise<void>((resolve) => {
        limit = this.deps.schedule(resolve, GOODBYE_TIMEOUT_MS);
      });
      await Promise.race([said, timeUp]);
    } catch (e) {
      this.deps.warn('Till window: the goodbye to the website failed', { error: errorText(e) });
    }
    try {
      this.deps.cancel(limit);
      this.deps.closeWindow();
    } catch (e) {
      this.deps.warn('Till window: could not close', { error: errorText(e) });
    }
  }
}
