/**
 * "Close the till?" (till-close.ts): when closing the till window is held
 * and asked about, and when it closes at once. Pure — the window, the
 * website bridge, the clock and the timers are fakes here.
 */
import { describe, expect, it } from 'vitest';
import type { CloseTillAsk } from '@cheeseoclock/shared-types';
import { ASK_ACK_TIMEOUT_MS, GOODBYE_TIMEOUT_MS, TillCloseGuard } from './till-close.js';

interface SetupOpts {
  /** What closing would stop; null = the website takes no orders through this till. */
  impact?: { openWebOrders: number } | null;
  impactThrows?: boolean;
  screenCanAsk?: boolean;
  askSends?: boolean;
  /** 'resolve' (default), 'reject', 'never' (never settles), 'throw' (throws before a promise). */
  goodbye?: 'resolve' | 'reject' | 'never' | 'throw';
}

function setup(opts: SetupOpts = {}) {
  let now = 0;
  let impact = opts.impact === undefined ? { openWebOrders: 2 } : opts.impact;
  let screenCanAsk = opts.screenCanAsk ?? true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  let nextId = 1;
  const asked: CloseTillAsk[] = [];
  const info: string[] = [];
  const warnings: string[] = [];
  let closes = 0;
  let goodbyes = 0;
  let resolveGoodbye: (() => void) | null = null;
  const guard = new TillCloseGuard({
    impact: () => {
      if (opts.impactThrows) throw new Error('database is closed');
      return impact;
    },
    screenCanAsk: () => screenCanAsk,
    ask: (req) => {
      asked.push(req);
      return opts.askSends ?? true;
    },
    closeWindow: () => {
      closes += 1;
    },
    sayClosing: () => {
      goodbyes += 1;
      switch (opts.goodbye ?? 'resolve') {
        case 'reject':
          return Promise.reject(new Error('fetch failed'));
        case 'never':
          return new Promise<void>(() => {});
        case 'throw':
          throw new Error('bridge not ready');
        default:
          return new Promise<void>((resolve) => {
            resolveGoodbye = resolve;
          });
      }
    },
    newId: () => `ask-${nextId++}`,
    info: (m) => info.push(m),
    warn: (m) => warnings.push(m),
    schedule: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (h) => {
      timers.delete(h as number);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  /** Let promise callbacks run (the goodbye's race). */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    guard,
    asked,
    info,
    warnings,
    advance,
    settle,
    timers,
    closes: () => closes,
    goodbyes: () => goodbyes,
    finishGoodbye: () => resolveGoodbye?.(),
    setImpact: (v: { openWebOrders: number } | null) => {
      impact = v;
    },
    setScreenCanAsk: (v: boolean) => {
      screenCanAsk = v;
    },
  };
}

describe('nothing to lose: the window closes at once, as before', () => {
  it('the website takes no orders through this till (no link, switch off, shift pause)', () => {
    const t = setup({ impact: null });
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toEqual([]);
    expect(t.timers.size).toBe(0);
  });

  it('the till cannot tell (the database throws): closes, with a warning', () => {
    const t = setup({ impactThrows: true });
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toEqual([]);
    expect(t.warnings).toHaveLength(1);
  });

  it('a crashed screen, or one Windows says is not responding: closes at once', () => {
    const t = setup({ screenCanAsk: false });
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toEqual([]);
    expect(t.warnings).toHaveLength(1);
  });

  it('the question could not be sent: closes', () => {
    const t = setup({ askSends: false });
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toHaveLength(1);
    expect(t.timers.size).toBe(0);
    // Nothing is left waiting: the next X asks afresh.
    expect(t.guard.shown('ask-1')).toEqual({ pending: false });
  });
});

describe('the website takes orders through this till: the close is held and asked about', () => {
  it('keep-open, with one question carrying the website orders still on Live Orders', () => {
    const t = setup({ impact: { openWebOrders: 3 } });
    expect(t.guard.onCloseRequested()).toBe('keep-open');
    expect(t.asked).toEqual([{ requestId: 'ask-1', openWebOrders: 3 }]);
    expect(t.info).toEqual(['Till window: asked before closing (website orders are on)']);
  });

  it('a second X while it is up sends the same question again and does not restart the clock', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.advance(3_000);
    expect(t.guard.onCloseRequested()).toBe('keep-open');
    expect(t.asked.map((a) => a.requestId)).toEqual(['ask-1', 'ask-1']);
    // 5 s after the FIRST X, not the second: closed once.
    t.advance(ASK_ACK_TIMEOUT_MS - 3_000);
    expect(t.closes()).toBe(1);
    t.advance(60_000);
    expect(t.closes()).toBe(1);
  });

  it('no word from the screen within 5 s: closes once, with a warning, and the next close goes through', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.advance(ASK_ACK_TIMEOUT_MS - 1);
    expect(t.closes()).toBe(0);
    t.advance(1);
    expect(t.closes()).toBe(1);
    expect(t.warnings).toEqual(['Till window: the screen did not show the close question in 5 s; closing']);
    // The close that closeWindow causes is let through.
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toHaveLength(1);
  });

  it('once the screen shows it, there is no time limit', () => {
    const t = setup();
    t.guard.onCloseRequested();
    expect(t.guard.shown('ask-1')).toEqual({ pending: true });
    t.advance(60 * 60_000);
    expect(t.closes()).toBe(0);
    // Shown again (a second X): still the same question.
    expect(t.guard.shown('ask-1')).toEqual({ pending: true });
  });

  it('an out-of-date question: shown answers pending false, an answer does nothing', async () => {
    const t = setup();
    expect(t.guard.shown('ask-9')).toEqual({ pending: false });
    expect(t.guard.answer('ask-9', true)).toEqual({ closing: false });
    t.guard.onCloseRequested();
    expect(t.guard.shown('ask-0')).toEqual({ pending: false });
    expect(t.guard.answer('ask-0', true)).toEqual({ closing: false });
    await t.settle();
    expect(t.goodbyes()).toBe(0);
    expect(t.closes()).toBe(0);
    // The real question is still up.
    expect(t.guard.shown('ask-1')).toEqual({ pending: true });
  });

  it('"Keep the till open": nothing closes, and the next X asks again with a new question', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.guard.shown('ask-1');
    expect(t.guard.answer('ask-1', false)).toEqual({ closing: false });
    expect(t.info).toContain('Till window: kept open');
    // Answered: the same id is out of date now.
    expect(t.guard.answer('ask-1', true)).toEqual({ closing: false });
    t.advance(60_000);
    expect(t.closes()).toBe(0);
    expect(t.goodbyes()).toBe(0);
    expect(t.guard.onCloseRequested()).toBe('keep-open');
    expect(t.asked.map((a) => a.requestId)).toEqual(['ask-1', 'ask-2']);
  });

  it('kept open before the screen said it was up: the 5 s clock stops too', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.guard.answer('ask-1', false);
    t.advance(ASK_ACK_TIMEOUT_MS * 2);
    expect(t.closes()).toBe(0);
  });
});

