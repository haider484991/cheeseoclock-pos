/**
 * The till's licence: where the key, the trial start and the clock fact live
 * (the `settings` table, through the settings repository) and the one place
 * that answers "may this till sell right now".
 *
 * Boot: init() after the device is registered. The first start records when
 * the free trial began. Every look at the status also records the latest time
 * the till has seen, so a clock set back cannot rewind the licence.
 *
 * The trial start and the latest time seen are also kept in a small marker
 * file outside the data folder (%ProgramData%\CheeseOclock POS on Windows):
 * a wiped or redirected data folder (COC_USER_DATA_DIR) starts a new device
 * but not a new trial on the same PC. The marker is advisory — when it cannot
 * be read or written the settings alone decide — and holds no key.
 *
 * Nothing here talks to the network. A key is issued by the vendor from this
 * till's Device ID and pasted into Settings → About; a new key for a later
 * period replaces the old one. Tests that never call init() see sales allowed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log/main';
import type { LicenceStatus } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { getSettingRaw, setSetting } from '../../db/repositories/settings-repo.js';
import { checkLicenceToken, evaluateLicence } from './licence-core.js';
import { LICENCE_PUBLIC_KEY } from './public-key.js';

export const LICENCE_SETTING_TOKEN = 'licence.token';
export const LICENCE_SETTING_TRIAL_STARTED = 'licence.trialStartedAt';
export const LICENCE_SETTING_LAST_SEEN = 'licence.lastSeenAt';
/** The clock fact is written at most this often (a status look is cheap; a write is not free). */
const CLOCK_WRITE_EVERY_MS = 10 * 60 * 1000;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isoMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Where the machine-wide marker lives by default. */
export function defaultMachineMarkerPath(): string {
  const base = process.platform === 'win32' ? process.env['ProgramData'] || 'C:\\ProgramData' : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'CheeseOclock POS', 'licence-marker.json');
}

interface MachineMarker {
  trialStartedAt: string | null;
  lastSeenAt: string | null;
}

function readMarker(file: string | null): MachineMarker {
  if (!file) return { trialStartedAt: null, lastSeenAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return { trialStartedAt: asString(raw['trialStartedAt']), lastSeenAt: asString(raw['lastSeenAt']) };
  } catch {
    return { trialStartedAt: null, lastSeenAt: null };
  }
}

function writeMarker(file: string | null, marker: MachineMarker): void {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker));
  } catch (err) {
    log.warn('Licence: the machine marker could not be written; the settings alone decide', err);
  }
}

export type ActivateResult = { ok: true; status: LicenceStatus } | { ok: false; problem: string };

class LicenceService {
  private db: AppDatabase | null = null;
  private deviceId = '';
  private lastClockWriteMs = 0;
  private markerPath: string | null = null;

  /** `markerPath`: where the machine marker lives (null = none; tests pass a temp file). */
  init(db: AppDatabase, deviceId: string, now: Date = new Date(), markerPath: string | null = defaultMachineMarkerPath()): LicenceStatus {
    this.db = db;
    this.deviceId = deviceId;
    this.lastClockWriteMs = 0;
    this.markerPath = markerPath;

    const marker = readMarker(markerPath);
    // The trial began at the earliest start this PC knows of: the settings'
    // (this data folder) or the marker's (any earlier data folder on this PC).
    const settingsStart = isoMs(asString(getSettingRaw(db, LICENCE_SETTING_TRIAL_STARTED)));
    const markerStart = isoMs(marker.trialStartedAt);
    const starts = [settingsStart, markerStart].filter((v): v is number => v !== null);
    const startMs = starts.length ? Math.min(...starts) : now.getTime();
    const startIso = new Date(startMs).toISOString();
    if (settingsStart !== startMs) setSetting(db, LICENCE_SETTING_TRIAL_STARTED, startIso);
    // The latest time seen anywhere on this PC.
    const seen = [isoMs(asString(getSettingRaw(db, LICENCE_SETTING_LAST_SEEN))), isoMs(marker.lastSeenAt)].filter((v): v is number => v !== null);
    if (seen.length) {
      const seenIso = new Date(Math.max(...seen)).toISOString();
      if (asString(getSettingRaw(db, LICENCE_SETTING_LAST_SEEN)) !== seenIso) setSetting(db, LICENCE_SETTING_LAST_SEEN, seenIso);
    }
    writeMarker(markerPath, { trialStartedAt: startIso, lastSeenAt: asString(getSettingRaw(db, LICENCE_SETTING_LAST_SEEN)) });

    const status = this.status(now);
    log.info('Licence', { state: status.state, daysLeft: status.daysLeft, plan: status.plan, problem: status.problem, clockSuspect: status.clockSuspect });
    return status;
  }

