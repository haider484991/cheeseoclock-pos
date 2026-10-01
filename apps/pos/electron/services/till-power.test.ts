/**
 * "This computer" (till-power.ts): kept awake only while this till takes
 * website orders, the till's start-up entry in Windows, and the last time
 * the computer slept. Pure — Windows' keep-awake request, the start-up
 * entry, the setting, the database and the clock are fakes here.
 */
import { describe, expect, it } from 'vitest';
import type { LastSleep, PcPowerSetting } from '@cheeseoclock/shared-types';
import { canStartWithWindows, TillPower, type LoginItemsState } from './till-power.js';

const NAME = 'pk.cheeseoclock.pos';
const T0 = Date.parse('2026-10-01T09:00:00.000Z');

function setup(
  opts: {
    setting?: PcPowerSetting;
    taking?: boolean;
    loginItems?: LoginItemsState | null;
    startThrows?: boolean;
    setThrows?: boolean;
  } = {},
) {
  let now = T0;
  let setting: PcPowerSetting = opts.setting ?? { keepAwake: true, startWithWindows: true };
  let taking = opts.taking ?? true;
  let nextId = 1;
  const started = new Set<number>();
  const starts: number[] = [];
  const stops: number[] = [];
  let startThrows = opts.startThrows ?? false;
  let entry: LoginItemsState | null = opts.loginItems === undefined ? { openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] } : opts.loginItems;
  const sets: Array<{ openAtLogin: boolean; enabled?: boolean }> = [];
  let lastSleep: LastSleep | null = null;
  const saved: LastSleep[] = [];
  let woken = 0;
  const infos: string[] = [];
  const warnings: string[] = [];
  const tp = new TillPower({
    blocker: {
      start: () => {
        if (startThrows) throw new Error('refused');
        const id = nextId++;
        started.add(id);
        starts.push(id);
        return id;
      },
      stop: (id) => {
        started.delete(id);
        stops.push(id);
      },
      isStarted: (id) => started.has(id),
    },
    loginItems:
      entry === null
        ? null
        : {
            get: () => entry!,
            set: (s) => {
              sets.push(s);
              if (opts.setThrows) throw new Error('access denied');
              entry = s.openAtLogin
                ? {
                    openAtLogin: true,
                    executableWillLaunchAtLogin: s.enabled !== false,
                    launchItems: [{ name: NAME, scope: 'user', enabled: s.enabled !== false }],
                  }
                : { openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] };
            },
          },
    runValueName: NAME,
    readSetting: () => setting,
    takingOrders: () => taking,
    readLastSleep: () => lastSleep,
    saveLastSleep: (v) => {
      lastSleep = v;
      saved.push(v);
    },
    onWoke: () => {
      woken += 1;
    },
    now: () => now,
    info: (m) => infos.push(m),
    warn: (m) => warnings.push(m),
  });
  return {
    tp,
    starts,
    stops,
    sets,
    saved,
    infos,
    warnings,
    started,
    woken: () => woken,
    setSetting: (s: PcPowerSetting) => {
      setting = s;
    },
    setTaking: (t: boolean) => {
      taking = t;
    },
    setStartThrows: (t: boolean) => {
      startThrows = t;
    },
    setEntry: (e: LoginItemsState) => {
      entry = e;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const ON_AND_ENABLED: LoginItemsState = {
  openAtLogin: true,
  executableWillLaunchAtLogin: true,
  launchItems: [{ name: NAME, scope: 'user', enabled: true }],
};
const SWITCHED_OFF_IN_TASK_MANAGER: LoginItemsState = {
  openAtLogin: true,
  executableWillLaunchAtLogin: false,
  launchItems: [{ name: NAME, scope: 'user', enabled: false }],
};

describe('keep awake: only while this till takes website orders', () => {
  it('taking orders: one keep-awake request, however often it is applied', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    expect(t.tp.apply().keepAwake).toBe('on');
    expect(t.tp.apply().keepAwake).toBe('on');
    expect(t.tp.refreshAwake()).toBe('on');
    expect(t.tp.status().keepAwake).toBe('on');
    expect(t.starts).toEqual([1]);
    expect(t.stops).toEqual([]);
  });

  it('not taking orders (no shift, the switch off, no link): no request, and "idle" says why the screen may sleep', () => {
    const t = setup({ taking: false, loginItems: ON_AND_ENABLED });
    expect(t.tp.apply().keepAwake).toBe('idle');
    expect(t.starts).toEqual([]);
  });

  it('follows the orders: let go when the till stops taking them, asked again when it starts', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    t.tp.apply();
    t.setTaking(false);
    expect(t.tp.refreshAwake()).toBe('idle');
    expect(t.stops).toEqual([1]);
    expect(t.started.size).toBe(0);
    // Again with nothing held: nothing to let go of.
    expect(t.tp.refreshAwake()).toBe('idle');
    expect(t.stops).toEqual([1]);
    t.setTaking(true);
    expect(t.tp.refreshAwake()).toBe('on');
    expect(t.starts).toEqual([1, 2]);
  });

  it('switched off by the owner: the request is let go of with the same id, and the status says off', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    t.tp.apply();
    t.setSetting({ keepAwake: false, startWithWindows: true });
    expect(t.tp.apply().keepAwake).toBe('off');
    expect(t.stops).toEqual([1]);
    expect(t.tp.status().keepAwake).toBe('off');
    expect(t.starts).toEqual([1]);
  });

  it('Windows refuses: "failed" and one warning, never a throw; tried again, and on once Windows takes it', () => {
    const t = setup({ startThrows: true, loginItems: ON_AND_ENABLED });
    expect(t.tp.apply().keepAwake).toBe('failed');
    expect(t.tp.apply().keepAwake).toBe('failed');
    expect(t.tp.refreshAwake()).toBe('failed');
    expect(t.warnings.filter((w) => w.includes('would not keep it awake'))).toHaveLength(1);
    t.setStartThrows(false);
    expect(t.tp.refreshAwake()).toBe('on');
  });

  it('a request Windows dropped (isStarted false) is made again', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    t.tp.apply();
    t.started.clear();
    expect(t.tp.apply().keepAwake).toBe('on');
    expect(t.starts).toEqual([1, 2]);
    expect(t.warnings.some((w) => w.includes('dropped'))).toBe(true);
  });

  it('a check that throws counts as not taking orders: nothing held, never a throw', () => {
    const starts: number[] = [];
    const broken = new TillPower({
      blocker: { start: () => starts.push(1), stop: () => {}, isStarted: () => true },
      loginItems: null,
      runValueName: NAME,
      readSetting: () => ({ keepAwake: true, startWithWindows: true }),
      takingOrders: () => {
        throw new Error('database is closed');
      },
      readLastSleep: () => null,
      saveLastSleep: () => {},
      onWoke: () => {},
      now: () => T0,
      info: () => {},
      warn: () => {},
    });
    expect(broken.apply().keepAwake).toBe('idle');
    expect(starts).toEqual([]);
  });
});