describe('"Close the till": the website hears "not accepting" first, then the window closes', () => {
  it('answers closing at once, says goodbye, and closes once the website has heard', async () => {
    const t = setup({ impact: { openWebOrders: 1 } });
    t.guard.onCloseRequested();
    t.guard.shown('ask-1');
    expect(t.guard.answer('ask-1', true)).toEqual({ closing: true });
    await t.settle();
    expect(t.goodbyes()).toBe(1);
    expect(t.closes()).toBe(0);
    t.finishGoodbye();
    await t.settle();
    expect(t.closes()).toBe(1);
    expect(t.info).toContain('Till window: closed by hand while website orders were on');
    // The close closeWindow causes is let through, without a second question.
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toHaveLength(1);
    // The goodbye's 2 s limit was cleared: no second close later.
    t.advance(GOODBYE_TIMEOUT_MS * 2);
    expect(t.closes()).toBe(1);
  });

  it('a website that never answers: the window still closes after 2 s', async () => {
    const t = setup({ goodbye: 'never' });
    t.guard.onCloseRequested();
    t.guard.shown('ask-1');
    t.guard.answer('ask-1', true);
    await t.settle();
    t.advance(GOODBYE_TIMEOUT_MS - 1);
    await t.settle();
    expect(t.closes()).toBe(0);
    t.advance(1);
    await t.settle();
    expect(t.closes()).toBe(1);
  });

  it('a goodbye that fails (rejects or throws): the window still closes, with a warning', async () => {
    for (const goodbye of ['reject', 'throw'] as const) {
      const t = setup({ goodbye });
      t.guard.onCloseRequested();
      t.guard.shown('ask-1');
      expect(t.guard.answer('ask-1', true)).toEqual({ closing: true });
      await t.settle();
      expect(t.closes()).toBe(1);
      expect(t.warnings).toEqual(['Till window: could not tell the website the till is closing']);
    }
  });

  it('a second answer to the same question does nothing', async () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.guard.answer('ask-1', true);
    expect(t.guard.answer('ask-1', true)).toEqual({ closing: false });
    expect(t.guard.answer('ask-1', false)).toEqual({ closing: false });
    await t.settle();
    t.finishGoodbye();
    await t.settle();
    expect(t.goodbyes()).toBe(1);
    expect(t.closes()).toBe(1);
  });
});

