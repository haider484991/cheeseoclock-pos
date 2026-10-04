import { z } from 'zod';
import { licenceService } from './licence/licence-service.js';
import {
  PICKUP_DISCOUNT_PERCENT,
  type BridgeHeartbeatBody,
  type WebOrdersPauseView,
  type WebOrdersShiftPause,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { openSecret, sealSecret } from './secret-seal.js';

export const WEB_BRIDGE_CONFIG_KEY = 'webBridge.config';

/**
 * Config for the online-ordering bridge (cheeseoclock.net ↔ this POS).
 * Stored in the settings table; the secret is sealed with the OS keychain
 * (see secret-seal.ts) so backups and USB copies never carry it in clear.
 */
export const WebBridgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** e.g. https://www.cheeseoclock.net — the exact host the site lives on, no trailing slash. */
  siteUrl: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),
  /**
   * Must equal BRIDGE_SECRET on the Vercel deployment. Trimmed: a stray space
   * pasted onto either end makes the bearer token a different length and the
   * website answers every call with 401.
   */
  bridgeSecret: z
    .string()
    .transform((s) => s.trim())
    .optional(),
  pollIntervalMs: z.number().int().min(5_000).default(20_000),
  /**
   * Scheduled upload of the (gzipped) SQLite database to the cloud.
   * Independent of `enabled` (online ordering) — a shop can back up to the
   * cloud without accepting web orders, as long as siteUrl + secret are set.
   */
  cloudBackupFrequency: z.enum(['off', 'daily', 'weekly', 'monthly']).default('daily'),
});

export const CLOUD_BACKUP_INTERVALS_MS: Record<
  'daily' | 'weekly' | 'monthly',
  number
> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export type WebBridgeConfig = z.infer<typeof WebBridgeConfigSchema>;

/** Config as readable on this machine. */
export interface LoadedWebBridgeConfig extends WebBridgeConfig {
  /**
   * True when a secret is stored but was sealed by another Windows account or
   * PC (a restored copy) and cannot be opened here. The owner enters it again.
   */
  secretUnreadable: boolean;
}

const DEFAULT: WebBridgeConfig = WebBridgeConfigSchema.parse({});

export function getWebBridgeConfig(db: AppDatabase): LoadedWebBridgeConfig {
  const raw = getSettingRaw(db, WEB_BRIDGE_CONFIG_KEY);
  const parsed = WebBridgeConfigSchema.safeParse(raw ?? {});
  const cfg = parsed.success ? parsed.data : { ...DEFAULT };
  const opened = openSecret(cfg.bridgeSecret);
  return { ...cfg, bridgeSecret: opened.value, secretUnreadable: opened.unreadable };
}

export function setWebBridgeConfig(
  db: AppDatabase,
  config: WebBridgeConfig,
  actorUserId: string | null = null,
): void {
  const { enabled, siteUrl, bridgeSecret, pollIntervalMs, cloudBackupFrequency } = config;
  setSetting(
    db,
    WEB_BRIDGE_CONFIG_KEY,
    {
      enabled,
      siteUrl,
      bridgeSecret: bridgeSecret ? sealSecret(bridgeSecret) : undefined,
      pollIntervalMs,
      cloudBackupFrequency,
    },
    { actorUserId },
  );
}

/** Parse + normalise a site URL typed by the operator (trailing slashes dropped). */
export function normaliseSiteUrl(input: string): string {
  return WebBridgeConfigSchema.shape.siteUrl.parse(input.trim()) as string;
}

export function isWebBridgeReady(
  c: WebBridgeConfig | LoadedWebBridgeConfig,
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.siteUrl) missing.push('Website URL');
  if (!c.bridgeSecret) {
    missing.push(
      'secretUnreadable' in c && c.secretUnreadable
        ? 'Bridge secret (it was saved on another PC — enter it again)'
        : 'Bridge secret',
    );
  }
  return { ok: missing.length === 0, missing };
}

// ---- the shift pause ------------------------------------------------------

/**
 * Website orders paused by the till itself because no shift is open on it
 * (owner, 2026-09-27): set when the last open shift closes — and, since
 * v0.7.33, at start or when the owner saves the link while none is open —
 * cleared when a shift opens (services/web-orders-shift-pause.ts). Per till
 * and pure-local, like the rest of the settings table.
 *
 * It lives under its own key, never inside `webBridge.config`: `enabled` there
 * is the owner's hand switch, and the pause must not overwrite it. The till
 * takes orders only while both allow it (storeAcceptingOrders), so opening a
 * shift cannot switch back on what the owner switched off.
 */