describe('start with Windows', () => {
  it('not the installed till: "notInstalled" and nothing is written', () => {
    const t = setup({ loginItems: null });
    expect(t.tp.apply().startWithWindows).toBe('notInstalled');
    expect(t.sets).toEqual([]);
  });

  it('missing (or an older install folder): written once, then left alone', () => {
    const t = setup();
    expect(t.tp.apply().startWithWindows).toBe('on');
    expect(t.sets).toEqual([{ openAtLogin: true }]);
    t.tp.apply();
    t.tp.status();
    expect(t.sets).toEqual([{ openAtLogin: true }]);
  });

  it('already on: nothing is written', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    expect(t.tp.apply().startWithWindows).toBe('on');
    expect(t.sets).toEqual([]);
  });

  it('switched off in Task Manager: "offInWindows", and the start never switches it back on', () => {
    const t = setup({ loginItems: SWITCHED_OFF_IN_TASK_MANAGER });
    expect(t.tp.apply().startWithWindows).toBe('offInWindows');
    expect(t.tp.apply().startWithWindows).toBe('offInWindows');
    expect(t.sets).toEqual([]);
  });

  it('"Turn it back on" switches it on again in Windows', () => {
    const t = setup({ loginItems: SWITCHED_OFF_IN_TASK_MANAGER });
    t.tp.apply();
    expect(t.tp.apply({ turnBackOn: true }).startWithWindows).toBe('on');
    expect(t.sets).toEqual([{ openAtLogin: true, enabled: true }]);
  });

  it('switched off by the owner: an entry is removed; with none there, nothing is written', () => {
    const t = setup({ setting: { keepAwake: true, startWithWindows: false }, loginItems: ON_AND_ENABLED });
    expect(t.tp.apply().startWithWindows).toBe('off');
    expect(t.sets).toEqual([{ openAtLogin: false }]);
    const none = setup({ setting: { keepAwake: true, startWithWindows: false } });
    expect(none.tp.apply().startWithWindows).toBe('off');
    expect(none.sets).toEqual([]);
    // One left switched off in Task Manager is removed too.
    const off = setup({ setting: { keepAwake: true, startWithWindows: false }, loginItems: SWITCHED_OFF_IN_TASK_MANAGER });
    off.tp.apply();
    expect(off.sets).toEqual([{ openAtLogin: false }]);
  });

  it('Windows refuses the write: "missing" and a warning, never a throw', () => {
    const t = setup({ setThrows: true });
    expect(t.tp.apply().startWithWindows).toBe('missing');
    expect(t.warnings.some((w) => w.includes('did not take the change'))).toBe(true);
  });

  it('the setting changed while the till runs: applied at once', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    t.tp.apply();
    t.setSetting({ keepAwake: false, startWithWindows: false });
    expect(t.tp.apply()).toMatchObject({ keepAwake: 'off', startWithWindows: 'off' });
    expect(t.stops).toEqual([1]);
    expect(t.sets).toEqual([{ openAtLogin: false }]);
  });

  it('only the installed till, on Windows, may write it', () => {
    expect(canStartWithWindows({ isPackaged: true, platform: 'win32', uninstallerExists: true })).toBe(true);
    for (const env of [
      { isPackaged: false, platform: 'win32', uninstallerExists: true },
      { isPackaged: true, platform: 'linux', uninstallerExists: true },
      { isPackaged: true, platform: 'win32', uninstallerExists: false },
    ]) {
      expect({ env, can: canStartWithWindows(env) }).toEqual({ env, can: false });
    }
  });
});

