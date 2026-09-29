/**
 * Menu files from the costing PC (v0.7.32; shared-types menu-deploy.ts —
 * the owner, 29 Sep 2026: "this import file is irritating me it should be
 * automatic deploy for any machinse").
 *
 *   costing PC ──upload key──▶ website ──BRIDGE_SECRET──▶ this service (every till with the link)
 *
 * Every few minutes the till asks the website what the newest file is
 * (GET /api/bridge/menu-deploy) and follows THE RULE (pos-domain
 * menu-deploy.ts decideMenuDeployStep). When it is this till's turn it
 * CLAIMS the file (the website hands it to ONE till, with a lease) and puts
 * it in exactly as Menu → Import does — plan, then applyMenuImport in one
 * transaction with the owner's import rules (menu.importPolicy: the till's
 * prices kept…), NEVER a fresh start, a backup copy first — and says what
 * became of it. The other till gets the rows, and the marker of the file
 * ('menu.lastPackage', written in the import's own transaction), through
 * the link, so nothing is doubled.
 *
 * Never a tight loop: a failed try waits 1, 2, 4, then 8 minutes (the
 * website's back-off, and this till's own), and after 5 it stops for the
 * owner's "Try again". A file the till's full check refuses is never tried
 * again. An expired claim of another till is never taken over by itself.
 *
 * Every dependency is handed in (the web bridge owns it: web-orders-bridge.ts),
 * so the tests need no network. The file's content, its costs and the upload
 * key are never logged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import log from 'electron-log/main';
import { z } from 'zod';
import {
  MAX_MENU_FILE_VERSION,
  isMenuDeployKey,
  menuDeployClaimRefusalSchema,
  menuDeployClaimResponseSchema,
  menuDeployContentResponseSchema,
  menuDeployKeyResponseSchema,
  menuDeployReportResponseSchema,
  menuDeployStatusResponseSchema,
  type MenuDeployClaimInput,
  type MenuDeployClaimResponse,
  type MenuDeployReportInput,
  type MenuDeployStatusResponse,
  type MenuImportFile,
  type MenuLastPackage,
  type MenuPackageMeta,
} from '@cheeseoclock/shared-schemas';
import {
  MENU_DEPLOY_KEY_PREFIX,
  MENU_DEPLOY_MAX_ATTEMPTS,
  MENU_FILE_MAX_BYTES,
  MENU_DEPLOY_PROBLEM_PHASES,
  type MenuClaimRefusal,
  type MenuDeployChangedEvent,
  type MenuDeployCountsView,
  type MenuDeployKeyMade,
  type MenuDeployNotice,
  type MenuDeployOutcome,
  type MenuDeployPhase,
  type MenuDeployScope,
  type MenuDeployView,
  type MenuImportPreview,
  type MenuImportSummary,
} from '@cheeseoclock/shared-types';
import {
  MENU_DEPLOY_QUIET_MS,
  decideMenuDeployStep,
  describeMenuDeployEvent,
  menuClaimRefusalStep,
  menuDeployBackoffMs,
  menuDeployLocalFor,
  menuDeployNoticeFor,
  menuDeployPhaseMessage,
  menuDeployReportKey,
  type MenuDeployMessageContext,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import type { Actor } from '../db/repositories/base.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { getBusinessSetting, readShopSetting } from '../db/business-settings-read.js';
import { applyMenuImport, planMenuImportFromDb } from '../db/repositories/menu-import-repo.js';
import { MenuImportFileError, menuFileTooNewMessage, parseMenuFileText } from './menu-import-service.js';
import { readSyncSwitch } from './sync-config.js';
import { readTillLink } from './till-link.js';
import { onMenuDeployNudge } from './menu-deploy-events.js';

/** The website link is not set up on this till (callWebsite throws it). */
export class WebsiteNotReadyError extends Error {
  constructor() {
    super('This till has no website link (Settings → Online orders).');
    this.name = 'WebsiteNotReadyError';
  }
}

/** A refusal in plain words for the person who tapped (menuDeploy handlers show it as it is). */
export class MenuDeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MenuDeployError';
  }
}

export interface MenuPackageServiceDeps {
  db: AppDatabase;
  deviceId: string;
  deviceName: string | null;
  appVersion: string;
  /** The web bridge's authenticated call (BRIDGE_SECRET); throws WebsiteNotReadyError without a link. */
  callWebsite: (path: string, init?: RequestInit) => Promise<Response>;
  /** The website link is set up (address and secret). */
  linked: () => boolean;
  /** "Accept online orders" is on — the website's database is awake anyway: look every few minutes. */
  ordersOn: () => boolean;
  /** The same publish as after Menu → Import (the website sells from the menu the till last sent). */
  publishMenu: () => Promise<unknown>;
  /** A local backup copy, before anything changes. */
  backup: (kind: 'before-menu') => Promise<unknown>;
  now?: () => number;
  emit?: (e: MenuDeployChangedEvent) => void;
  /** 0..1, for the ±20% spread of the checks (tests pin it). */
  random?: () => number;
}

