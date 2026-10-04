/**
 * The till's licence: where the key, the trial start and the clock fact live
 * (the `settings` table, through the settings repository) and the one place
 * that answers "may this till sell right now".
 *
 * Boot: init() after the device is registered. The first start records when
 * the free trial began. Every look at the status also records the latest time
 * the till has seen, so a clock set back cannot rewind the licence.
 *
 * Nothing here talks to the network. A key is issued by the vendor from this
 * till's Device ID and pasted into Settings → About; a new key for a later
 * period replaces the old one. Tests that never call init() see sales allowed.
 */
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

export type ActivateResult = { ok: true; status: LicenceStatus } | { ok: false; problem: string };

class LicenceService {
  private db: AppDatabase | null = null;
  private deviceId = '';
  private lastClockWriteMs = 0;

  init(db: AppDatabase, deviceId: string, now: Date = new Date()): LicenceStatus {
    this.db = db;
    this.deviceId = deviceId;
    this.lastClockWriteMs = 0;
    if (!asString(getSettingRaw(db, LICENCE_SETTING_TRIAL_STARTED))) {
      setSetting(db, LICENCE_SETTING_TRIAL_STARTED, now.toISOString());
    }
    const status = this.status(now);
    log.info('Licence', { state: status.state, daysLeft: status.daysLeft, plan: status.plan, problem: status.problem });
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

  private rememberClock(db: AppDatabase, now: Date, lastSeenAt: string | null): void {
    const nowMs = now.getTime();
    const seenMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
    if (!Number.isNaN(seenMs) && nowMs <= seenMs) return;
    if (nowMs - this.lastClockWriteMs < CLOCK_WRITE_EVERY_MS) return;
    setSetting(db, LICENCE_SETTING_LAST_SEEN, now.toISOString());
    this.lastClockWriteMs = nowMs;
  }
}

export const licenceService = new LicenceService();
