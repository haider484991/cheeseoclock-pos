import log from 'electron-log/main';
import { app, BrowserWindow } from 'electron';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppDatabase } from '../db/connection.js';
import { getSyncConfig } from './sync-config.js';
import { nowIso } from '../db/repositories/base.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { createBackup, stageRestoreFromPath } from './backup-service.js';
import { sealSecret } from './secret-seal.js';
import {
  createOrder,
  addOrderItem,
  applyDiscount,
  sendOrderToKitchen,
  findOrder,
  getOrderSnapshot,
} from '../db/repositories/order-repo.js';
import {
  createCustomer,
  createAddress,
  snapshotCustomerOntoOrder,
} from '../db/repositories/customer-repo.js';
import { printSpooler } from './print-spooler.js';
import {
  getWebBridgeConfig,
  isWebBridgeReady,
  CLOUD_BACKUP_INTERVALS_MS,
  type WebBridgeConfig,
} from './web-bridge-config.js';
import { getReceiptBranding } from './printer-config.js';
import { isStaleWebOrder } from './web-order-age.js';
import {
  CHUNKS_FORMAT,
  ChunksUnsupportedError,
  downloadChunkedCopy,
  uploadChunkedCopy,
  type BridgeApi,
} from './cloud-copy-chunks.js';
import { dumpDatabase, rebuildDatabase, type RowSink, type RowSource } from './cloud-copy-rows.js';
import {
  PICKUP_DISCOUNT_PERCENT,
  type BridgeHeartbeatBody,
  type CloudBackupEntry,
  type PublishedMenu,
  type PublishedMenuCategory,
  type WebOrder,
  type WebOrderStatus,
  type OrderStatus,
} from '@cheeseoclock/shared-types';

/**
 * Web orders bridge — connects this POS to cheeseoclock.net.
 *
 * Inbound (every poll tick):
 *   1. GET {site}/api/bridge/orders → list of status='new' web orders
 *   2. For each: import locally (mode 'delivery', source 'web'), attach the
 *      customer (created/reused by phone), add items, send to kitchen so it
 *      lands on the Live Orders board, print a kitchen copy, then ACK.
 *      Idempotent via the web_order_imports table — a re-poll after a
 *      half-failed ack can't double-import.
 *
 * Outbound (same tick):
 *   3. For every imported order whose POS status maps to a different
 *      web-facing status than we last pushed → POST .../status so the
 *      customer's tracking page moves.
 *
 * Also owns "Publish menu" — serializes the active menu (categories, items,
 * modifiers, tax rates, images) and PUTs it to the site — and the cloud
 * copies of the database (upload with a manifest, list from any PC, restore
 * with checksum verification).
 */

const MAX_IMPORT_ATTEMPTS = 5;
/**
 * How often the bridge checks the website for new orders + pushes status
 * updates. Fixed at 10s for a near-real-time feel regardless of the stored
 * pollIntervalMs (which has no UI and older installs left at 20s). Gentle
 * enough for the Neon/Vercel free tiers.
 */
const ORDER_POLL_MS = 10_000;
// The website closes itself 3 minutes after the last heartbeat, so once a
// minute is plenty. Every heartbeat is a database write on the site, and a
// write every 10 s kept the (free-tier) database awake around the clock.
const HEARTBEAT_MS = 60_000;
/**
 * A web order older than this when first seen is cancelled, not cooked. The
 * website expires unconfirmed orders on the same clock (UNCONFIRMED_ORDER_TTL_MS
 * in apps/web/src/lib/store-status.ts); this is the till's own refusal in case
 * a site deployed before that sweep hands one over after a long outage.
 */
const MAX_IMPORT_AGE_MS = 45 * 60_000;
/**
 * Scheduled cloud backups: after any attempt (success or failure) wait at
 * least this long before trying again, so a failing upload does not retry on
 * every 10s tick. Manual uploads from Settings are not throttled.
 */
const CLOUD_BACKUP_RETRY_MS = 60 * 60_000;
/**
 * The one-blob upload cap of a website that predates chunked copies: its
 * schema allows 4,000,000 base64 characters, exactly 3,000,000 gzip bytes.
 * Only the fallback path needs it — chunked copies have no size limit.
 */
const CLOUD_BACKUP_MAX_GZ_BYTES = 3_000_000;
/** The bridge's writes are attributed to this synthetic actor in audit logs. */
const WEB_ACTOR_NAME = 'web-bridge';
/** Audit history kept in the cloud copy. Local and USB copies are complete. */
const CLOUD_COPY_AUDIT_DAYS = 90;

export type CloudCopyReason = 'scheduled' | 'manual' | 'before-restore';

/** What a cloud copy says about itself. Stored by the server next to the copy. */
interface CloudCopyManifest {
  schema: 2;
  /**
   * 'chunks-v1': a row export (cloud-copy-rows.ts) in chunks, only new ones
   * sent; 'blob': the SQLite file in one gzip upload (sites before 0.6.6).
   */
  format: typeof CHUNKS_FORMAT | 'blob';
  deviceId: string;
  deviceName: string | null;
  appVersion: string;
  reason: CloudCopyReason;
  createdAtClient: string;
  orderCount: number;
  lastOrderAt: string | null;
  auditRows: number;
  auditHeadHash: string | null;
  trimmed: { syncRowsDropped: number; auditRowsDropped: number; auditDaysKept: number };
  rawBytes: number;
  /** Gzip bytes sent this time (for a chunked copy: only the new chunks). */
  gzBytes: number;
  chunkCount?: number;
  newChunkCount?: number;
}

interface BridgeStatus {
  enabled: boolean;
  ready: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  importedTotal: number;
  consecutiveFails: number;
  lastCloudBackupAt: string | null;
  lastCloudBackupError: string | null;
  /** Last per-order import failure (caught inside the pull, not the tick). */
  lastImportError: string | null;
}

/** Just enough to talk to the site: the saved config, or one typed into the onboarding wizard. */
export interface BridgeConnection {
  siteUrl?: string | undefined;
  bridgeSecret?: string | undefined;
}

const LAST_CLOUD_BACKUP_KEY = 'webBridge.lastCloudBackupAt';
const LAST_CLOUD_META_KEY = 'webBridge.lastCloudBackupMeta';
/** When an upload was last tried, success or not — throttles scheduled retries. */
const LAST_CLOUD_ATTEMPT_KEY = 'webBridge.lastCloudBackupAttemptAt';
/** When the copy was last refused for size — no scheduled retry until the next full interval. */
const LAST_CLOUD_TOO_LARGE_KEY = 'webBridge.lastCloudBackupTooLargeAt';

interface ServerBackupRow {
  id: string;
  deviceId: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  sha256: string | null;
  meta: Partial<CloudCopyManifest> | null;
}