// ---------------------------------------------------------------------------
// When to look
// ---------------------------------------------------------------------------

export const FIRST_CHECK_MS = 30_000;
/** "Accept online orders" on: the website's database is awake anyway. */
export const CHECK_EVERY_MS = 3 * 60_000;
/** Off: every 20 minutes, so the website's database can sleep between. */
export const CHECK_QUIETLY_EVERY_MS = 20 * 60_000;
/** A failed look doubles the gap, up to this. */
export const CHECK_BACKOFF_MAX_MS = 30 * 60_000;
/** A website older than this feature: look again in an hour. */
export const WEBSITE_OLD_RECHECK_MS = 60 * 60_000;
/** A setting arrived from the other till, or the owner saved "put in by themselves / wait for my OK". */
const NUDGE_MS = 5_000;
/** Keep this much of the lease for reporting back after the import. */
const LEASE_MARGIN_MS = 120_000;
/** Once-said lines kept (the newest). */
const KEEP_SAID = 100;

// ---------------------------------------------------------------------------
// This till's own bookkeeping (pure-local settings; never synced)
// ---------------------------------------------------------------------------

/** 'menuDeploy.local': the newest file's tries on this till, and what was said about which file. */
export const MENU_DEPLOY_LOCAL_KEY = 'menuDeploy.local';
/** 'menuDeploy.keyInfo': the last 4 characters of the upload key this till made, and when — never the key. */
export const MENU_DEPLOY_KEY_INFO_KEY = 'menuDeploy.keyInfo';

const localSchema = z.object({
  v: z.number().int().min(1),
  packageId: z.string().nullable(),
  attempts: z.number().int().min(0),
  nextTryAt: z.string().nullable(),
  error: z.string().nullable(),
  refused: z.boolean().default(false),
  reported: z.array(z.string()).default([]),
  notified: z.array(z.string()).default([]),
});
export type MenuDeployLocal = z.infer<typeof localSchema>;

const EMPTY_LOCAL: MenuDeployLocal = Object.freeze({
  v: 1,
  packageId: null,
  attempts: 0,
  nextTryAt: null,
  error: null,
  refused: false,
  reported: [],
  notified: [],
}) as MenuDeployLocal;

const keyInfoSchema = z.object({ keyHint: z.string(), keyCreatedAt: z.string() });

export function readMenuDeployLocal(db: AppDatabase): MenuDeployLocal {
  const parsed = localSchema.safeParse(getSettingRaw(db, MENU_DEPLOY_LOCAL_KEY));
  return parsed.success ? parsed.data : { ...EMPTY_LOCAL, reported: [], notified: [] };
}

function writeMenuDeployLocal(db: AppDatabase, local: MenuDeployLocal): void {
  setSetting(db, MENU_DEPLOY_LOCAL_KEY, {
    ...local,
    reported: local.reported.slice(-KEEP_SAID),
    notified: local.notified.slice(-KEEP_SAID),
  });
}

/** The synced marker of the last file put in on either till, or null. */
export function readMenuMarker(db: AppDatabase): MenuLastPackage | null {
  try {
    return getBusinessSetting(db, 'menu.lastPackage')?.value ?? null;
  } catch {
    return null;
  }
}

const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const COUNT_FIELDS = [
  'newItems',
  'updatedItems',
  'priceChanges',
  'newIngredients',
  'updatedIngredients',
  'newCategories',
  'recipesSet',
  'choiceGroupsChanged',
  'batchRecipesSet',
  'skipped',
] as const satisfies ReadonlyArray<keyof MenuDeployCountsView>;

/** What an import changed, numbers only (what the website and the marker keep). */
export function countsOf(s: MenuImportSummary): MenuDeployCountsView {
  const out = {} as MenuDeployCountsView;
  for (const f of COUNT_FIELDS) out[f] = s[f];
  return out;
}

const cut = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ClaimResult =
  | { kind: 'claimed'; claim: MenuDeployClaimResponse }
  | { kind: 'refused'; code: MenuClaimRefusal | string }
  | { kind: 'unreachable'; message: string };

type ImportResult = { ok: true; summary: MenuImportSummary } | { ok: false; message: string };