export const WEB_ORDERS_SHIFT_PAUSE_KEY = 'webBridge.shiftPause';

const StoredShiftPauseSchema = z.object({
  reason: z.literal('shift_closed'),
  since: z.string(),
});

/** The pause as stored: why, and since when. No row (or null) = not paused. */
export type StoredShiftPause = z.infer<typeof StoredShiftPauseSchema>;

export function getWebOrdersShiftPause(db: AppDatabase): StoredShiftPause | null {
  const parsed = StoredShiftPauseSchema.safeParse(getSettingRaw(db, WEB_ORDERS_SHIFT_PAUSE_KEY));
  return parsed.success ? parsed.data : null;
}

/**
 * Set or lift the pause. Audited like a setting a person changes — the
 * person who closed or opened the shift — so "why was the website shut at
 * 3 pm?" has an answer in the audit trail. Returns whether anything changed;
 * a repeat (a second close, an open with no pause) writes nothing.
 */
export function setWebOrdersShiftPause(
  db: AppDatabase,
  pause: StoredShiftPause | null,
  actorUserId: string | null,
): boolean {
  const current = getWebOrdersShiftPause(db);
  const unchanged = pause === null ? current === null : current?.reason === pause.reason;
  if (unchanged) return false;
  setSetting(db, WEB_ORDERS_SHIFT_PAUSE_KEY, pause, { actorUserId });
  return true;
}

/**
 * The one answer the heartbeat sends: the owner's switch is on AND the till
 * has not paused itself for want of an open shift.
 */
export function storeAcceptingOrders(
  cfg: Pick<WebBridgeConfig, 'enabled'>,
  pause: StoredShiftPause | null,
): boolean {
  // A till whose licence has run out stops selling, so the website must stop
  // taking orders for it too (licence-service.ts; true before the till starts).
  return cfg.enabled && pause === null && licenceService.salesAllowed();
}

/**
 * This till is taking website orders now: the website link is set (and its
 * password readable here), the owner's switch is on, and no shift pause.
 * While it is, the computer is kept awake (till-power-hub.ts) and closing
 * the till window asks first (till-close.ts, through closeImpact).
 */
export function takingWebOrders(
  cfg: WebBridgeConfig | LoadedWebBridgeConfig,
  pause: StoredShiftPause | null,
): boolean {
  return isWebBridgeReady(cfg).ok && storeAcceptingOrders(cfg, pause);
}

/** The heartbeat body (PUT /api/bridge/status) for this config and pause. */
export function storeHeartbeatBody(
  cfg: Pick<WebBridgeConfig, 'enabled'>,
  pause: StoredShiftPause | null,
  deviceId: string,
): BridgeHeartbeatBody {
  return {
    acceptingOrders: storeAcceptingOrders(cfg, pause),
    deviceId,
    // `features` tells the site what this till can import: it offers online
    // pick-up only while the listening till says 'pickup'.
    features: ['pickup'],
    // The site shows this percent, so the customer sees what the till bills.
    pickupDiscountPercent: PICKUP_DISCOUNT_PERCENT,
    // Only when the pause is what closes the shop; the owner's switch-off
    // sends no reason, as before.
    ...(cfg.enabled && pause ? { reason: pause.reason } : {}),
  };
}

/** The pause as Settings → Online orders shows it. */
export function describeShiftPause(pause: StoredShiftPause): WebOrdersShiftPause {
  return {
    reason: pause.reason,
    since: pause.since,
    message:
      'Website orders paused: shift closed — they start again when a shift is opened',
  };
}

/**
 * The pause as the PIN screen and the shift controls see it (inside
 * alerts:getWatch). Paused only while the owner's switch is on, the same rule
 * as storeHeartbeatBody: switched off by hand, the website is shut for that
 * reason, not for the shift. No connection details leave here, only whether
 * the link is set.
 */
export function webOrdersPauseView(
  cfg: LoadedWebBridgeConfig,
  pause: StoredShiftPause | null,
): WebOrdersPauseView {
  const websiteLinkSet = isWebBridgeReady(cfg).ok;
  return cfg.enabled && pause
    ? { paused: true, since: pause.since, websiteLinkSet }
    : { paused: false, websiteLinkSet };
}