describe('never asked: quitting, Windows ending the session, the screen gone', () => {
  it('the app quitting (an update included) while the question is up: closes, and the old clock closes nothing', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.guard.allowClose('quit');
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toHaveLength(1);
    t.advance(ASK_ACK_TIMEOUT_MS * 2);
    expect(t.closes()).toBe(0);
    // The question that was up is out of date.
    expect(t.guard.answer('ask-1', true)).toEqual({ closing: false });
  });

  it('Windows ending the session: closes without asking', () => {
    const t = setup();
    t.guard.allowClose('session-end');
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toEqual([]);
  });

  it('Windows calling the shutdown off: the next X asks again', () => {
    const t = setup();
    t.guard.allowClose('session-end');
    t.guard.sessionEndCancelled();
    expect(t.guard.onCloseRequested()).toBe('keep-open');
    expect(t.asked).toHaveLength(1);
  });

  it('a called-off shutdown never undoes a quit, whichever came first', () => {
    const a = setup();
    a.guard.allowClose('quit');
    a.guard.sessionEndCancelled();
    expect(a.guard.onCloseRequested()).toBe('close');

    const b = setup();
    b.guard.allowClose('quit');
    b.guard.allowClose('session-end');
    b.guard.sessionEndCancelled();
    expect(b.guard.onCloseRequested()).toBe('close');
    expect([...a.asked, ...b.asked]).toEqual([]);
  });

  it('a called-off shutdown never undoes "Close the till" either', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.guard.answer('ask-1', true);
    t.guard.allowClose('session-end');
    t.guard.sessionEndCancelled();
    expect(t.guard.onCloseRequested()).toBe('close');
  });

  it('the screen crashed with the question up: no close later, and the next X asks with a new question', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.guard.screenGone();
    t.advance(ASK_ACK_TIMEOUT_MS * 2);
    expect(t.closes()).toBe(0);
    expect(t.guard.shown('ask-1')).toEqual({ pending: false });
    expect(t.guard.onCloseRequested()).toBe('keep-open');
    expect(t.asked.map((a) => a.requestId)).toEqual(['ask-1', 'ask-2']);
  });

  it('a second X once the screen stops responding closes at once', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.guard.shown('ask-1');
    t.setScreenCanAsk(false);
    expect(t.guard.onCloseRequested()).toBe('close');
    expect(t.asked).toHaveLength(1);
  });

  it('website orders stopped while the question was up (no shift, switch off): the next X closes', () => {
    const t = setup();
    t.guard.onCloseRequested();
    t.setImpact(null);
    expect(t.guard.onCloseRequested()).toBe('close');
    t.advance(ASK_ACK_TIMEOUT_MS * 2);
    expect(t.closes()).toBe(0);
  });
});
