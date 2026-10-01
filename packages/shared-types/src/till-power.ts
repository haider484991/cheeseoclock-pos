/**
 * "This computer" (Settings → Online orders): what the till is doing right
 * now with the computer it runs on, for the owner's card (power:getStatus).
 * The owner's choices are the 'pc.power' till setting (till-settings.ts).
 */

/**
 * Keeping this computer awake:
 *  - 'on': held awake now, because this till is taking website orders;
 *  - 'idle': the setting is on, but this till is not taking website orders
 *    now (no shift open, online orders off, or no website link), so
 *    Windows' own power settings apply;
 *  - 'off': the owner switched it off;
 *  - 'failed': it should be held awake and Windows refused.
 */
export type KeepAwakeState = 'on' | 'idle' | 'off' | 'failed';

/**
 * Starting the till with Windows:
 *  - 'on': Windows opens the till when someone signs in;
 *  - 'off': the owner switched it off;
 *  - 'offInWindows': the start-up entry is there but switched off in Task
 *    Manager → Startup apps;
 *  - 'missing': the setting is on but Windows has no entry (the write failed);
 *  - 'notInstalled': a dev run, a test build that was not installed, or not
 *    Windows.
 */
export type StartWithWindowsState = 'on' | 'off' | 'offInWindows' | 'missing' | 'notInstalled';

/** The last time this computer went to sleep while the till was open (ISO 8601 UTC). */
export interface LastSleep {
  sleptAt: string;
  /** Null until it woke up again (or while it never did, with the till open). */
  wokeAt: string | null;
}

/** power:getStatus — the owner's "This computer" card. */
export interface TillPowerStatus {
  keepAwake: KeepAwakeState;
  startWithWindows: StartWithWindowsState;
  /** When this run of the till started (ISO 8601 UTC). */
  openedAt: string;
  lastSleep: LastSleep | null;
}