describe('sleep and wake', () => {
  it('slept() notes when; woke() notes the wake, applies the setting again and tells the bridge once', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    t.tp.apply();
    t.advance(60_000);
    t.tp.slept();
    expect(t.saved).toEqual([{ sleptAt: '2026-10-01T09:01:00.000Z', wokeAt: null }]);
    expect(t.warnings).toContain('This computer is going to sleep: website orders stop until it wakes');
    // Asleep, Windows dropped the request; awake again, it is asked for again.
    t.started.clear();
    t.advance(30 * 60_000);
    t.tp.woke();
    expect(t.saved.at(-1)).toEqual({ sleptAt: '2026-10-01T09:01:00.000Z', wokeAt: '2026-10-01T09:31:00.000Z' });
    expect(t.woken()).toBe(1);
    expect(t.starts).toEqual([1, 2]);
    expect(t.tp.status().lastSleep).toEqual({ sleptAt: '2026-10-01T09:01:00.000Z', wokeAt: '2026-10-01T09:31:00.000Z' });
  });

  it('woke() with no sleep noted: nothing written, no throw, the bridge still told', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    expect(() => t.tp.woke()).not.toThrow();
    expect(t.saved).toEqual([]);
    expect(t.woken()).toBe(1);
    expect(t.tp.status().lastSleep).toBeNull();
  });

  it('openedAt is when this run started, whatever happens later', () => {
    const t = setup({ loginItems: ON_AND_ENABLED });
    t.advance(5 * 60 * 60_000);
    t.tp.slept();
    t.tp.woke();
    expect(t.tp.status().openedAt).toBe('2026-10-01T09:00:00.000Z');
  });
});
