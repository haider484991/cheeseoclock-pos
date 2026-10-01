import {
  DEFAULT_PC_POWER,
  type KeepAwakeState,
  type LastSleep,
  type PcPowerSetting,
  type StartWithWindowsState,
  type TillPowerStatus,
} from '@cheeseoclock/shared-types';

/**
 * "This computer" (the owner's 'pc.power' setting, Settings → Online
 * orders): what the till does with the computer it runs on.
 *
 *  - Keep it awake: while this till takes website orders (the website link
 *    set, "Accept online orders" on, a shift open), Windows may not turn the
 *    screen off or put the computer to sleep. A sleeping till takes no
 *    website orders, and the website closes by itself 3 minutes after the
 *    till's last heartbeat. Out of those hours Windows' own power settings
 *    apply again, so the screen is not kept on all night for nothing.
 *  - Start with Windows: the till opens when someone signs in to Windows
 *    (the installed till only). An entry missing, or left by an older
 *    install folder, is put back at start; one someone switched off in Task
 *    Manager is left off until the owner taps "Turn it back on".
 *  - The last time the computer slept, for the card, and a nudge to the
 *    website bridge when it wakes.
 *
 * Pure: Electron, the database and the clock come in through `deps` (see
 * till-power-hub.ts for the real ones), so the rules are unit-tested.
 * Nothing here throws: a power problem must never stop the till.
 */