  /** The whole answer for the card, the banner and the sales guard. */
  status(now: Date = new Date()): LicenceStatus {
    const db = this.db;
    if (!db) {
      return {
        state: 'trial',
        message: 'Licence not checked (till not started).',
        deviceId: this.deviceId,
        plan: null,
        shop: null,
        licenceId: null,
        paidUntil: null,
        daysLeft: 0,
        salesAllowed: true,
        problem: null,
        clockSuspect: false,
      };
    }
    const lastSeenAt = asString(getSettingRaw(db, LICENCE_SETTING_LAST_SEEN));
    this.rememberClock(db, now, lastSeenAt);
    return evaluateLicence({
      token: asString(getSettingRaw(db, LICENCE_SETTING_TOKEN)),
      deviceId: this.deviceId,
      trialStartedAt: asString(getSettingRaw(db, LICENCE_SETTING_TRIAL_STARTED)),
      lastSeenAt,
      publicKeyRaw: LICENCE_PUBLIC_KEY,
      now,
    });
  }

  /** May this till take and settle orders right now. True before init (tests, tools). */
  salesAllowed(now: Date = new Date()): boolean {
    return this.db ? this.status(now).salesAllowed : true;
  }

  /** Check a pasted key against this till; store it only when it is genuine and for this till. */
  activate(token: string, actorUserId: string | null, now: Date = new Date()): ActivateResult {
    const db = this.db;
    if (!db) return { ok: false, problem: 'The till has not finished starting. Try again in a moment.' };
    const check = checkLicenceToken(token, this.deviceId, LICENCE_PUBLIC_KEY);
    if (!check.ok) return { ok: false, problem: check.problem };
    setSetting(db, LICENCE_SETTING_TOKEN, token.trim(), { actorUserId });
    const status = this.status(now);
    log.info('Licence key entered', { licenceId: check.payload.id, plan: check.payload.plan, paidUntil: check.payload.expires, state: status.state });
    return { ok: true, status };
  }

  /**
   * The owner says the PC's date and time are right now: the latest time seen
   * becomes now, so a clock that was set far ahead and then corrected no
   * longer counts the licence from the wrong time. Audited (owner's id).
   */
  resetClock(actorUserId: string | null, now: Date = new Date()): LicenceStatus {
    const db = this.db;
    if (!db) return this.status(now);
    setSetting(db, LICENCE_SETTING_LAST_SEEN, now.toISOString(), { actorUserId });
    this.lastClockWriteMs = now.getTime();
    writeMarker(this.markerPath, {
      trialStartedAt: asString(getSettingRaw(db, LICENCE_SETTING_TRIAL_STARTED)),
      lastSeenAt: now.toISOString(),
    });
    log.info('Licence: the owner reset the clock fact', { now: now.toISOString() });
    return this.status(now);
  }

  private rememberClock(db: AppDatabase, now: Date, lastSeenAt: string | null): void {
    const nowMs = now.getTime();
    const seenMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
    if (!Number.isNaN(seenMs) && nowMs <= seenMs) return;
    if (nowMs - this.lastClockWriteMs < CLOCK_WRITE_EVERY_MS) return;
    setSetting(db, LICENCE_SETTING_LAST_SEEN, now.toISOString());
    this.lastClockWriteMs = nowMs;
    writeMarker(this.markerPath, {
      trialStartedAt: asString(getSettingRaw(db, LICENCE_SETTING_TRIAL_STARTED)),
      lastSeenAt: now.toISOString(),
    });
  }
}

export const licenceService = new LicenceService();