/** What the person who tapped hears when the website says no to their claim. */
function claimRefusalWords(code: string, pkg: Pick<MenuPackageMeta, 'formatVersion'> | null): string {
  switch (code) {
    case 'behind':
      return 'The other till’s last menu changes have not arrived here yet. Try again once the link has caught up.';
    case 'claimed':
    case 'busy':
      return 'The other till is putting a menu file in right now.';
    case 'already_applied':
      return 'The other till has already put this file in; its changes come through the link.';
    case 'stalled':
      return 'The other till started putting this file in and stopped. Only the owner can take it over.';
    case 'too_old':
      return menuFileTooNewMessage(pkg?.formatVersion ?? MAX_MENU_FILE_VERSION + 1);
    case 'refused':
      return 'This file was refused. Fix it on the costing PC and send it again.';
    case 'failed':
      return `It failed ${MENU_DEPLOY_MAX_ATTEMPTS} times — tap Try again.`;
    case 'superseded':
      return 'A newer menu file arrived — look at that one first (Menu → Import).';
    case 'retry_later':
      return 'It failed a moment ago; try again in a minute.';
    case 'gone':
      return 'The website no longer keeps this file. Send it again from the costing PC.';
    default:
      return 'The website did not hand the file over. Try again in a minute.';
  }
}

/**
 * One per till (web-orders-bridge.ts makes it, and the menuDeploy handlers
 * reach it through menuPackageService()).
 */
export class MenuPackageService {
  private readonly d: MenuPackageServiceDeps;
  private readonly now: () => number;
  private status: MenuDeployStatusResponse | null = null;
  private phase: MenuDeployPhase = 'idle';
  /** waiting_link because the other till's last menu changes have not arrived (a 'behind' claim). */
  private behind = false;
  private lastCheckedAt: number | null = null;
  private nextCheckAt: number | null = null;
  private lastError: string | null = null;
  private failures = 0;
  private websiteOld = false;
  private recheckMs: number | null = null;
  private running: Promise<unknown> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopNudge: (() => void) | null = null;

  constructor(deps: MenuPackageServiceDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Look after 30 s, then every few minutes; a nudge looks a moment later. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopNudge = onMenuDeployNudge(() => {
      if (this.started) this.schedule(NUDGE_MS);
    });
    this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    this.stopNudge?.();
    this.stopNudge = null;
  }

