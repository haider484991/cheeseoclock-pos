/**
 * The real wiring of "This computer" (till-power-hub.ts) against a stand-in
 * Electron: the keep-awake request is 'prevent-display-sleep' and is held
 * only while this till takes website orders (re-checked on the in-process
 * 'alerts:watch-changed'), the start-up entry is written under the app's id
 * with no path or args and only by the installed till, sleep and wake are
 * heard, and a Save of the setting is applied at once. Importing the module
 * touches nothing of Electron's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginItemsState } from './till-power.js';

const h = vi.hoisted(() => {
  const touched: string[] = [];
  const blocker = {
    start: vi.fn((_type: string) => 0),
    stop: vi.fn((_id: number) => {}),
    isStarted: vi.fn((_id: number) => false),
  };
  const app = {
    getLoginItemSettings: vi.fn((): unknown => ({})),
    setLoginItemSettings: vi.fn((_s: Record<string, unknown>) => {}),
  };
  Object.defineProperty(app, 'isPackaged', {
    get: () => {
      touched.push('app.isPackaged');
      return true;
    },
  });
  return {
    touched,
    blocker,
    app: app as typeof app & { isPackaged: boolean },
    powerMonitorOn: vi.fn((_event: string, _cb: () => void) => {}),
    uninstallerExists: true,
    setting: { keepAwake: true, startWithWindows: true },
    cfg: { enabled: true, siteUrl: 'https://test.example', bridgeSecret: 'test-secret', secretUnreadable: false } as Record<string, unknown>,
    pause: null as null | { reason: 'shift_closed'; since: string },
    settings: new Map<string, unknown>(),
    setSettingCalls: [] as unknown[][],
  };
});

vi.mock('electron', () => ({
  app: h.app,
  powerSaveBlocker: h.blocker,
  powerMonitor: { on: h.powerMonitorOn },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => h.uninstallerExists,
}));
vi.mock('./till-settings.js', () => ({ readTillSetting: () => ({ ...h.setting }) }));
vi.mock('./web-bridge-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./web-bridge-config.js')>()),
  getWebBridgeConfig: () => ({ ...h.cfg }),
  getWebOrdersShiftPause: () => h.pause,
}));
vi.mock('../db/repositories/settings-repo.js', () => ({
  getSettingRaw: (_db: unknown, key: string) => h.settings.get(key) ?? null,
  setSetting: (...args: unknown[]) => {
    h.setSettingCalls.push(args);
    h.settings.set(args[1] as string, args[2]);
  },
}));

/** The start-up entry as Windows holds it (changed by setLoginItemSettings). */
let entry: LoginItemsState;
/** The keep-awake requests Windows holds now. */
const held = new Set<number>();

beforeEach(() => {
  vi.resetModules();
  h.touched.length = 0;
  h.uninstallerExists = true;
  h.setting = { keepAwake: true, startWithWindows: true };
  h.cfg = { enabled: true, siteUrl: 'https://test.example', bridgeSecret: 'test-secret', secretUnreadable: false };
  h.pause = null;
  h.settings.clear();
  h.setSettingCalls.length = 0;
  held.clear();
  entry = { openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] };
  let nextId = 1;
  h.blocker.start.mockReset().mockImplementation(() => {
    const id = nextId++;
    held.add(id);
    return id;
  });
  h.blocker.stop.mockReset().mockImplementation((id: number) => {
    held.delete(id);
  });
  h.blocker.isStarted.mockReset().mockImplementation((id: number) => held.has(id));
  h.app.getLoginItemSettings.mockReset().mockImplementation(() => entry);
  h.app.setLoginItemSettings.mockReset().mockImplementation((s: Record<string, unknown>) => {
    const enabled = s['enabled'] !== false;
    entry = s['openAtLogin']
      ? { openAtLogin: true, executableWillLaunchAtLogin: enabled, launchItems: [{ name: String(s['name']), scope: 'user', enabled }] }
      : { openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] };
  });
  h.powerMonitorOn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function load() {
  const hub = await import('./till-power-hub.js');
  const events = await import('./till-power-events.js');
  const watch = await import('./alert-watch-events.js');
  return { hub, events, watch };
}

const DB = {} as never;

