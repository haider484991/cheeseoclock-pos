/**
 * The real wiring of "Close the till?" (till-close-hub.ts) against a
 * stand-in window: the window's 'close' is held only while the website takes
 * orders through this till, the question goes to the screen with the till
 * brought to the front, a screen Windows says is not responding closes at
 * once, Windows ending the session (WM_QUERYENDSESSION, 'session-end') is let
 * through and a called-off shutdown (WM_ENDSESSION, wParam 0) asks again,
 * the app quitting is let through, and "Close the till" says goodbye to the
 * website before the window closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  impact: { takingOrders: true, openWebOrders: 2 },
  sayTillClosing: vi.fn(async () => {}),
}));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('./web-orders-bridge.js', () => ({
  webOrdersBridge: { closeImpact: () => ({ ...h.impact }), sayTillClosing: h.sayTillClosing },
}));

type Listener = (...args: unknown[]) => void;

/** A stand-in BrowserWindow: what it was told, and its listeners to fire. */
function fakeWindow(opts: { minimized?: boolean } = {}) {
  const on = new Map<string, Listener>();
  const contentsOn = new Map<string, Listener>();
  const hooks = new Map<number, (wParam: Buffer, lParam: Buffer) => void>();
  const calls: string[] = [];
  const sent: Array<[string, unknown]> = [];
  const w = {
    on: (event: string, cb: Listener) => {
      on.set(event, cb);
      return w;
    },
    hookWindowMessage: (msg: number, cb: (wParam: Buffer, lParam: Buffer) => void) => {
      hooks.set(msg, cb);
    },
    isDestroyed: () => false,
    isMinimized: () => opts.minimized ?? false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    close: () => calls.push('close'),
    webContents: {
      on: (event: string, cb: Listener) => contentsOn.set(event, cb),
      send: (channel: string, payload: unknown) => sent.push([channel, payload]),
      isCrashed: () => false,
    },
  };
  /** Press X: whether the close was held. */
  const pressX = (): boolean => {
    let held = false;
    on.get('close')?.({ preventDefault: () => (held = true) });
    return held;
  };
  return { w, on, contentsOn, hooks, calls, sent, pressX };
}

let hub: typeof import('./till-close-hub.js');
const realPlatform = process.platform;

beforeEach(async () => {
  h.impact = { takingOrders: true, openWebOrders: 2 };
  h.sayTillClosing.mockClear();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.resetModules();
  hub = await import('./till-close-hub.js');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
});

function attach(opts: { minimized?: boolean } = {}) {
  const f = fakeWindow(opts);
  hub.attachTillWindow(f.w as unknown as Parameters<typeof hub.attachTillWindow>[0]);
  return f;
}

describe('the till window, held and asked about', () => {
  it('website orders on: X is held, the till comes to the front (restored if minimised) and the screen is asked', () => {
    const f = attach({ minimized: true });
    expect(f.pressX()).toBe(true);
    expect(f.calls).toEqual(['restore', 'show', 'focus']);
    expect(f.sent).toEqual([['system:close-requested', { requestId: expect.any(String), openWebOrders: 2 }]]);
  });

  it('website orders off (no link, switch off, no shift): X closes at once and nothing is asked', () => {
    h.impact = { takingOrders: false, openWebOrders: 0 };
    const f = attach();
    expect(f.pressX()).toBe(false);
    expect(f.sent).toEqual([]);
  });

  it('a screen Windows says is not responding closes at once; once it answers again, X asks', () => {
    const f = attach();
    f.on.get('unresponsive')?.();
    expect(f.pressX()).toBe(false);
    f.on.get('responsive')?.();
    expect(f.pressX()).toBe(true);
  });

  it('"Close the till": the website hears it first, then the window closes', async () => {
    const f = attach();
    f.pressX();
    const ask = f.sent[0]![1] as { requestId: string };
    expect(hub.tillClose.shown(ask.requestId)).toEqual({ pending: true });
    expect(hub.tillClose.answer(ask.requestId, true)).toEqual({ closing: true });
    await vi.waitFor(() => expect(f.calls.at(-1)).toBe('close'));
    expect(h.sayTillClosing).toHaveBeenCalledOnce();
    // The close that follows goes through.
    expect(f.pressX()).toBe(false);
  });

  it('the screen crashed: the question it had is gone', () => {
    const f = attach();
    f.pressX();
    const ask = f.sent[0]![1] as { requestId: string };
    f.contentsOn.get('render-process-gone')?.();
    expect(hub.tillClose.shown(ask.requestId)).toEqual({ pending: false });
  });
});

describe('never asked: quitting and Windows ending the session', () => {
  it('the app quitting (an update\'s "Restart now" too)', () => {
    const f = attach();
    hub.allowTillToClose('quit');
    expect(f.pressX()).toBe(false);
    expect(f.sent).toEqual([]);
  });

  it("Windows' 'session-end'", () => {
    const f = attach();
    f.on.get('session-end')?.();
    expect(f.pressX()).toBe(false);
  });

  it('WM_QUERYENDSESSION lets the window close; WM_ENDSESSION with wParam 0 (called off) asks again', () => {
    const f = attach();
    expect([...f.hooks.keys()].sort()).toEqual([0x0011, 0x0016]);
    f.hooks.get(0x0011)?.(Buffer.alloc(8), Buffer.alloc(8));
    expect(f.pressX()).toBe(false);
    // Ending after all (wParam TRUE): still closes.
    f.hooks.get(0x0016)?.(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(8));
    expect(f.pressX()).toBe(false);
    // Called off: asks again.
    f.hooks.get(0x0016)?.(Buffer.alloc(8), Buffer.alloc(8));
    expect(f.pressX()).toBe(true);
  });

  it('only Windows gets the message hooks', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const f = attach();
    expect(f.hooks.size).toBe(0);
  });
});
