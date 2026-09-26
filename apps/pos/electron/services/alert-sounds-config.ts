import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { normalizeAlertSoundSettings, type AlertSoundSettings } from '@cheeseoclock/shared-types';

/**
 * Settings → Sounds, stored per till (the settings table is never synced, so
 * the kitchen till and the counter till can sound different). Anything
 * missing or broken falls back to its default, field by field.
 */
export const ALERT_SOUNDS_KEY = 'alerts.sounds';

export function getAlertSoundSettings(db: AppDatabase): AlertSoundSettings {
  return normalizeAlertSoundSettings(getSettingRaw(db, ALERT_SOUNDS_KEY));
}

/** Saves (with an audit row: who turned the order sound off, and when). */
export function setAlertSoundSettings(
  db: AppDatabase,
  input: unknown,
  actorUserId: string | null,
): AlertSoundSettings {
  const value = normalizeAlertSoundSettings(input);
  setSetting(db, ALERT_SOUNDS_KEY, value, { actorUserId });
  return value;
}
