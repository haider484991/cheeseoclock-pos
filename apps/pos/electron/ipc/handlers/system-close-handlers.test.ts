/**
 * "Close the till?" over IPC (v0.7.33): 'system:closeShown' and
 * 'system:closeAnswer' work with nobody signed in (the PIN screen asks too;
 * the question stops a slip, it is not a lock), pass the screen's id and
 * answer through to the guard (till-close.ts), and refuse a missing id or an
 * answer that is not yes or no.
 *
 * `defineHandler` is replaced (it captures the handler instead of
 * registering it with Electron), and so is the guard's real wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '../registry.js';

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  registered: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  shown: [] as string[],
  answers: [] as Array<[string, boolean]>,
}));

vi.mock('../registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      h.registered.set(channel, fn);
    },
  };
});
vi.mock('../../services/till-close-hub.js', () => ({
  tillClose: {
    shown: (requestId: string) => {
      h.shown.push(requestId);
      return { pending: requestId === 'ask-1' };
    },
    answer: (requestId: string, close: boolean) => {
      h.answers.push([requestId, close]);
      return { closing: requestId === 'ask-1' && close };
    },
  },
}));
// Nobody is signed in, and the handlers must not ask.
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => {
    throw new Error('the close question must not look for a login');
  },
}));
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  app: { getPath: () => '', getVersion: () => '0.0.0-test', isPackaged: false },
}));

async function handlers() {
  const { registerSystemHandlers } = await import('./system-handlers.js');
  registerSystemHandlers({ db: {} as HandlerContext['db'], deviceId: 'till-1' });
  const get = (channel: string) => {
    const fn = h.registered.get(channel);
    if (!fn) throw new Error(`${channel} is not registered`);
    return (payload: unknown) => fn({}, payload);
  };
  return { shown: get('system:closeShown'), answer: get('system:closeAnswer') };
}

/** What a refused call threw (defineHandler turns an IpcGuardError into the answer). */
function refusal(call: () => unknown): { code: string; message: string } | null {
  try {
    call();
    return null;
  } catch (e) {
    return (e as { apiError?: { code: string; message: string } }).apiError ?? null;
  }
}

beforeEach(() => {
  h.shown.length = 0;
  h.answers.length = 0;
});

describe("'system:closeShown' / 'system:closeAnswer'", () => {
  it('are registered, and work with nobody signed in', async () => {
    const c = await handlers();
    expect(c.shown({ requestId: 'ask-1' })).toEqual({ ok: true, data: { pending: true } });
    expect(c.answer({ requestId: 'ask-1', close: true })).toEqual({ ok: true, data: { closing: true } });
  });

  it("pass the screen's id and answer through to the guard", async () => {
    const c = await handlers();
    expect(c.shown({ requestId: 'ask-old' })).toEqual({ ok: true, data: { pending: false } });
    expect(c.answer({ requestId: 'ask-1', close: false })).toEqual({ ok: true, data: { closing: false } });
    expect(c.answer({ requestId: 'ask-old', close: true })).toEqual({ ok: true, data: { closing: false } });
    expect(h.shown).toEqual(['ask-old']);
    expect(h.answers).toEqual([
      ['ask-1', false],
      ['ask-old', true],
    ]);
  });

  it('refuse a missing or empty id, and an answer that is not yes or no', async () => {
    const c = await handlers();
    const missing = { code: 'validation_failed', message: 'Missing request' };
    for (const bad of [undefined, null, {}, { requestId: '' }, { requestId: 7 }]) {
      expect(refusal(() => c.shown(bad))).toEqual(missing);
      expect(refusal(() => c.answer(bad === null || bad === undefined ? bad : { ...bad, close: true }))).toEqual(missing);
    }
    for (const close of [undefined, 'yes', 1, null]) {
      expect(refusal(() => c.answer({ requestId: 'ask-1', close }))).toEqual({
        code: 'validation_failed',
        message: 'Missing answer',
      });
    }
    // Nothing reached the guard.
    expect(h.shown).toEqual([]);
    expect(h.answers).toEqual([]);
  });
});