describe('This computer, wired to Electron', () => {
  it('importing it touches nothing of Electron’s', async () => {
    const { hub } = await load();
    expect(hub.APP_USER_MODEL_ID).toBe('pk.cheeseoclock.pos');
    expect(h.touched).toEqual([]);
    expect(h.blocker.start).not.toHaveBeenCalled();
    expect(h.app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(h.powerMonitorOn).not.toHaveBeenCalled();
    expect(hub.tillPowerStatus()).toBeNull();
    expect(hub.turnTillPowerBackOn()).toBeNull();
  });

  it("at start, taking website orders: 'prevent-display-sleep' (never 'prevent-app-suspension'), the start-up entry under the app's id with no path or args, sleep and wake heard", async () => {
    const { hub } = await load();
    hub.initTillPower(DB, { onWoke: () => {} });
    expect(h.blocker.start.mock.calls).toEqual([['prevent-display-sleep']]);
    expect(h.app.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: true, name: 'pk.cheeseoclock.pos' }]]);
    const written = h.app.setLoginItemSettings.mock.calls[0]![0];
    expect(written).not.toHaveProperty('path');
    expect(written).not.toHaveProperty('args');
    expect(h.powerMonitorOn.mock.calls.map(([event]) => event).sort()).toEqual(['resume', 'suspend']);
    expect(hub.tillPowerStatus()).toMatchObject({ keepAwake: 'on', startWithWindows: 'on', lastSleep: null });
  });

  it('kept awake only while this till takes website orders: a shift pause, the switch off or no link let it go; the watch event re-checks', async () => {
    const { hub, watch } = await load();
    h.pause = { reason: 'shift_closed', since: '2026-10-01T22:00:00.000Z' };
    hub.initTillPower(DB, { onWoke: () => {} });
    expect(h.blocker.start).not.toHaveBeenCalled();
    expect(hub.tillPowerStatus()?.keepAwake).toBe('idle');
    // A shift opens: the pause is lifted and the screens are told — so is the keep-awake.
    h.pause = null;
    watch.broadcastAlertWatchChanged();
    expect(h.blocker.start).toHaveBeenCalledTimes(1);
    expect(held.size).toBe(1);
    // The owner switches "Accept online orders" off.
    h.cfg = { ...h.cfg, enabled: false };
    watch.broadcastAlertWatchChanged();
    expect(h.blocker.stop).toHaveBeenCalledTimes(1);
    expect(held.size).toBe(0);
    // On again, but the link's password cannot be read on this computer: not taking orders.
    h.cfg = { ...h.cfg, enabled: true, bridgeSecret: undefined, secretUnreadable: true };
    watch.broadcastAlertWatchChanged();
    expect(held.size).toBe(0);
    expect(hub.tillPowerStatus()?.keepAwake).toBe('idle');
  });

  it('a Save of "This computer" is applied at once: let go, and the start-up entry removed', async () => {
    const { hub, events } = await load();
    hub.initTillPower(DB, { onWoke: () => {} });
    h.app.setLoginItemSettings.mockClear();
    h.setting = { keepAwake: false, startWithWindows: false };
    events.tillPowerSettingsChanged();
    expect(h.blocker.stop).toHaveBeenCalledWith(1);
    expect(h.app.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: false, name: 'pk.cheeseoclock.pos' }]]);
    expect(hub.tillPowerStatus()).toMatchObject({ keepAwake: 'off', startWithWindows: 'off' });
  });

  it('switched off in Task Manager: left off at start; "Turn it back on" switches it on', async () => {
    entry = {
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
      launchItems: [{ name: 'pk.cheeseoclock.pos', scope: 'user', enabled: false }],
    };
    const { hub } = await load();
    hub.initTillPower(DB, { onWoke: () => {} });
    expect(h.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(hub.tillPowerStatus()?.startWithWindows).toBe('offInWindows');
    expect(hub.turnTillPowerBackOn()?.startWithWindows).toBe('on');
    expect(h.app.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: true, enabled: true, name: 'pk.cheeseoclock.pos' }]]);
  });

  it('not the installed till (no uninstaller next to it): Windows’ start-up list is never read or written', async () => {
    h.uninstallerExists = false;
    const { hub } = await load();
    hub.initTillPower(DB, { onWoke: () => {} });
    expect(h.app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(h.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(hub.tillPowerStatus()?.startWithWindows).toBe('notInstalled');
  });

  it('sleep is noted without an audit row; on waking the bridge is nudged 5 seconds later', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-01T23:00:00.000Z') });
    const { hub } = await load();
    const onWoke = vi.fn();
    hub.initTillPower(DB, { onWoke });
    const on = (event: string) => h.powerMonitorOn.mock.calls.find(([e]) => e === event)![1];
    on('suspend')();
    expect(h.setSettingCalls).toEqual([[DB, 'pc.lastSleep', { sleptAt: '2026-10-01T23:00:00.000Z', wokeAt: null }]]);
    vi.advanceTimersByTime(60 * 60_000);
    on('resume')();
    expect(h.settings.get('pc.lastSleep')).toEqual({ sleptAt: '2026-10-01T23:00:00.000Z', wokeAt: '2026-10-02T00:00:00.000Z' });
    // Bookkeeping: setSetting with no audit argument.
    expect(h.setSettingCalls.every((c) => c.length === 3)).toBe(true);
    expect(onWoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(onWoke).toHaveBeenCalledTimes(1);
    expect(hub.tillPowerStatus()?.lastSleep).toEqual({ sleptAt: '2026-10-01T23:00:00.000Z', wokeAt: '2026-10-02T00:00:00.000Z' });
  });
});