class WebOrdersBridge {
  private db: AppDatabase | null = null;
  private deviceId = '';
  private systemUserId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPollAt: string | null = null;
  private lastHeartbeatAt = 0;
  private lastError: string | null = null;
  private importedTotal = 0;
  private consecutiveFails = 0;
  private lastCloudBackupError: string | null = null;
  private lastImportError: string | null = null;
  private cloudBackupRunning = false;
  /** Which throttled attempt we last logged a "waiting until" line for — once per wait, not per tick. */
  private cloudBackupWaitLoggedFor: number | null = null;
  /** `enabled` as of the last reschedule, so a switch OFF can be told from a plain restart. */
  private lastEnabled: boolean | null = null;
  /** Where a site URL really lives once a redirect has told us (apex → www). */
  private canonicalOrigin: { for: string | undefined; origin: string } | null = null;

  init(db: AppDatabase, deviceId: string): void {
    this.db = db;
    this.deviceId = deviceId;
    this.reschedule();
  }

  /** Re-read config and restart the polling loop (after settings change). */
  reschedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.db) return;
    const cfg = getWebBridgeConfig(this.db);
    // Tell the website at once, above all when this is a switch OFF: the site
    // should stop taking orders the moment the cashier unticks the box, not
    // whenever the last heartbeat happens to go stale.
    // Orders placed in the seconds before the switch-off are still 'new' on
    // the site and would never be pulled again — cancel them once, after the
    // status push, so the customer's tracker says "couldn't confirm, call us".
    const turningOff = this.lastEnabled === true && !cfg.enabled;
    this.lastEnabled = cfg.enabled;
    if (isWebBridgeReady(cfg).ok) {
      void this.pushStoreStatus(cfg)
        .catch(() => undefined)
        .then(() => (turningOff ? this.cancelUnclaimedOrders(cfg) : undefined));
    }
    // The loop runs when EITHER feature needs it: online orders, or
    // scheduled cloud backups. Both require URL + secret.
    // …and while web orders already taken still have news for their customers.
    const anyFeatureOn =
      cfg.enabled || cfg.cloudBackupFrequency !== 'off' || this.hasUnfinishedWebOrders();
    if (!anyFeatureOn || !isWebBridgeReady(cfg).ok) return;
    this.timer = setInterval(() => void this.tick(), ORDER_POLL_MS);
    void this.tick();
  }

  /** Web orders whose customer has not yet been told delivered or cancelled. */
  private hasUnfinishedWebOrders(): boolean {
    if (!this.db) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM web_order_imports
            WHERE status = 'imported'
              AND IFNULL(last_pushed_status, '') NOT IN ('delivered', 'cancelled')
            LIMIT 1`,
        )
        .get() !== undefined
    );
  }

  /** Stop polling — called right before the app restarts for a restore. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): BridgeStatus {
    const cfg = this.db ? getWebBridgeConfig(this.db) : null;
    const lastBackup = this.db
      ? (getSettingRaw(this.db, LAST_CLOUD_BACKUP_KEY) as string | null)
      : null;
    return {
      enabled: cfg?.enabled ?? false,
      ready: cfg ? isWebBridgeReady(cfg).ok : false,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      importedTotal: this.importedTotal,
      consecutiveFails: this.consecutiveFails,
      lastCloudBackupAt: typeof lastBackup === 'string' ? lastBackup : null,
      lastCloudBackupError: this.lastCloudBackupError,
      lastImportError: this.lastImportError,
    };
  }

  kick(): void {
    void this.tick();
  }

  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.running || !this.db) return;
    const cfg = getWebBridgeConfig(this.db);
    if (!isWebBridgeReady(cfg).ok) return;
    this.running = true;
    try {
      // Best-effort and first: keeps the website's "open for orders" flag
      // fresh. Never fatal — a website that rejects it must not stop orders
      // already placed from being pulled in.
      // With ordering off the site is already closed (the switch-off pushed
      // one final "not accepting", and the site fails closed when heartbeats
      // stop), so nothing needs to be said — and saying nothing overnight
      // lets the site's database go to sleep.
      if (cfg.enabled && Date.now() - this.lastHeartbeatAt >= HEARTBEAT_MS) {
        this.lastHeartbeatAt = Date.now();
        await this.pushStoreStatus(cfg).catch((e: unknown) => {
          this.lastHeartbeatAt = 0; // try again next tick
          log.warn('Store status heartbeat failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
      if (cfg.enabled) await this.pullNewOrders(cfg);
      // Status pushes run whether or not new orders are being accepted:
      // unticking "Accept online orders" at closing time used to freeze the
      // tracking page of every web order still in the kitchen or on the road
      // until someone ticked it again (audit 2026-09-25). With nothing to
      // push this makes no network call.
      await this.pushStatusUpdates(cfg);
      this.lastPollAt = nowIso();
      this.lastError = null;
      this.consecutiveFails = 0;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.consecutiveFails += 1;
      // Quiet warn — network blips are normal on shop Wi-Fi.
      log.warn('Web bridge tick failed', { error: this.lastError });
    } finally {
      this.running = false;
    }
    // Scheduled cloud backup rides the same loop but never blocks order
    // import — and runs even when online ordering is off.
    void this.maybeCloudBackup(cfg);
  }

  /**
   * One final drain after "Accept online orders" is switched off: whatever is
   * still 'new' on the site was placed while the shop was closing and nobody
   * will pull it now. Anything already imported (ack lost) is re-acked
   * instead — it is on the kitchen board. Never throws; a failed drain is
   * logged and the site's own 45-minute sweep is the backstop.
   */
  private async cancelUnclaimedOrders(cfg: WebBridgeConfig): Promise<void> {
    if (!this.db) return;
    // Don't race a tick that read `enabled: true` and may be mid-import.
    for (let waited = 0; this.running && waited < 20_000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.running) {
      log.warn('Web bridge: skipped the switch-off drain — a poll is still running');
      return;
    }
    this.running = true;
    try {
      const db = this.db;
      const res = await this.api(cfg, '/api/bridge/orders');
      if (!res.ok) throw new Error(`Pull failed: HTTP ${res.status}`);
      const json = (await res.json()) as { ok: boolean; data?: WebOrder[] };
      if (!json.ok || !json.data) throw new Error('Pull failed: bad response');
      let cancelled = 0;
      for (const order of json.data) {
        const existing = db
          .prepare(`SELECT pos_order_id FROM web_order_imports WHERE web_order_id = ?`)
          .get(order.id) as { pos_order_id: string | null } | undefined;
        if (existing?.pos_order_id) {
          await this.importOne(cfg, order); // already local → re-acks only
          continue;
        }
        const push = await this.api(cfg, `/api/bridge/orders/${order.id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'cancelled' }),
        });
        if (!push.ok) {
          log.warn('Web bridge: could not cancel an order on switch-off', {
            webOrderId: order.id,
            status: push.status,
          });
          continue;
        }
        const now = nowIso();
        db.prepare(
          `INSERT INTO web_order_imports (web_order_id, status, attempts, last_error, created_at, updated_at)
           VALUES (?, 'failed', 0, 'shop_closed', ?, ?)
           ON CONFLICT(web_order_id) DO UPDATE SET
             status = 'failed', last_error = 'shop_closed', updated_at = excluded.updated_at`,
        ).run(order.id, now, now);
        cancelled += 1;
      }
      if (cancelled > 0) {
        log.info('Web bridge: online orders switched off — cancelled unclaimed orders', {
          cancelled,
        });
      }
    } catch (e) {
      log.warn('Web bridge: switch-off drain failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.running = false;
    }
  }

  // ---- cloud backups ------------------------------------------------------

  private async maybeCloudBackup(cfg: WebBridgeConfig): Promise<void> {
    if (!this.db || this.cloudBackupRunning) return;
    if (cfg.cloudBackupFrequency === 'off') return;
    const intervalMs = CLOUD_BACKUP_INTERVALS_MS[cfg.cloudBackupFrequency];
    const now = Date.now();
    const readAt = (key: string): number => {
      const raw = getSettingRaw(this.db!, key);
      const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    if (now - readAt(LAST_CLOUD_BACKUP_KEY) < intervalMs) return;
    // A copy the server refused for size will not shrink by the next tick:
    // leave it until the next full interval rather than re-uploading 3 MB
    // every hour to be told no again.
    if (now - readAt(LAST_CLOUD_TOO_LARGE_KEY) < intervalMs) return;
    // Any other failure (offline, 5xx): back off, don't retry every 10s.
    const lastAttempt = readAt(LAST_CLOUD_ATTEMPT_KEY);
    if (now - lastAttempt < CLOUD_BACKUP_RETRY_MS) {
      if (this.cloudBackupWaitLoggedFor !== lastAttempt) {
        this.cloudBackupWaitLoggedFor = lastAttempt;
        log.info('Scheduled cloud backup waiting after a failed attempt', {
          nextTryAfter: new Date(lastAttempt + CLOUD_BACKUP_RETRY_MS).toISOString(),
          lastError: this.lastCloudBackupError,
        });
      }
      return;
    }
    await this.uploadBackupNow({ reason: 'scheduled' }).catch(() => undefined); // error already recorded
  }

  /**
   * Create a fresh VACUUM'd snapshot, slim it, and upload it with a manifest:
   * as content-defined chunks, sending only those the website does not have
   * (cloud-copy-chunks.ts) — so a copy of any size fits, and a day's upload is
   * about a day's data. A website that predates chunks gets the old single
   * gzip upload (≤ 3 MB). The server checks every chunk's hash and records
   * the upload time from its own clock; nothing the POS sends can rewrite an
   * existing copy.
   */
  async uploadBackupNow(
    opts: { reason?: CloudCopyReason } = {},
  ): Promise<{ fileName: string; sizeBytes: number }> {
    if (!this.db) throw new Error('Bridge not initialized');
    const reason = opts.reason ?? 'manual';
    const cfg = getWebBridgeConfig(this.db);
    const ready = isWebBridgeReady(cfg);
    if (!ready.ok) throw new Error(`Configure first: ${ready.missing.join(', ')}`);
    if (this.cloudBackupRunning) throw new Error('A cloud backup is already running');
    this.cloudBackupRunning = true;
    // Recorded before the attempt so a crash mid-upload still counts as one.
    setSetting(this.db, LAST_CLOUD_ATTEMPT_KEY, nowIso());
    let tooLarge = false;
    try {
      const backup = createBackup({ kind: 'manual' });
      const trimmed = slimCloudCopy(backup.fullPath, getSyncConfig(this.db).mode);
      const raw = fs.readFileSync(backup.fullPath);
      // The row export the chunks are cut from (see cloud-copy-rows.ts).
      const snapshot = new Database(backup.fullPath, { readonly: true });
      let dump: Buffer;
      try {
        dump = await dumpDatabase(rowSource(snapshot));
      } finally {
        snapshot.close();
      }
      // The snapshot exists only to be uploaded; local retention is the daily
      // auto-backup. Manual files are never rotated, so leaving this one behind
      // put an extra copy of the whole database on the shop PC every day.
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          fs.unlinkSync(backup.fullPath + suffix);
        } catch {
          // best effort — a stray file is harmless, just untidy
        }
      }
      let sent: { id: string | null; sha256: string; gzBytes: number; meta: CloudCopyManifest };
      try {
        let meta: CloudCopyManifest | null = null;
        const up = await uploadChunkedCopy(this.bridgeApi(cfg), dump, {
          deviceId: this.deviceId,
          fileName: backup.fileName,
          meta: (s) => {
            meta = {
              ...this.manifest(reason, trimmed, raw.length, s.uploadedBytes, CHUNKS_FORMAT),
              chunkCount: s.chunkCount,
              newChunkCount: s.newChunkCount,
            };
            return { ...meta };
          },
        });
        sent = { id: up.id, sha256: up.sha256, gzBytes: up.uploadedBytes, meta: meta! };
      } catch (e) {
        if (!(e instanceof ChunksUnsupportedError)) throw e;
        const blob = await this.uploadBlob(cfg, raw, backup.fileName, reason, trimmed);
        if (!blob.ok) {
          tooLarge = blob.tooLarge;
          throw new Error(blob.message);
        }
        sent = blob;
      }
      const uploadedAt = nowIso();
      setSetting(this.db, LAST_CLOUD_BACKUP_KEY, uploadedAt);
      setSetting(this.db, LAST_CLOUD_META_KEY, {
        uploadedAt,
        id: sent.id,
        sha256: sent.sha256,
        reason,
        auditHeadHash: sent.meta.auditHeadHash,
        auditRows: sent.meta.auditRows,
      });
      this.lastCloudBackupError = null;
      log.info('Cloud backup uploaded', {
        fileName: backup.fileName,
        reason,
        format: sent.meta.format,
        rawBytes: raw.length,
        sentGzBytes: sent.gzBytes,
        chunks: sent.meta.chunkCount,
        newChunks: sent.meta.newChunkCount,
        removedSyncRows: trimmed.removedSync,
        removedAuditRows: trimmed.removedAudit,
        auditHeadHash: sent.meta.auditHeadHash,
      });
      return { fileName: backup.fileName, sizeBytes: sent.gzBytes };
    } catch (e) {
      this.lastCloudBackupError = e instanceof Error ? e.message : String(e);
      if (tooLarge) setSetting(this.db, LAST_CLOUD_TOO_LARGE_KEY, nowIso());
      log.warn('Cloud backup failed', { error: this.lastCloudBackupError, tooLarge });
      throw e;
    } finally {
      this.cloudBackupRunning = false;
    }
  }

  /** This bridge's connection, in the shape the chunk transfer expects. */
  private bridgeApi(conn: BridgeConnection): BridgeApi {
    return async (p, init) => {
      const res = await this.api(conn, p, init ? { method: init.method, body: init.body } : undefined);
      return { status: res.status, json: await res.json().catch(() => null) };
    };
  }

  /** The whole copy as one gzip request — for a website that predates chunks. */
  private async uploadBlob(
    cfg: WebBridgeConfig,
    raw: Buffer,
    fileName: string,
    reason: CloudCopyReason,
    trimmed: { removedSync: number; removedAudit: number },
  ): Promise<
    | { ok: true; id: string | null; sha256: string; gzBytes: number; meta: CloudCopyManifest }
    | { ok: false; tooLarge: boolean; message: string }
  > {
    const gz = gzipSync(raw, { level: 9 });
    if (gz.length > CLOUD_BACKUP_MAX_GZ_BYTES) {
      return {
        ok: false,
        tooLarge: true,
        message: `Backup exceeds the website's 3MB limit (${(gz.length / 1_000_000).toFixed(1)} MB gzipped) — the website needs updating; local backups are unaffected.`,
      };
    }
    const sha256 = createHash('sha256').update(gz).digest('hex');
    const meta = this.manifest(reason, trimmed, raw.length, gz.length, 'blob');
    const res = await this.api(cfg, '/api/bridge/backups', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: this.deviceId,
        fileName: `${fileName}.gz`,
        dataBase64: gz.toString('base64'),
        sha256,
        meta,
      }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; error?: string; message?: string; data?: { id: string } }
      | null;
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        tooLarge: json?.error === 'backup_too_large',
        message: json?.message ?? json?.error ?? `Upload failed: HTTP ${res.status}`,
      };
    }
    return { ok: true, id: json.data?.id ?? null, sha256, gzBytes: gz.length, meta };
  }

  private manifest(
    reason: CloudCopyReason,
    trimmed: { removedSync: number; removedAudit: number },
    rawBytes: number,
    gzBytes: number,
    format: CloudCopyManifest['format'],
  ): CloudCopyManifest {
    const db = this.db!;
    const device = db
      .prepare(`SELECT display_name FROM device_info WHERE id = 'singleton'`)
      .get() as { display_name: string | null } | undefined;
    const orders = db
      .prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM orders WHERE deleted_at IS NULL`)
      .get() as { n: number; last: string | null };
    const audit = db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number };
    const head = db
      .prepare(`SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
      .get() as { row_hash: string } | undefined;
    return {
      schema: 2,
      format,
      deviceId: this.deviceId,
      deviceName: device?.display_name ?? null,
      appVersion: app.getVersion(),
      reason,
      createdAtClient: nowIso(),
      orderCount: orders.n,
      lastOrderAt: orders.last,
      auditRows: audit.n,
      auditHeadHash: head?.row_hash ?? null,
      trimmed: {
        syncRowsDropped: trimmed.removedSync,
        auditRowsDropped: trimmed.removedAudit,
        auditDaysKept: CLOUD_COPY_AUDIT_DAYS,
      },
      rawBytes,
      gzBytes,
    };
  }

  /**
   * One-shot self-test for support: reports config, whether a staff user is
   * found, the raw pull result, and — per pending order — the local import
   * bookkeeping and whether the menu item still exists. Pinpoints exactly why
   * orders aren't importing without needing to read the database by hand.
   */
  async diagnose(): Promise<Record<string, unknown>> {
    if (!this.db) return { error: 'bridge not initialized' };
    const cfg = getWebBridgeConfig(this.db);
    const ready = isWebBridgeReady(cfg);
    const actor = this.resolveActor();
    const out: Record<string, unknown> = {
      enabled: cfg.enabled,
      ready: ready.ok,
      missing: ready.missing,
      siteUrl: cfg.siteUrl ?? null,
      hasSecret: !!cfg.bridgeSecret,
      secretUnreadable: cfg.secretUnreadable,
      deviceId: this.deviceId,
      staffUser: actor ? `ok (${actor.userId})` : 'NONE — no active admin/manager/cashier user found',
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastImportError: this.lastImportError,
      running: this.running,
    };
    try {
      const res = await this.api(cfg, '/api/bridge/orders');
      const text = await res.text();
      type PullBody = { ok?: boolean; data?: WebOrder[] };
      let parsed: PullBody | null = null;
      try {
        parsed = JSON.parse(text) as PullBody;
      } catch {
        /* keep raw */
      }
      out['pullHttpStatus'] = res.status;
      out['pullOrderCount'] = parsed?.data?.length ?? null;
      if (!parsed) out['pullRawBody'] = text.slice(0, 300);
      if (parsed?.data) {
        out['orders'] = parsed.data.map((o) => {
          const existing = this.db!
            .prepare(
              `SELECT pos_order_id, status, attempts, last_error FROM web_order_imports WHERE web_order_id = ?`,
            )
            .get(o.id);
          const firstItemId = o.items?.[0]?.posItemId;
          const item = firstItemId
            ? this.db!
                .prepare(`SELECT id, is_active, deleted_at FROM menu_items WHERE id = ?`)
                .get(firstItemId)
            : null;
          return {
            name: o.customerName,
            webId: o.id,
            firstItemId,
            itemFoundLocally: item ?? 'NOT FOUND in local menu_items',
            priorImport: existing ?? 'none (fresh)',
          };
        });
      }
    } catch (e) {
      out['pullError'] = e instanceof Error ? e.message : String(e);
    }
    return out;
  }

  /**
   * Every copy the website holds, from every till — so a reinstalled PC (new
   * device id) can find the copies its predecessor made. `conn` overrides the
   * saved connection for the onboarding wizard.
   */
  async listCloudBackups(conn?: BridgeConnection): Promise<CloudBackupEntry[]> {
    if (!this.db) throw new Error('Bridge not initialized');
    const c = conn ?? getWebBridgeConfig(this.db);
    const ready = isWebBridgeReady(c as WebBridgeConfig);
    if (!ready.ok) throw new Error(`Configure first: ${ready.missing.join(', ')}`);
    const res = await this.api(c, '/api/bridge/backups');
    if (res.status === 401) throw new Error('The website rejected the bridge secret');
    if (!res.ok) throw new Error(`List failed: HTTP ${res.status}`);
    const json = (await res.json()) as { ok: boolean; data?: ServerBackupRow[] };
    if (!json.ok || !json.data) throw new Error('List failed: bad response');
    return json.data.map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      fileName: r.fileName,
      sizeBytes: r.sizeBytes,
      createdAt: r.createdAt,
      deviceName: r.meta?.deviceName ?? null,
      isThisDevice: r.deviceId === this.deviceId,
      orderCount: r.meta?.orderCount ?? null,
      lastOrderAt: r.meta?.lastOrderAt ?? null,
      reason: r.meta?.reason ?? null,
      appVersion: r.meta?.appVersion ?? null,
      sha256: r.sha256 ?? null,
      auditHeadHash: r.meta?.auditHeadHash ?? null,
    }));
  }

  /**
   * Download a cloud copy, verify it against the checksum the server recorded
   * at upload, gunzip, and stage it as the pending restore (applied on next
   * launch — same flow as local restore). The renderer then calls
   * backup:applyAndRelaunch to confirm.
   */
  async restoreCloudBackup(
    id: string,
    opts: { conn?: BridgeConnection; byUserId: string | null; captureConnection?: boolean },
  ): Promise<{ staged: boolean }> {
    if (!this.db) throw new Error('Bridge not initialized');
    const c = opts.conn ?? getWebBridgeConfig(this.db);
    const ready = isWebBridgeReady(c as WebBridgeConfig);
    if (!ready.ok) throw new Error(`Configure first: ${ready.missing.join(', ')}`);
    const res = await this.api(c, `/api/bridge/backups/${encodeURIComponent(id)}`);
    if (res.status === 401) throw new Error('The website rejected the bridge secret');
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      ok: boolean;
      data?: {
        fileName: string;
        dataBase64: string | null;
        format?: string;
        chunks?: string[] | null;
        deviceId?: string;
        sha256?: string | null;
        meta?: Partial<CloudCopyManifest> | null;
      };
    };
    if (!json.ok || !json.data) throw new Error('Download failed: bad response');
    const fromPc = json.data.meta?.deviceName ?? (json.data.deviceId === this.deviceId ? 'this PC' : 'another PC');
    // Build a database file inside userData, then reuse the local staging flow
    // (which validates the SQLite header before accepting).
    const tmpPath = path.join(app.getPath('userData'), `cloud-restore-${Date.now()}.db`);
    try {
      if (json.data.format === CHUNKS_FORMAT) {
        // Every chunk is checked against its name and the whole against sha256…
        if (!json.data.chunks?.length || !json.data.sha256) throw new Error('Download failed: bad response');
        const dump = await downloadChunkedCopy(this.bridgeApi(c), { chunks: json.data.chunks, sha256: json.data.sha256 });
        const out = new Database(tmpPath);
        try {
          await rebuildDatabase(dump, rowSink(out));
          // …and the rebuilt database must export to exactly what was uploaded.
          if (!(await dumpDatabase(rowSource(out))).equals(dump)) {
            throw new Error('The rebuilt cloud copy does not match what was uploaded; refusing to restore it.');
          }
        } finally {
          out.close();
        }
      } else {
        if (!json.data.dataBase64) throw new Error('Download failed: bad response');
        const gz = Buffer.from(json.data.dataBase64, 'base64');
        if (json.data.sha256) {
          const digest = createHash('sha256').update(gz).digest('hex');
          if (digest !== json.data.sha256) {
            throw new Error(
              'The cloud copy does not match the checksum the server recorded when it was uploaded. It is damaged or was altered; refusing to restore it. Pick another copy.',
            );
          }
        }
        fs.writeFileSync(tmpPath, gunzipSync(gz));
      }
      return stageRestoreFromPath(tmpPath, {
        source: 'cloud',
        label: `cloud copy ${json.data.fileName} from ${fromPc}`,
        fromDeviceId: json.data.deviceId ?? null,
        byUserId: opts.byUserId,
        connection:
          opts.captureConnection && c.siteUrl && c.bridgeSecret
            ? { siteUrl: c.siteUrl, bridgeSecretSealed: sealSecret(c.bridgeSecret) }
            : null,
      });
    } finally {
      for (const suffix of ['', '-journal']) {
        try {
          fs.unlinkSync(tmpPath + suffix);
        } catch {
          // not created (download failed first) — nothing to tidy
        }
      }
    }
  }

  private async api(
    conn: BridgeConnection,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    // Hard timeout so a hung connection can never wedge the poll loop. Without
    // this, one stalled request left `this.running` true forever and the
    // bridge silently stopped pulling orders (while manual actions kept
    // working). 20s is generous for one ≤1 MB cloud-copy chunk on shop Wi-Fi.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const request: RequestInit = {
        ...init,
        signal: controller.signal,
        // Redirects are followed by hand below. Left to fetch, a cross-origin
        // redirect drops the Authorization header (per the Fetch spec), so a
        // site URL of https://cheeseoclock.net — which 308s to www. — reached
        // the API with no bearer and every call 401'd: no orders, no cloud
        // backups, and only "Pull failed: HTTP 401" in Settings to show for it.
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${conn.bridgeSecret}`,
          ...(init?.headers ?? {}),
        },
      };
      const cached = this.canonicalOrigin;
      const origin = cached && cached.for === conn.siteUrl ? cached.origin : conn.siteUrl;
      const res = await fetch(`${origin}${path}`, request);
      if (res.status < 300 || res.status >= 400) return res;
      // Only honour a redirect that is plain host canonicalisation (apex → www,
      // http → https). Anything that changes the path is not our API.
      const location = res.headers.get('location');
      if (!location) return res;
      const target = new URL(location, `${origin}${path}`);
      const requested = new URL(`${origin}${path}`);
      if (target.protocol !== 'https:' || target.pathname !== requested.pathname) return res;
      this.canonicalOrigin = { for: conn.siteUrl, origin: target.origin };
      return await fetch(`${target.origin}${path}`, request);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve the actor for bridge-created records. Web orders need a
   * cashier_id (FK to users) — we use the first active admin as the
   * system actor. Cached after first lookup.
   */
  private resolveActor(): { userId: string; deviceId: string } | null {
    if (!this.db) return null;
    if (!this.systemUserId) {
      const row = this.db
        .prepare(
          `SELECT id FROM users
            WHERE is_active = 1 AND deleted_at IS NULL
            ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END
            LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      this.systemUserId = row?.id ?? null;
    }
    if (!this.systemUserId) return null;
    return { userId: this.systemUserId, deviceId: this.deviceId };
  }

  // ---- inbound ------------------------------------------------------------

  private async pullNewOrders(cfg: WebBridgeConfig): Promise<void> {
    if (!this.db) return;
    const res = await this.api(cfg, '/api/bridge/orders');
    if (!res.ok) throw new Error(`Pull failed: HTTP ${res.status}`);
    const json = (await res.json()) as { ok: boolean; data?: WebOrder[] };
    if (!json.ok || !json.data) throw new Error('Pull failed: bad response');

    for (const order of json.data) {
      await this.importOne(cfg, order);
    }
  }

  private async importOne(cfg: WebBridgeConfig, web: WebOrder): Promise<void> {
    const db = this.db!;
    const now = nowIso();

    // Idempotency: skip anything we've already imported (or permanently failed).
    const existing = db
      .prepare(`SELECT pos_order_id, status, attempts FROM web_order_imports WHERE web_order_id = ?`)
      .get(web.id) as
      | { pos_order_id: string | null; status: string; attempts: number }
      | undefined;
    if (existing?.pos_order_id) {
      // Imported before but the ack may have failed — re-ack and move on.
      const local = findOrder(db, existing.pos_order_id);
      if (local) {
        await this.api(cfg, `/api/bridge/orders/${web.id}/ack`, {
          method: 'POST',
          body: JSON.stringify({
            posOrderId: local.id,
            posOrderNumber: local.orderNumber,
          }),
        }).catch(() => undefined);
      }
      return;
    }
    if (existing && existing.status === 'failed') return;
    if (isStaleWebOrder(web.createdAt, MAX_IMPORT_AGE_MS)) {
      // Placed too long ago to cook now (the till was down when it arrived).
      // Record it as failed so it is never retried, and tell the site so the
      // customer's tracker shows "couldn't confirm — please call".
      db.prepare(
        `INSERT INTO web_order_imports (web_order_id, status, attempts, last_error, created_at, updated_at)
         VALUES (?, 'failed', 0, 'stale', ?, ?)
         ON CONFLICT(web_order_id) DO UPDATE SET
           status = 'failed', last_error = 'stale', updated_at = excluded.updated_at`,
      ).run(web.id, now, now);
      await this.api(cfg, `/api/bridge/orders/${web.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      }).catch(() => undefined);
      log.info('Web order too old to cook — cancelled instead of imported', {
        webOrderId: web.id,
        createdAt: web.createdAt,
        maxAgeMs: MAX_IMPORT_AGE_MS,
      });
      return;
    }
    if (existing && existing.attempts >= MAX_IMPORT_ATTEMPTS) {
      db.prepare(
        `UPDATE web_order_imports SET status = 'failed', updated_at = ? WHERE web_order_id = ?`,
      ).run(now, web.id);
      // Tell the site so the customer isn't watching a dead tracker.
      await this.api(cfg, `/api/bridge/orders/${web.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      }).catch(() => undefined);
      notifyRenderer('web-order:import-failed', {
        webOrderId: web.id,
        customerName: web.customerName,
        message: `gave up after ${MAX_IMPORT_ATTEMPTS} attempts`,
      });
      return;
    }

    const actor = this.resolveActor();
    if (!actor) {
      log.warn('Web bridge: no active admin/manager user to attribute orders to');
      return;
    }

    // Record the attempt BEFORE importing so a crash mid-import is visible.
    db.prepare(
      `INSERT INTO web_order_imports (web_order_id, attempts, created_at, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(web_order_id) DO UPDATE SET
         attempts = web_order_imports.attempts + 1, updated_at = excluded.updated_at`,
    ).run(web.id, now, now);

    try {
      // Steps 1–4 are one transaction: an import that fails halfway (an item
      // gone from the menu, say) must leave nothing behind. It used to leave
      // an 'open' shell — and another on every retry — that sat on the Live
      // Orders board as a half-imported order.
      // A pickup is collected from the counter at PICKUP_DISCOUNT_PERCENT off:
      // a takeaway order with the discount on it, no address. Orders from a
      // site that predates pickup carry no fulfilment and are deliveries.
      const pickup = web.fulfilment === 'pickup';
      const order = db.transaction(() => {
        // 1. Local order shell (delivery or takeaway, source web).
        const tag = pickup ? '[web pick-up]' : '[web]';
        const shell = createOrder(
          db,
          {
            mode: pickup ? 'takeaway' : 'delivery',
            source: 'web',
            notes: web.notes ? `${tag} ${web.notes}` : pickup ? '[web pick-up order]' : '[web order]',
          },
          actor,
        );

        // 2. Customer (+ address for a delivery; both dedupe internally).
        const customer = createCustomer(
          db,
          { name: web.customerName, phone: web.customerPhone },
          actor,
        );
        if (pickup) {
          snapshotCustomerOntoOrder(
            db,
            { orderId: shell.id, customerId: customer.id, addressId: null },
            actor,
          );
        } else {
          const address = createAddress(
            db,
            {
              customerId: customer.id,
              label: 'Web order',
              addressLine: web.addressLine,
              area: web.area ?? null,
            },
            actor,
          );
          snapshotCustomerOntoOrder(
            db,
            { orderId: shell.id, customerId: customer.id, addressId: address.id },
            actor,
          );
        }

        // 3. Items. POS re-prices from its own menu (authoritative). If an item
        //    vanished from the menu since publish, the whole import throws and
        //    retries — after MAX_IMPORT_ATTEMPTS it's cancelled with a notice.
        for (const line of web.items) {
          addOrderItem(
            db,
            {
              orderId: shell.id,
              menuItemId: line.posItemId,
              quantity: line.quantity,
              modifierIds: line.modifiers.map((m) => m.posModifierId),
              notes: line.notes,
            },
            actor,
          );
        }

        // The pickup offer, priced by the till itself on its own subtotal
        // (the site showed the same maths — apps/web lib/pricing). It is the
        // owner's standing offer, above the percent that needs a manager PIN
        // at the counter, so the bridge's actor (the shop's admin — see
        // resolveActor) is recorded as its approver.
        if (pickup) {
          applyDiscount(
            db,
            {
              orderId: shell.id,
              discountType: 'percent',
              value: PICKUP_DISCOUNT_PERCENT,
              reason: `Website pick-up ${PICKUP_DISCOUNT_PERCENT}% off`,
              approverUserId: actor.userId,
            },
            actor,
          );
        }

        // 4. Onto the Live Orders board (also validates customer/address).
        sendOrderToKitchen(db, shell.id, actor);

        db.prepare(
          `UPDATE web_order_imports
              SET pos_order_id = ?, status = 'imported', imported_at = ?,
                  last_pushed_status = 'accepted', updated_at = ?
            WHERE web_order_id = ?`,
        ).run(shell.id, now, now, web.id);
        return shell;
      })();

      // 5. Kitchen ticket (per Settings → Printer) so the team sees paper for
      //    web orders too; the bill prints when the rider is assigned.
      printSpooler.onOrderEvent(order.id, 'sent_to_kitchen');
      this.importedTotal += 1;

      // The order is saved and on the board: say so before talking to the site.
      log.info('Web order imported', {
        webOrderId: web.id,
        posOrder: order.orderNumber,
        totalCents: getOrderSnapshot(db, order.id)?.order.totalCents,
      });
      notifyRenderer('web-order:received', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: web.customerName,
      });
      this.lastImportError = null;

      // 6. Ack to the site (flips 'new' → 'accepted'). Its own try: a timeout
      //    here (shop Wi-Fi) used to land in the import catch below, and staff
      //    got "Website order not imported — call the customer" for an order
      //    already on the board — and re-keyed it, so it was cooked twice
      //    (audit 2026-09-25). The next poll re-acks it (step 0 above).
      try {
        await this.api(cfg, `/api/bridge/orders/${web.id}/ack`, {
          method: 'POST',
          body: JSON.stringify({
            posOrderId: order.id,
            posOrderNumber: order.orderNumber,
          }),
        });
      } catch (e) {
        log.warn('Web order ack failed (imported; will re-ack next poll)', {
          webOrderId: web.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      db.prepare(
        `UPDATE web_order_imports SET last_error = ?, updated_at = ? WHERE web_order_id = ?`,
      ).run(message, nowIso(), web.id);
      // Surface the reason so Settings → Website shows it and the operator
      // isn't left guessing why an order didn't arrive.
      this.lastImportError = `${web.customerName}: ${message}`;
      log.warn('Web order import failed (will retry)', { webOrderId: web.id, message });
      notifyRenderer('web-order:import-failed', {
        webOrderId: web.id,
        customerName: web.customerName,
        message,
      });
    }
  }

  // ---- outbound -----------------------------------------------------------

  private async pushStatusUpdates(cfg: WebBridgeConfig): Promise<void> {
    const db = this.db!;
    const rows = db
      .prepare(
        `SELECT wi.web_order_id, wi.last_pushed_status, o.status AS pos_status
           FROM web_order_imports wi
           JOIN orders o ON o.id = wi.pos_order_id
          WHERE wi.status = 'imported'
            -- Stop tracking once the customer-facing journey is over.
            AND IFNULL(wi.last_pushed_status, '') NOT IN ('delivered', 'cancelled')`,
      )
      .all() as Array<{
      web_order_id: string;
      last_pushed_status: string | null;
      pos_status: OrderStatus;
    }>;

    for (const row of rows) {
      const webStatus = mapPosStatusToWeb(row.pos_status);
      if (!webStatus || webStatus === row.last_pushed_status) continue;
      const res = await this.api(cfg, `/api/bridge/orders/${row.web_order_id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: webStatus }),
      });
      if (res.ok) {
        db.prepare(
          `UPDATE web_order_imports SET last_pushed_status = ?, updated_at = ? WHERE web_order_id = ?`,
        ).run(webStatus, nowIso(), row.web_order_id);
      }
    }
  }

  // ---- store status heartbeat ---------------------------------------------

  /**
   * Tell the website whether this till is accepting online orders. Sent on
   * every tick and immediately whenever the setting changes, because the
   * website refuses checkout unless a recent heartbeat says yes: an order
   * placed while nobody is polling would be paid for on delivery and never
   * cooked. Going quiet (laptop shut, no internet) closes the site by itself
   * once the last beat goes stale.
   */
  private async pushStoreStatus(cfg: WebBridgeConfig): Promise<void> {
    // `features` tells the site what this till can import: it offers online
    // pick-up (10% off) only while the listening till says 'pickup'.
    const beat: BridgeHeartbeatBody = {
      acceptingOrders: cfg.enabled,
      deviceId: this.deviceId,
      features: ['pickup'],
      // The site shows this percent, so the customer sees what the till bills.
      pickupDiscountPercent: PICKUP_DISCOUNT_PERCENT,
    };
    const res = await this.api(cfg, '/api/bridge/status', {
      method: 'PUT',
      body: JSON.stringify(beat),
    });
    if (!res.ok) {
      // A website deployed before this feature has no such route. Nothing to
      // do about it here — the gate lives on the site, so a site without the
      // route simply has no gate and keeps behaving as it did.
      log.warn('Store status heartbeat rejected', { status: res.status });
    }
  }

  // ---- menu publish -------------------------------------------------------

  async publishMenu(): Promise<{ categories: number; items: number }> {
    if (!this.db) throw new Error('Bridge not initialized');
    const cfg = getWebBridgeConfig(this.db);
    const ready = isWebBridgeReady(cfg);
    if (!ready.ok) throw new Error(`Configure first: ${ready.missing.join(', ')}`);

    const menu = buildPublishedMenu(this.db);
    const res = await this.api(cfg, '/api/bridge/menu', {
      method: 'PUT',
      body: JSON.stringify(menu),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Publish failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const itemCount = menu.categories.reduce((s, c) => s + c.items.length, 0);
    log.info('Menu published to website', {
      categories: menu.categories.length,
      items: itemCount,
    });
    return { categories: menu.categories.length, items: itemCount };
  }
}

// ---------------------------------------------------------------------------

/**
 * Trim the throwaway snapshot before it goes to the cloud. The cloud copy is
 * disaster recovery, not the ledger: it has to stay under the website's 3 MB
 * upload cap, and the two tables that grow fastest carry nothing a restore
 * needs. sync_queue rows are inert while multi-device sync is off (and already
 * delivered once synced_at is set); audit_log older than CLOUD_COPY_AUDIT_DAYS
 * is history that the local snapshots and USB exports keep in full. Measured
 * on a real database these two tables were ~85% of every order's footprint,
 * which moved the cap from ~2,700 orders to well past 15,000.
 *
 * Trimming cuts the audit hash chain, so the copy records the hash at the cut
 * (settings "audit.chainAnchor") for the verifier to start from — and for new
 * rows to link to if this copy is ever restored.
 *
 * Runs on the copy only. The live database is never touched.
 */
function slimCloudCopy(
  copyPath: string,
  syncMode: 'off' | 'mock' | 'http',
): { removedSync: number; removedAudit: number } {
  const copy = new Database(copyPath);
  try {
    // Rollback journal, so closing leaves no -wal/-shm siblings behind.
    copy.pragma('journal_mode = DELETE');
    const cutoff = new Date(
      Date.now() - CLOUD_COPY_AUDIT_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const removedSync =
      syncMode === 'off'
        ? copy.prepare(`DELETE FROM sync_queue`).run().changes
        : copy.prepare(`DELETE FROM sync_queue WHERE synced_at IS NOT NULL`).run().changes;
    const removedAudit = copy
      .prepare(`DELETE FROM audit_log WHERE created_at < ?`)
      .run(cutoff).changes;
    if (removedAudit > 0) {
      const first = copy
        .prepare(`SELECT prev_hash FROM audit_log ORDER BY rowid LIMIT 1`)
        .get() as { prev_hash: string | null } | undefined;
      copy
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at) VALUES ('audit.chainAnchor', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(
          JSON.stringify({
            prevHash: first?.prev_hash ?? null,
            trimmedAt: nowIso(),
            auditRowsDropped: removedAudit,
            note: `cloud copy keeps the last ${CLOUD_COPY_AUDIT_DAYS} days of audit history`,
          }),
          nowIso(),
        );
    }
    copy.exec('VACUUM');
    return { removedSync, removedAudit };
  } finally {
    copy.close();
  }
}

function mapPosStatusToWeb(pos: OrderStatus): Exclude<WebOrderStatus, 'new'> | null {
  switch (pos) {
    case 'open':
    case 'sent_to_kitchen':
      return 'accepted';
    case 'preparing':
      return 'preparing';
    case 'ready':
      return 'ready';
    case 'out_for_delivery':
      return 'out_for_delivery';
    case 'delivered':
    case 'served':
    case 'paid':
      return 'delivered';
    case 'void':
    case 'refunded':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * Serialize the active menu for the website. Read-only — direct SELECTs are
 * fine here (the repositories rule covers writes).
 *
 * Images: data-URLs over ~300KB are dropped (null) so a handful of photos
 * can't blow past Vercel's request-body limit.
 */
function buildPublishedMenu(db: AppDatabase): PublishedMenu {
  const MAX_IMAGE_CHARS = 300_000;
  const branding = getReceiptBranding(db);

  const categories = db
    .prepare(
      `SELECT id, name, display_order FROM categories
        WHERE deleted_at IS NULL AND is_active = 1
        ORDER BY display_order`,
    )
    .all() as Array<{ id: string; name: string; display_order: number }>;

  const items = db
    .prepare(
      `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.base_price_cents,
              mi.image_url, mi.sort_order, IFNULL(tc.rate_bps, 0) AS rate_bps
         FROM menu_items mi
         LEFT JOIN tax_categories tc ON tc.id = mi.tax_category_id AND tc.deleted_at IS NULL
        WHERE mi.deleted_at IS NULL AND mi.is_active = 1
        ORDER BY mi.sort_order`,
    )
    .all() as Array<{
    id: string;
    category_id: string;
    name: string;
    description: string | null;
    base_price_cents: number;
    image_url: string | null;
    sort_order: number;
    rate_bps: number;
  }>;

  const itemGroups = db
    .prepare(
      `SELECT mig.menu_item_id, mig.sort_order AS group_sort,
              mg.id AS group_id, mg.name AS group_name, mg.selection_type,
              mg.min_select, mg.max_select, mg.is_required
         FROM menu_item_modifier_groups mig
         JOIN modifier_groups mg ON mg.id = mig.modifier_group_id AND mg.deleted_at IS NULL
        WHERE mig.deleted_at IS NULL
        ORDER BY mig.sort_order`,
    )
    .all() as Array<{
    menu_item_id: string;
    group_sort: number;
    group_id: string;
    group_name: string;
    selection_type: 'single' | 'multi';
    min_select: number;
    max_select: number;
    is_required: number;
  }>;

  const modifiers = db
    .prepare(
      `SELECT id, modifier_group_id, name, price_delta_cents, is_default, sort_order
         FROM modifiers WHERE deleted_at IS NULL ORDER BY sort_order`,
    )
    .all() as Array<{
    id: string;
    modifier_group_id: string;
    name: string;
    price_delta_cents: number;
    is_default: number;
    sort_order: number;
  }>;

  const modsByGroup = new Map<string, typeof modifiers>();
  for (const m of modifiers) {
    const arr = modsByGroup.get(m.modifier_group_id) ?? [];
    arr.push(m);
    modsByGroup.set(m.modifier_group_id, arr);
  }
  const groupsByItem = new Map<string, typeof itemGroups>();
  for (const g of itemGroups) {
    const arr = groupsByItem.get(g.menu_item_id) ?? [];
    arr.push(g);
    groupsByItem.set(g.menu_item_id, arr);
  }

  const publishedCategories: PublishedMenuCategory[] = categories
    .map((c) => ({
      posCategoryId: c.id,
      name: c.name,
      displayOrder: c.display_order,
      items: items
        .filter((i) => i.category_id === c.id)
        .map((i) => ({
          posItemId: i.id,
          name: i.name,
          description: i.description,
          basePriceCents: i.base_price_cents,
          taxRateBps: i.rate_bps,
          imageUrl:
            i.image_url && i.image_url.length <= MAX_IMAGE_CHARS ? i.image_url : null,
          sortOrder: i.sort_order,
          modifierGroups: (groupsByItem.get(i.id) ?? []).map((g) => ({
            posGroupId: g.group_id,
            name: g.group_name,
            selectionType: g.selection_type,
            minSelect: g.min_select,
            maxSelect: g.max_select,
            isRequired: g.is_required === 1,
            sortOrder: g.group_sort,
            modifiers: (modsByGroup.get(g.group_id) ?? []).map((m) => ({
              posModifierId: m.id,
              name: m.name,
              priceDeltaCents: m.price_delta_cents,
              isDefault: m.is_default === 1,
              sortOrder: m.sort_order,
            })),
          })),
        })),
    }))
    .filter((c) => c.items.length > 0);

  return {
    categories: publishedCategories,
    publishedAt: nowIso(),
    store: {
      name: branding.storeName,
      phone: branding.phoneLine ?? null,
      whatsapp: null,
      addressLine: branding.branchLine ?? null,
      tagline: branding.storeTagline ?? null,
    },
  };
}

function notifyRenderer(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload);
  }
}

export const webOrdersBridge = new WebOrdersBridge();
void WEB_ACTOR_NAME; // reserved: future dedicated system-user row

/** better-sqlite3 as the row export's read side: INTEGERs as bigint, rows as arrays. */
function rowSource(db: Database.Database): RowSource {
  return {
    all: (sql) => db.prepare(sql).all() as Array<Record<string, unknown>>,
    rows: (sql) => db.prepare(sql).raw(true).safeIntegers(true).iterate() as Iterable<unknown[]>,
    pragma: (name) => Number(db.pragma(name, { simple: true })),
  };
}

/** better-sqlite3 as the row export's write side. */
function rowSink(db: Database.Database): RowSink {
  return {
    exec: (sql) => void db.exec(sql),
    insert: (sql) => {
      const stmt = db.prepare(sql);
      return (values) => void stmt.run(...values);
    },
  };
}