  isStarted(): boolean {
    return this.started;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextCheckAt = this.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextCheckAt = null;
      void this.checkNow()
        .catch((e: unknown) => log.warn('Menu file check failed', { error: messageOf(e) }))
        // A look that joined something already running (the owner's tap) schedules no next one itself.
        .finally(() => {
          if (this.started && !this.timer) this.schedule(this.gapMs());
        });
    }, ms);
    this.timer.unref?.();
  }

  /** The gap to the next look (after one ended). */
  private gapMs(): number {
    if (this.recheckMs !== null) {
      const ms = this.recheckMs;
      this.recheckMs = null;
      return ms;
    }
    if (this.websiteOld) return WEBSITE_OLD_RECHECK_MS;
    const base = this.d.ordersOn() ? CHECK_EVERY_MS : CHECK_QUIETLY_EVERY_MS;
    if (this.failures > 0) return Math.min(base * 2 ** this.failures, CHECK_BACKOFF_MAX_MS);
    const spread = 0.8 + 0.4 * (this.d.random ?? Math.random)();
    return Math.round(base * spread);
  }

  // ---- reading -------------------------------------------------------------

  /** Where this till stands. `history`: the website's last lines (menuDeploy:getStatus withHistory). */
  view(history?: MenuDeployStatusResponse['events']): MenuDeployView {
    const db = this.d.db;
    const s = this.status;
    const pkg = s?.latest ?? null;
    const local = pkg ? menuDeployLocalFor(readMenuDeployLocal(db), pkg.id) : readMenuDeployLocal(db);
    const marker = readMenuMarker(db);
    const keyInfo = keyInfoSchema.safeParse(getSettingRaw(db, MENU_DEPLOY_KEY_INFO_KEY));
    const linked = this.d.linked();
    const phase: MenuDeployPhase = linked ? this.phase : 'not_linked';
    const view: MenuDeployView = {
      websiteLinked: linked,
      phase,
      message: menuDeployPhaseMessage(phase, this.messageContext(pkg, local)),
      scope: this.scope(),
      mode: this.mode(),
      key: s?.key
        ? { keyHint: s.key.keyHint, createdAt: s.key.createdAt, deviceName: s.key.deviceName, madeOnThisTill: s.key.deviceId === this.d.deviceId }
        : keyInfo.success && !s
          ? { keyHint: keyInfo.data.keyHint, createdAt: keyInfo.data.keyCreatedAt, deviceName: this.d.deviceName, madeOnThisTill: true }
          : null,
      package: pkg
        ? {
            id: pkg.id,
            seq: pkg.seq,
            fileName: pkg.fileName,
            source: pkg.source,
            generatedAt: pkg.generatedAt,
            uploadedAt: pkg.uploadedAt,
            itemCount: pkg.itemCount,
            ingredientCount: pkg.ingredientCount,
            formatVersion: pkg.formatVersion,
            state: pkg.state,
          }
        : null,
      appliedHere: marker
        ? {
            fileName: marker.fileName,
            seq: marker.seq,
            at: marker.appliedAt,
            automatic: marker.automatic,
            byThisTill: marker.appliedByDevice === this.d.deviceId,
            counts: marker.counts,
          }
        : null,
      canApplyNow: linked && !!pkg && (phase === 'waiting_for_owner' || phase === 'gave_up' || phase === 'stalled'),
      applyNeedsOwner: phase === 'stalled',
      lastCheckedAt: this.lastCheckedAt !== null ? new Date(this.lastCheckedAt).toISOString() : null,
      nextCheckAt: this.nextCheckAt !== null ? new Date(this.nextCheckAt).toISOString() : null,
      lastError: this.lastError ?? local.error,
    };
    if (history) {
      view.history = history.slice(0, 20).map((e) => describeMenuDeployEvent(e, this.d.deviceId));
    }
    return view;
  }

  /** The view with the website's last lines (one network call). */
  async viewWithHistory(): Promise<MenuDeployView> {
    if (!this.d.linked()) return this.view();
    // Opened before the first look (just started): look now, so the card shows where the till stands.
    if (!this.status && this.lastCheckedAt === null) await this.checkNow();
    try {
      const res = await this.d.callWebsite('/api/bridge/menu-deploy?history=1');
      if (res.ok) {
        const parsed = menuDeployStatusResponseSchema.safeParse(await res.json().catch(() => null));
        // Only the lines: where the till stands is its last look's (the phase and the file stay together).
        if (parsed.success) return this.view(parsed.data.events ?? []);
      }
    } catch (e) {
      log.warn('Menu file history not read', { error: messageOf(e) });
    }
    return this.view();
  }

  private scope(): MenuDeployScope {
    try {
      return readSyncSwitch(this.d.db).mode === 'off' ? 'own' : 'shared';
    } catch {
      return 'own';
    }
  }

  private mode(): 'auto' | 'ask' {
    try {
      return readShopSetting(this.d.db, 'menu.autoUpdate').value.mode;
    } catch {
      return 'auto';
    }
  }

  /** No order rung up on this till for a couple of minutes. */
  private quiet(): boolean {
    const since = new Date(this.now() - MENU_DEPLOY_QUIET_MS).toISOString();
    const row = this.d.db
      .prepare(`SELECT 1 AS x FROM orders WHERE device_id = ? AND created_at > ? LIMIT 1`)
      .get(this.d.deviceId, since);
    return row === undefined;
  }

  private messageContext(pkg: MenuPackageMeta | null, local: MenuDeployLocal): MenuDeployMessageContext {
    const marker = readMenuMarker(this.d.db);
    return {
      fileName: pkg?.fileName ?? null,
      seq: pkg?.seq ?? null,
      error: local.error ?? pkg?.error ?? null,
      formatVersion: pkg?.formatVersion ?? null,
      maxFormatVersion: MAX_MENU_FILE_VERSION,
      otherPutIn: pkg?.state === 'applied',
      appliedHereButMissing:
        pkg?.state === 'applied' && pkg.appliedBy === this.d.deviceId && !(marker && marker.seq >= pkg.seq),
      behind: this.behind,
      automatic: marker?.packageId === pkg?.id ? marker?.automatic : false,
      notLookedYet: this.lastCheckedAt === null,
    };
  }

  // ---- telling the screens --------------------------------------------------

  private setPhase(phase: MenuDeployPhase, pkg: MenuPackageMeta | null, opts: { behind?: boolean } = {}): void {
    const changed = phase !== this.phase || this.behind !== !!opts.behind;
    this.phase = phase;
    this.behind = !!opts.behind;
    const notice = pkg ? this.noticeOnce(phase, pkg) : null;
    if (changed || notice) this.d.emit?.({ view: this.view(), notice });
  }

  /** A phase that is news, once per file per kind (the owner is not told the same thing twice). */
  private noticeOnce(phase: MenuDeployPhase, pkg: MenuPackageMeta): MenuDeployNotice | null {
    const db = this.d.db;
    const local = menuDeployLocalFor(readMenuDeployLocal(db), pkg.id);
    const marker = readMenuMarker(db);
    const mine = marker?.packageId === pkg.id ? marker : null;
    const notice = menuDeployNoticeFor(phase, {
      ...this.messageContext(pkg, local),
      counts: mine?.counts ?? null,
      otherTillName: mine ? (this.status?.tills.find((t) => t.deviceId === mine.appliedByDevice)?.deviceName ?? null) : null,
    });
    if (!notice) return null;
    const key = `${pkg.id}:${notice.kind === 'problem' ? phase : notice.kind}`;
    if (local.notified.includes(key)) return null;
    writeMenuDeployLocal(db, { ...local, notified: [...local.notified, key] });
    return notice;
  }

  // ---- the regular look ------------------------------------------------------

  /**
   * Look now (and put the file in when THE RULE says so). A look already on
   * its way is joined, never doubled: two at once make one claim.
   */
  async checkNow(): Promise<MenuDeployView> {
    if (!this.running) {
      this.running = this.check()
        .catch((e: unknown) => {
          this.lastError = cut(messageOf(e));
          log.warn('Menu file check failed', { error: messageOf(e) });
        })
        .finally(() => {
          this.running = null;
          if (this.started) this.schedule(this.gapMs());
        });
    }
    await this.running;
    return this.view();
  }

  /** Run `fn` alone: after whatever is running, and before anything else starts. */
  private async alone<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running) await this.running.catch(() => undefined);
    const p = fn();
    this.running = p;
    try {
      return await p;
    } finally {
      if (this.running === p) this.running = null;
    }
  }

  /** GET the status; false (with the phase set) when there is nothing to go on. */
  private async fetchStatus(): Promise<boolean> {
    if (!this.d.linked()) {
      this.setPhase('not_linked', null);
      return false;
    }
    let res: Response;
    try {
      res = await this.d.callWebsite('/api/bridge/menu-deploy');
    } catch (e) {
      if (e instanceof WebsiteNotReadyError) {
        this.setPhase('not_linked', null);
        return false;
      }
      this.failures += 1;
      this.lastError = 'Could not reach the website to look for a new menu file.';
      log.warn('Menu file check: website not reached', { error: messageOf(e) });
      return false;
    }
    if (res.status === 404) {
      // A website older than this feature: wait quietly.
      this.websiteOld = true;
      this.failures = 0;
      this.lastCheckedAt = this.now();
      this.setPhase('website_old', null);
      return false;
    }
    const body = await res.json().catch(() => null);
    const parsed = res.ok ? menuDeployStatusResponseSchema.safeParse(body) : null;
    if (!parsed?.success) {
      this.failures += 1;
      this.lastError = `The website did not answer as expected (${res.status}).`;
      log.warn('Menu file check: unexpected answer', { status: res.status });
      return false;
    }
    this.websiteOld = false;
    this.failures = 0;
    this.lastError = null;
    this.lastCheckedAt = this.now();
    this.status = { ...parsed.data, events: undefined };
    return true;
  }

  private async check(): Promise<void> {
    if (!(await this.fetchStatus())) return;
    const db = this.d.db;
    const status = this.status!;
    const pkg = status.latest;
    let local = readMenuDeployLocal(db);
    if (pkg) {
      const forPkg = menuDeployLocalFor(local, pkg.id);
      if (forPkg !== local) writeMenuDeployLocal(db, forPkg);
      local = forPkg;
    }
    const marker = readMenuMarker(db);
    const scope = this.scope();
    const link = readTillLink(db, new Date(this.now()));
    const decision = decideMenuDeployStep({
      pkg,
      marker,
      local,
      deviceId: this.d.deviceId,
      scope,
      linkStale: link.on && link.stale,
      mode: this.mode(),
      maxFormatVersion: MAX_MENU_FILE_VERSION,
      quiet: this.quiet(),
      nowMs: this.now(),
    });
    if (pkg && decision.report) {
      await this.report(pkg, scope, decision.report.outcome, {
        ...(decision.report.counts ? { counts: decision.report.counts } : {}),
        ...(decision.report.error ? { error: decision.report.error, retryable: false } : {}),
      });
    }
    if (pkg && decision.claim) {
      const claimed = await this.claim(pkg, scope, { lastPackageSeq: decision.claim.lastPackageSeq });
      if (claimed.kind === 'claimed') {
        await this.importClaimed(claimed.claim, scope, { userId: null, deviceId: this.d.deviceId }, true);
      }
      return;
    }
    this.setPhase(decision.phase, pkg);
  }

  // ---- talking to the website --------------------------------------------------

  private deviceFields() {
    return { deviceId: this.d.deviceId, deviceName: this.d.deviceName ? this.d.deviceName.slice(0, 200) : null, appVersion: this.d.appVersion.slice(0, 40) };
  }

  /** Tell the website what became of a file. True when it took the report. */
  private async report(
    pkg: MenuPackageMeta,
    scope: MenuDeployScope,
    outcome: MenuDeployOutcome,
    extra: { counts?: MenuDeployCountsView; error?: string; retryable?: boolean } = {},
  ): Promise<boolean> {
    const body: MenuDeployReportInput = {
      ...this.deviceFields(),
      scope,
      outcome,
      ...(extra.counts ? { counts: extra.counts } : {}),
      ...(extra.error ? { error: cut(extra.error) } : {}),
      ...(extra.retryable !== undefined ? { retryable: extra.retryable } : {}),
      ...(outcome === 'too_old' ? { formatVersion: pkg.formatVersion, maxFormatVersion: MAX_MENU_FILE_VERSION } : {}),
    };
    try {
      const res = await this.d.callWebsite(`/api/bridge/menu-deploy/${pkg.id}/report`, { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) {
        log.warn('Menu file report not taken', { outcome, status: res.status });
        return false;
      }
      const parsed = menuDeployReportResponseSchema.safeParse(await res.json().catch(() => null));
      if (outcome !== 'failed') this.said(pkg.id, outcome);
      if (parsed.success && this.status?.latest?.id === pkg.id) {
        this.status = { ...this.status, latest: { ...this.status.latest, state: parsed.data.state } };
      }
      return true;
    } catch (e) {
      log.warn('Menu file report not sent', { outcome, error: messageOf(e) });
      return false;
    }
  }

  private said(packageId: string, outcome: MenuDeployOutcome): void {
    const local = menuDeployLocalFor(readMenuDeployLocal(this.d.db), packageId);
    const key = menuDeployReportKey(packageId, outcome);
    if (!local.reported.includes(key)) writeMenuDeployLocal(this.d.db, { ...local, reported: [...local.reported, key] });
  }

  private async claim(
    pkg: MenuPackageMeta,
    scope: MenuDeployScope,
    opts: { lastPackageSeq: number | null; takeOver?: boolean; retry?: boolean },
  ): Promise<ClaimResult> {
    const body: MenuDeployClaimInput = {
      ...this.deviceFields(),
      scope,
      maxFormatVersion: MAX_MENU_FILE_VERSION,
      lastPackageSeq: opts.lastPackageSeq,
      takeOver: opts.takeOver === true,
      retry: opts.retry === true,
    };
    let res: Response;
    try {
      res = await this.d.callWebsite(`/api/bridge/menu-deploy/${pkg.id}/claim`, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      this.failures += 1;
      this.lastError = 'Could not reach the website to fetch the new menu file.';
      log.warn('Menu file claim not sent', { error: messageOf(e) });
      return { kind: 'unreachable', message: this.lastError };
    }
    const json = await res.json().catch(() => null);
    if (res.status === 409) {
      const refusal = menuDeployClaimRefusalSchema.safeParse(json);
      const code = refusal.success ? refusal.data.error : 'busy';
      const latest = refusal.success && refusal.data.package ? refusal.data.package : pkg;
      if (this.status && latest.id === this.status.latest?.id) this.status = { ...this.status, latest };
      // The website wrote the "too old" line itself.
      if (code === 'too_old') this.said(pkg.id, 'too_old');
      const next = menuClaimRefusalStep(code);
      if (next.recheckMs !== undefined) this.recheckMs = next.recheckMs;
      if (next.phase) this.setPhase(next.phase, latest, { behind: next.behind === true });
      return { kind: 'refused', code };
    }
    const parsed = res.ok ? menuDeployClaimResponseSchema.safeParse(json) : null;
    if (!parsed?.success) {
      this.failures += 1;
      this.lastError = `The website did not hand the file over (${res.status}).`;
      log.warn('Menu file claim: unexpected answer', { status: res.status });
      return { kind: 'unreachable', message: this.lastError };
    }
    return { kind: 'claimed', claim: parsed.data };
  }

  // ---- putting it in -------------------------------------------------------------

  /** A failed try: counted here (and, linked, on the website), then the back-off. */
  private async failed(pkg: MenuPackageMeta, scope: MenuDeployScope, message: string, retryable: boolean): Promise<ImportResult> {
    const db = this.d.db;
    const local = menuDeployLocalFor(readMenuDeployLocal(db), pkg.id);
    const attempts = local.attempts + 1;
    writeMenuDeployLocal(db, {
      ...local,
      attempts,
      nextTryAt: new Date(this.now() + menuDeployBackoffMs(local.attempts)).toISOString(),
      error: cut(message),
    });
    log.warn('Menu file not put in', { file: pkg.fileName, seq: pkg.seq, attempts, error: cut(message) });
    await this.report(pkg, scope, 'failed', { error: message, retryable });
    this.setPhase(attempts >= MENU_DEPLOY_MAX_ATTEMPTS ? 'gave_up' : 'failed', pkg);
    return { ok: false, message: cut(message) };
  }

  /** The file itself is wrong: never tried again. */
  private async refused(pkg: MenuPackageMeta, scope: MenuDeployScope, message: string): Promise<ImportResult> {
    const db = this.d.db;
    const local = menuDeployLocalFor(readMenuDeployLocal(db), pkg.id);
    writeMenuDeployLocal(db, { ...local, refused: true, error: cut(message) });
    log.warn('Menu file refused', { file: pkg.fileName, seq: pkg.seq, error: cut(message) });
    await this.report(pkg, scope, 'refused', { error: message, retryable: false });
    this.setPhase('refused', pkg);
    return { ok: false, message: cut(message) };
  }

  /**
   * The claimed file, put in: checked (gzip, SHA-256, the full schema), a
   * backup copy made, then the same import as Menu → Import with the
   * package's marker in its transaction; then reported, and the menu sent to
   * the website as after any import.
   */
  private async importClaimed(claim: MenuDeployClaimResponse, scope: MenuDeployScope, actor: Actor, automatic: boolean): Promise<ImportResult> {
    const pkg = claim.package;
    const deadline = this.now() + Math.max(60_000, claim.leaseSeconds * 1000 - LEASE_MARGIN_MS);
    this.setPhase('claimed', pkg);

    let raw: Buffer;
    try {
      raw = gunzipSync(Buffer.from(claim.contentGzB64, 'base64'), { maxOutputLength: MENU_FILE_MAX_BYTES });
    } catch {
      return this.failed(pkg, scope, 'The file came through damaged (it would not unpack); the till tries again.', true);
    }
    if (sha256Hex(raw) !== pkg.sha256) {
      return this.failed(pkg, scope, 'The file came through damaged (its checksum does not match); the till tries again.', true);
    }
    let file: MenuImportFile;
    try {
      file = parseMenuFileText(raw.toString('utf8'));
    } catch (e) {
      if (e instanceof MenuImportFileError) return this.refused(pkg, scope, e.message);
      return this.failed(pkg, scope, messageOf(e), true);
    }

    this.setPhase('importing', pkg);
    try {
      await this.d.backup('before-menu');
    } catch (e) {
      return this.failed(pkg, scope, `The backup copy could not be made first, so nothing was changed: ${messageOf(e)}`, true);
    }
    if (this.now() > deadline) {
      // The claim is about to run out: stop here; the next look claims it again (this till may).
      this.lastError = 'The backup copy took too long; the till tries again shortly.';
      this.setPhase('failed', pkg);
      return { ok: false, message: this.lastError };
    }

    let summary: MenuImportSummary;
    try {
      summary = applyMenuImport(this.d.db, file, pkg.fileName, actor, {
        package: {
          id: pkg.id,
          seq: pkg.seq,
          sha256: pkg.sha256,
          fileName: pkg.fileName,
          uploadedAt: pkg.uploadedAt,
          generatedAt: pkg.generatedAt,
          automatic,
        },
      });
    } catch (e) {
      return this.failed(pkg, scope, `Nothing was changed: ${messageOf(e)}`, true);
    }

    const counts = countsOf(summary);
    const db = this.d.db;
    const local = menuDeployLocalFor(readMenuDeployLocal(db), pkg.id);
    writeMenuDeployLocal(db, { ...local, attempts: 0, nextTryAt: null, error: null, refused: false });
    this.lastError = null;
    log.info('Menu file put in', { file: pkg.fileName, seq: pkg.seq, automatic, ...counts });
    // Lost? THE RULE's R2 says it again at the next look (from the marker).
    await this.report(pkg, scope, 'applied', { counts });
    // As after Menu → Import: the website sells from the menu the till last sent.
    void this.d.publishMenu().catch((e: unknown) => log.warn('Menu publish after a menu file skipped', { error: messageOf(e) }));
    this.setPhase('applied', pkg);
    return { ok: true, summary };
  }

  // ---- the owner's taps ------------------------------------------------------------

  /**
   * Put the newest file in now: the owner's OK in "Wait for my OK", "Try
   * again" after it failed (`retry`), or taking it over from a till that
   * stopped halfway (`takeOver`: the handler asks for the owner's login).
   * The counter-quiet wait is skipped (someone tapped); a broken link is not.
   */
  async apply(packageId: string, actor: Actor, opts: { takeOver?: boolean; retry?: boolean } = {}): Promise<MenuImportSummary> {
    return this.alone(async () => {
      if (!this.d.linked()) throw new MenuDeployError(menuDeployPhaseMessage('not_linked', { maxFormatVersion: MAX_MENU_FILE_VERSION }));
      if (!(await this.fetchStatus())) {
        throw new MenuDeployError(
          this.websiteOld ? menuDeployPhaseMessage('website_old', { maxFormatVersion: MAX_MENU_FILE_VERSION }) : this.lastError ?? 'Could not reach the website.',
        );
      }
      const pkg = this.status?.latest ?? null;
      if (!pkg || pkg.id !== packageId) throw new MenuDeployError(claimRefusalWords('superseded', null));
      if (pkg.formatVersion > MAX_MENU_FILE_VERSION) throw new MenuDeployError(menuFileTooNewMessage(pkg.formatVersion));
      const scope = this.scope();
      const db = this.d.db;
      const link = readTillLink(db, new Date(this.now()));
      if (scope === 'shared' && link.stale) {
        this.setPhase('waiting_link', pkg);
        throw new MenuDeployError(
          'The link to the other till isn’t working. Put the file in once it works again (Settings → Sync), so both tills end up with the same menu.',
        );
      }
      // Someone tapped: this till's tries start afresh.
      const local = menuDeployLocalFor(readMenuDeployLocal(db), pkg.id);
      writeMenuDeployLocal(db, { ...local, attempts: 0, nextTryAt: null, error: null, refused: false });
      const retry = opts.retry === true || pkg.state === 'failed' || !pkg.retryReady;
      const marker = readMenuMarker(db);
      const claimed = await this.claim(pkg, scope, { lastPackageSeq: marker?.seq ?? null, takeOver: opts.takeOver === true, retry });
      if (claimed.kind === 'unreachable') throw new MenuDeployError(claimed.message);
      if (claimed.kind === 'refused') throw new MenuDeployError(claimRefusalWords(claimed.code, pkg));
      const out = await this.importClaimed(claimed.claim, scope, actor, false);
      if (!out.ok) throw new MenuDeployError(out.message);
      return out.summary;
    });
  }

  /** What putting the newest file in would change — the normal preview, never a fresh start. Changes nothing. */
  async preview(packageId: string): Promise<MenuImportPreview & { packageId: string }> {
    if (!this.d.linked()) throw new MenuDeployError(menuDeployPhaseMessage('not_linked', { maxFormatVersion: MAX_MENU_FILE_VERSION }));
    const known = this.status?.latest?.id === packageId ? this.status.latest : null;
    let res: Response;
    try {
      res = await this.d.callWebsite(`/api/bridge/menu-deploy/${packageId}/content`);
    } catch {
      throw new MenuDeployError('Could not reach the website to fetch the menu file.');
    }
    if (res.status === 410) throw new MenuDeployError(claimRefusalWords('gone', null));
    if (res.status === 404) throw new MenuDeployError('That menu file is not on the website.');
    const parsed = res.ok ? menuDeployContentResponseSchema.safeParse(await res.json().catch(() => null)) : null;
    if (!parsed?.success) throw new MenuDeployError(`The website did not hand the file over (${res.status}).`);
    let raw: Buffer;
    try {
      raw = gunzipSync(Buffer.from(parsed.data.contentGzB64, 'base64'), { maxOutputLength: MENU_FILE_MAX_BYTES });
    } catch {
      throw new MenuDeployError('The file came through damaged (it would not unpack). Try again.');
    }
    const sha = sha256Hex(raw);
    if (sha !== parsed.data.sha256 || (known && sha !== known.sha256)) {
      throw new MenuDeployError('The file came through damaged (its checksum does not match). Try again.');
    }
    let file: MenuImportFile;
    try {
      file = parseMenuFileText(raw.toString('utf8'));
    } catch (e) {
      throw new MenuDeployError(messageOf(e));
    }
    const plan = planMenuImportFromDb(this.d.db, file);
    return { ...plan.preview, fileName: known?.fileName ?? 'Menu file from the costing PC', packageId };
  }

  /**
   * The owner's new upload key: made here, only its SHA-256 and last 4
   * characters sent (the website replaces the old key at once), and handed
   * back ONCE for the costing PC. Never stored, never logged.
   */
  async createKey(ownerUserId: string): Promise<MenuDeployKeyMade> {
    const notTaken = 'The website did not take the new key — nothing changed; the old key still works.';
    if (!this.d.linked()) throw new MenuDeployError(menuDeployPhaseMessage('not_linked', { maxFormatVersion: MAX_MENU_FILE_VERSION }));
    const key = `${MENU_DEPLOY_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    if (!isMenuDeployKey(key)) throw new MenuDeployError(notTaken);
    const keyHint = key.slice(-4);
    let res: Response;
    try {
      res = await this.d.callWebsite('/api/bridge/menu-deploy/key', {
        method: 'PUT',
        body: JSON.stringify({ keyHash: sha256Hex(key), keyHint, ...this.deviceFields() }),
      });
    } catch {
      throw new MenuDeployError(notTaken);
    }
    if (res.status === 404) throw new MenuDeployError(`${menuDeployPhaseMessage('website_old', { maxFormatVersion: MAX_MENU_FILE_VERSION })} ${notTaken}`);
    if (!res.ok) throw new MenuDeployError(notTaken);
    // 2xx: the website holds the new key's hash (the old key already stopped working).
    const parsed = menuDeployKeyResponseSchema.safeParse(await res.json().catch(() => null));
    const createdAt = parsed.success ? parsed.data.createdAt : new Date(this.now()).toISOString();
    setSetting(this.d.db, MENU_DEPLOY_KEY_INFO_KEY, { keyHint, keyCreatedAt: createdAt }, { actorUserId: ownerUserId });
    if (this.status) {
      this.status = { ...this.status, key: { keyHint, createdAt, deviceId: this.d.deviceId, deviceName: this.d.deviceName } };
    }
    log.info('Menu upload key made (only its hash went to the website)', { keyHint });
    return { key, keyHint, createdAt };
  }
}

// ---------------------------------------------------------------------------
// The one service of this till (made by the web bridge)
// ---------------------------------------------------------------------------

let current: MenuPackageService | null = null;

export function setMenuPackageService(s: MenuPackageService | null): void {
  current = s;
}

export function menuPackageService(): MenuPackageService | null {
  return current;
}

/** The phases the Dashboard's banner is for (re-exported for the handlers). */
export const MENU_DEPLOY_BANNER_PHASES = MENU_DEPLOY_PROBLEM_PHASES;