/** Windows' "don't sleep" request (powerSaveBlocker). */
export interface BlockerPort {
  start(): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** What Windows says about the till's start-up entry (app.getLoginItemSettings). */
export interface LoginItemsState {
  /** The Run value named after the app's id points at this copy of the till. */
  openAtLogin: boolean;
  /** Some start-up entry for this copy is there and switched on in Task Manager. */
  executableWillLaunchAtLogin: boolean;
  /** The start-up entries that point at this copy, with whether Task Manager has each switched on. */
  launchItems: ReadonlyArray<{ name: string; scope: string; enabled: boolean }>;
}

/** The till's start-up entry (app.get/setLoginItemSettings). */
export interface LoginItemsPort {
  get(): LoginItemsState;
  set(s: { openAtLogin: boolean; enabled?: boolean }): void;
}

export interface TillPowerDeps {
  blocker: BlockerPort;
  /** Null when this copy may not start with Windows (canStartWithWindows). */
  loginItems: LoginItemsPort | null;
  /** The Run value's name: the app's id. */
  runValueName: string;
  readSetting(): PcPowerSetting;
  /** This till is taking website orders now (link ready, the owner's switch on, no shift pause). */
  takingOrders(): boolean;
  readLastSleep(): LastSleep | null;
  saveLastSleep(v: LastSleep): void;
  /** The computer woke up: the website bridge looks for orders and says it is open again. */
  onWoke(): void;
  now(): number;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

/**
 * Only the installed till may write the start-up entry: not a dev run, not a
 * test build that was never installed (no uninstaller next to it), not
 * another system.
 */
export function canStartWithWindows(env: { isPackaged: boolean; platform: string; uninstallerExists: boolean }): boolean {
  return env.isPackaged && env.platform === 'win32' && env.uninstallerExists;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class TillPower {
  private blockerId: number | null = null;
  /** Windows refused the last "keep awake": warned once, tried again on every check. */
  private awakeFailed = false;
  private readonly openedAt: string;

  constructor(private readonly deps: TillPowerDeps) {
    this.openedAt = new Date(deps.now()).toISOString();
  }

  /**
   * The setting, applied: at start, after the owner saves it, when the
   * computer wakes, and with `turnBackOn` for "Turn it back on" (the one
   * time a start-up entry switched off in Task Manager is switched on again).
   */
  apply(opts: { turnBackOn?: boolean } = {}): TillPowerStatus {
    const setting = this.setting();
    this.applyStartWithWindows(setting, opts.turnBackOn === true);
    return this.statusFor(setting);
  }

  /**
   * Keep awake only: whether this till takes website orders may have changed
   * (a shift opened or closed, the website link or switch saved). Cheap — it
   * never touches the start-up entry.
   */
  refreshAwake(): KeepAwakeState {
    return this.applyKeepAwake(this.setting());
  }

  /** For the owner's card. Keep awake is checked again on the way (a request Windows dropped is made again). */
  status(): TillPowerStatus {
    return this.statusFor(this.setting());
  }

  /** The computer is going to sleep: no website orders until it wakes. */
  slept(): void {
    try {
      this.deps.saveLastSleep({ sleptAt: this.iso(), wokeAt: null });
    } catch (e) {
      this.deps.warn('This computer: could not note that it went to sleep', { error: errorText(e) });
    }
    this.deps.warn('This computer is going to sleep: website orders stop until it wakes');
  }

  /** The computer woke up: noted, the setting applied again, and the website bridge told. */
  woke(): void {
    try {
      const last = this.deps.readLastSleep();
      if (last && last.wokeAt === null) {
        this.deps.saveLastSleep({ ...last, wokeAt: this.iso() });
        this.deps.info('This computer woke up', { sleptAt: last.sleptAt });
      }
    } catch (e) {
      this.deps.warn('This computer: could not note that it woke up', { error: errorText(e) });
    }
    this.apply();
    try {
      this.deps.onWoke();
    } catch (e) {
      this.deps.warn('This computer: the website bridge was not told it woke up', { error: errorText(e) });
    }
  }

  // -------------------------------------------------------------------------

  private statusFor(setting: PcPowerSetting): TillPowerStatus {
    return {
      keepAwake: this.applyKeepAwake(setting),
      startWithWindows: this.startWithWindowsState(setting),
      openedAt: this.openedAt,
      lastSleep: this.lastSleep(),
    };
  }

  private setting(): PcPowerSetting {
    try {
      return this.deps.readSetting();
    } catch (e) {
      this.deps.warn('This computer: the setting could not be read; using the default', { error: errorText(e) });
      return { ...DEFAULT_PC_POWER };
    }
  }

  private takingOrders(): boolean {
    try {
      return this.deps.takingOrders();
    } catch (e) {
      this.deps.warn('This computer: could not tell whether this till takes website orders', { error: errorText(e) });
      return false;
    }
  }

  private applyKeepAwake(setting: PcPowerSetting): KeepAwakeState {
    if (!setting.keepAwake || !this.takingOrders()) {
      this.releaseAwake(setting.keepAwake ? 'this till is not taking website orders' : 'switched off');
      return setting.keepAwake ? 'idle' : 'off';
    }
    if (this.blockerId !== null) {
      if (this.isStarted(this.blockerId)) return 'on';
      this.deps.warn('This computer: Windows dropped the keep-awake request; asking again');
      this.blockerId = null;
    }
    try {
      this.blockerId = this.deps.blocker.start();
    } catch (e) {
      if (!this.awakeFailed) this.deps.warn('This computer: Windows would not keep it awake', { error: errorText(e) });
      this.awakeFailed = true;
      return 'failed';
    }
    this.awakeFailed = false;
    this.deps.info('This computer: kept awake while this till takes website orders');
    return 'on';
  }

  private releaseAwake(why: string): void {
    this.awakeFailed = false;
    if (this.blockerId === null) return;
    const id = this.blockerId;
    this.blockerId = null;
    try {
      this.deps.blocker.stop(id);
    } catch (e) {
      this.deps.warn('This computer: could not let it sleep again', { error: errorText(e) });
      return;
    }
    this.deps.info(`This computer: no longer kept awake (${why})`);
  }

  private isStarted(id: number): boolean {
    try {
      return this.deps.blocker.isStarted(id);
    } catch {
      return false;
    }
  }

  private applyStartWithWindows(setting: PcPowerSetting, turnBackOn: boolean): void {
    const items = this.deps.loginItems;
    if (!items) return;
    const now = this.loginItems();
    if (!now) return;
    if (setting.startWithWindows) {
      if (turnBackOn && !now.executableWillLaunchAtLogin) {
        this.setLoginItem({ openAtLogin: true, enabled: true }, 'Start with Windows: turned back on by the owner');
      } else if (!now.openAtLogin) {
        // Missing, or pointing at an older install folder. One switched off in
        // Task Manager still reads openAtLogin: it is left as it is.
        this.setLoginItem({ openAtLogin: true }, 'Start with Windows: start-up entry written');
      }
    } else if (now.openAtLogin || this.ownItem(now)) {
      this.setLoginItem({ openAtLogin: false }, 'Start with Windows: start-up entry removed');
    }
  }

  private startWithWindowsState(setting: PcPowerSetting): StartWithWindowsState {
    if (!this.deps.loginItems) return 'notInstalled';
    if (!setting.startWithWindows) return 'off';
    const now = this.loginItems();
    if (!now) return 'missing';
    if (now.executableWillLaunchAtLogin) return 'on';
    return this.ownItem(now)?.enabled === false ? 'offInWindows' : 'missing';
  }

  private ownItem(s: LoginItemsState): { name: string; scope: string; enabled: boolean } | undefined {
    return s.launchItems.find((i) => i.name === this.deps.runValueName && i.scope === 'user');
  }

  private loginItems(): LoginItemsState | null {
    try {
      return this.deps.loginItems?.get() ?? null;
    } catch (e) {
      this.deps.warn('Start with Windows: could not read the start-up entry', { error: errorText(e) });
      return null;
    }
  }

  private setLoginItem(s: { openAtLogin: boolean; enabled?: boolean }, done: string): void {
    try {
      this.deps.loginItems?.set(s);
      this.deps.info(done);
    } catch (e) {
      this.deps.warn('Start with Windows: Windows did not take the change', { error: errorText(e), ...s });
    }
  }

  private lastSleep(): LastSleep | null {
    try {
      return this.deps.readLastSleep();
    } catch {
      return null;
    }
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }
}
