/**
 * The website's own data, kept on this till (27 Oct 2026; the user, after the website's database hit its monthly
 * limit: "both sync to pos laptop and all data circular so if it go down other can back it up"). The till already
 * has the shop's records and its cloud copies on the website; this is the other way round — the tables only the
 * website has (its orders and their tracking, the phone dashboard's sign-ins, the menu files and their key, the
 * WhatsApp chats, the comment replies, the published menu), copied here once a day and put back from here.
 *
 * WHEN. A look every LOOK_MS while the website link is set up; a copy when the last good one is DUE_MS old, a
 * failed one tried again after RETRY_MS. The owner or a manager can take one at once (Settings → Backups).
 *
 * WHERE. userData/website-copies: `website-<time>-<id>.json.gz` (the copy) beside `….meta.json` (what it holds),
 * the newest KEEP_COPIES kept — and always the newest of each website, so a replaced website's data outlives two
 * weeks of copies of the new one. Also into the owner's second-copy folder (backup-second-copy.ts), when set.
 *
 * PUTTING IT BACK. The website answers each copy with its identity; a different one from the newest copy here means
 * its database was replaced. A replacement with no orders and no menu files of its own gets the old website's newest
 * copy back by itself; otherwise the owner is shown it and puts it back (owner login). The website only ever adds
 * rows it does not have, so a put-back never overwrites anything newer and is safe to run twice.
 *
 * Nothing here writes a business row: the status lives in this till's own settings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  WEBSITE_COPY_FORMAT,
  type WebsiteCopyFile,
  type WebsiteCopyRestoreResult,
  type WebsiteCopyStatus,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { deleteSetting, getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import type { BridgeApi } from './cloud-copy-chunks.js';
import { getSecondCopyDir } from './backup-second-copy.js';
import {
  fetchWebsiteManifest,
  pullWebsiteCopy,
  pushWebsiteCopy,
  type WebsiteCopyDoc,
  type WebsiteCopyManifest,
} from './website-copy-client.js';

export const WEBSITE_COPY_LAST_KEY = 'websiteCopy.last';
export const WEBSITE_COPY_ERROR_KEY = 'websiteCopy.lastError';
export const WEBSITE_COPY_ATTEMPT_KEY = 'websiteCopy.lastAttempt';
export const WEBSITE_COPY_REPLACED_KEY = 'websiteCopy.replaced';
export const WEBSITE_COPY_RESTORE_KEY = 'websiteCopy.lastRestore';

export const LOOK_MS = 15 * 60_000;
export const STARTUP_MS = 3 * 60_000;
export const DUE_MS = 22 * 3_600_000;
export const RETRY_MS = 3_600_000;
export const KEEP_COPIES = 14;
/** The folder under the owner's second-copy folder. */
export const SECOND_COPY_SUBDIR = 'website-copies';

const COPY_FILE = /^website-(\d{8}T\d{6}Z)-([0-9a-f]{8})\.json\.gz$/;
/** A replacement that has these of its own is not put back by itself: the owner decides. */
const OWN_DATA_TABLES = ['web_orders', 'menu_packages'];

export interface WebsiteCopyDeps {
  db: AppDatabase;
  /** userData/website-copies. */
  dir: string;
  /** The web bridge's authenticated call in the transfer's shape; throws without a link. */
  api: BridgeApi;
  /** The website link is set up (address and password). */
  linked: () => boolean;
  /** The website's address as the link has it ('https://www.example.com'), or null. */
  siteUrl: () => string | null;
  /** After a put-back: the website gets this till's settings blocks if it lacks them (each by its own stamp). */
  afterRestore?: () => Promise<void>;
  now?: () => number;
  log?: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void };
}

/** A refusal in plain words for the person who tapped (the handlers show it as it is). */
export class WebsiteCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebsiteCopyError';
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 'https://www.Example.com/x' → 'example.com'; null when it is no address. */
export function siteOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The copies in a folder, newest first, from their .meta.json (a copy without one is left out). */
export function listWebsiteCopies(dir: string): WebsiteCopyFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: WebsiteCopyFile[] = [];
  for (const n of names) {
    if (!COPY_FILE.test(n) || !names.includes(metaName(n))) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, metaName(n)), 'utf8')) as Partial<WebsiteCopyFile>;
      if (typeof m.takenAt !== 'string' || typeof m.websiteId !== 'string') continue;
      out.push({
        fileName: n,
        takenAt: m.takenAt,
        websiteId: m.websiteId,
        site: typeof m.site === 'string' ? m.site : null,
        rows: Number(m.rows ?? 0),
        bytes: Number(m.bytes ?? 0),
      });
    } catch {
      // A half-written meta file: that copy is not offered.
    }
  }
  return out.sort((a, b) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : a.fileName < b.fileName ? 1 : -1));
}

function metaName(fileName: string): string {
  return fileName.replace(/\.json\.gz$/, '.meta.json');
}

/** Newest KEEP_COPIES, and always the newest of each website. */
export function copiesToRotate(copies: readonly WebsiteCopyFile[], keep = KEEP_COPIES): WebsiteCopyFile[] {
  const newestOfEach = new Set<string>();
  const seen = new Set<string>();
  for (const c of copies) {
    if (seen.has(c.websiteId)) continue;
    seen.add(c.websiteId);
    newestOfEach.add(c.fileName);
  }
  return copies.slice(keep).filter((c) => !newestOfEach.has(c.fileName));
}

function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function rotate(dir: string): void {
  for (const old of copiesToRotate(listWebsiteCopies(dir))) {
    for (const f of [old.fileName, metaName(old.fileName)]) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // gone already
      }
    }
  }
}

export function readWebsiteCopy(dir: string, fileName: string): WebsiteCopyDoc {
  if (!COPY_FILE.test(fileName)) throw new WebsiteCopyError('That is not one of the till’s website copies.');
  let doc: WebsiteCopyDoc;
  try {
    doc = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, fileName))).toString('utf8')) as WebsiteCopyDoc;
  } catch {
    throw new WebsiteCopyError('That website copy could not be read (the file is damaged or gone).');
  }
  if (doc.format !== WEBSITE_COPY_FORMAT || !Array.isArray(doc.tables)) {
    throw new WebsiteCopyError('That website copy is in a format this till does not know.');
  }
  return doc;
}

export class WebsiteCopyService {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly deps: WebsiteCopyDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.look();
      this.timer = setInterval(() => void this.look(), LOOK_MS);
    }, STARTUP_MS);
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = null;
    this.timer = null;
  }

  status(): WebsiteCopyStatus {
    const { db } = this.deps;
    const last = asRecord(getSettingRaw(db, WEBSITE_COPY_LAST_KEY));
    const err = asRecord(getSettingRaw(db, WEBSITE_COPY_ERROR_KEY));
    const replaced = asRecord(getSettingRaw(db, WEBSITE_COPY_REPLACED_KEY));
    const restore = asRecord(getSettingRaw(db, WEBSITE_COPY_RESTORE_KEY));
    return {
      linked: this.deps.linked(),
      lastAt: typeof last?.['at'] === 'string' ? last['at'] : null,
      lastError:
        typeof err?.['at'] === 'string' && typeof err['message'] === 'string' ? { at: err['at'], message: err['message'] } : null,
      copies: listWebsiteCopies(this.deps.dir),
      replaced:
        typeof replaced?.['from'] === 'string' && typeof replaced['to'] === 'string' && typeof replaced['at'] === 'string'
          ? { from: replaced['from'], to: replaced['to'], at: replaced['at'] }
          : null,
      lastRestore:
        typeof restore?.['at'] === 'string' && typeof restore['fileName'] === 'string'
          ? {
              at: restore['at'],
              fileName: restore['fileName'],
              inserted: Number(restore['inserted'] ?? 0),
              by: restore['by'] === 'auto' ? 'auto' : 'owner',
            }
          : null,
      busy: this.busy,
    };
  }

  /** The timer's look: a copy when one is due. Never throws. */
  async look(): Promise<void> {
    if (this.busy || !this.deps.linked()) return;
    const at = (key: string): number => {
      const v = asRecord(getSettingRaw(this.deps.db, key))?.['at'];
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    const now = this.now();
    if (now - at(WEBSITE_COPY_LAST_KEY) < DUE_MS || now - at(WEBSITE_COPY_ATTEMPT_KEY) < RETRY_MS) return;
    await this.take().catch(() => undefined);
  }

  /** Take a copy now (the timer, or Settings → Backups). Records the outcome; throws it in plain words. */
  async take(): Promise<WebsiteCopyStatus> {
    if (this.busy) throw new WebsiteCopyError('A website copy is already on its way. Try again in a minute.');
    if (!this.deps.linked()) throw new WebsiteCopyError('Set up the website link first (Settings → Online orders).');
    this.busy = true;
    const { db, log } = this.deps;
    const startedAt = new Date(this.now()).toISOString();
    setSetting(db, WEBSITE_COPY_ATTEMPT_KEY, { at: startedAt });
    try {
      const manifest = await fetchWebsiteManifest(this.deps.api);
      await this.noticeReplacement(manifest);
      const doc = await pullWebsiteCopy(this.deps.api, manifest);
      const file = this.write(doc);
      setSetting(db, WEBSITE_COPY_LAST_KEY, { at: new Date(this.now()).toISOString(), fileName: file.fileName, websiteId: doc.websiteId });
      deleteSetting(db, WEBSITE_COPY_ERROR_KEY);
      log?.info('Website copy taken', { fileName: file.fileName, rows: file.rows, bytes: file.bytes });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSetting(db, WEBSITE_COPY_ERROR_KEY, { at: new Date(this.now()).toISOString(), message });
      log?.warn('Website copy failed', { message });
      throw e instanceof WebsiteCopyError ? e : new WebsiteCopyError(message);
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  /**
   * Put a copy back on the website (owner, or by itself for an empty replacement). No file named = the newest copy
   * of the website that was replaced, else the newest copy.
   */
  async restore(fileName?: string, by: 'auto' | 'owner' = 'owner'): Promise<WebsiteCopyRestoreResult> {
    if (this.busy && by === 'owner') throw new WebsiteCopyError('A website copy is on its way. Try again in a minute.');
    if (!this.deps.linked()) throw new WebsiteCopyError('Set up the website link first (Settings → Online orders).');
    const wasBusy = this.busy;
    this.busy = true;
    try {
      const pick = fileName ?? this.defaultRestoreFile();
      if (!pick) throw new WebsiteCopyError('This till has no copy of the website yet.');
      const copySite = listWebsiteCopies(this.deps.dir).find((c) => c.fileName === pick)?.site ?? null;
      const site = siteOf(this.deps.siteUrl());
      if (copySite && site && copySite !== site) {
        throw new WebsiteCopyError(`That copy is of ${copySite}, and this till is linked to ${site}: one site’s data never goes to another.`);
      }
      const doc = readWebsiteCopy(this.deps.dir, pick);
      const result = await pushWebsiteCopy(this.deps.api, doc, pick);
      setSetting(this.deps.db, WEBSITE_COPY_RESTORE_KEY, { at: new Date(this.now()).toISOString(), fileName: pick, inserted: result.inserted, by });
      deleteSetting(this.deps.db, WEBSITE_COPY_REPLACED_KEY);
      this.deps.log?.info('Website copy put back', { fileName: pick, inserted: result.inserted, by });
      await this.deps.afterRestore?.().catch(() => undefined);
      return result;
    } catch (e) {
      this.deps.log?.warn('Putting a website copy back failed', { message: e instanceof Error ? e.message : String(e), by });
      throw e instanceof WebsiteCopyError ? e : new WebsiteCopyError(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = wasBusy;
    }
  }

  private defaultRestoreFile(): string | null {
    const copies = listWebsiteCopies(this.deps.dir);
    const replaced = asRecord(getSettingRaw(this.deps.db, WEBSITE_COPY_REPLACED_KEY));
    const from = typeof replaced?.['from'] === 'string' ? replaced['from'] : null;
    return (from ? copies.find((c) => c.websiteId === from) : undefined)?.fileName ?? copies[0]?.fileName ?? null;
  }

  /**
   * The same site answering with a new identity: recorded; an empty one gets the old website's data back at once.
   * A till linked to another site since is a different website, never "replaced": nothing of one site goes to another.
   */
  private async noticeReplacement(manifest: WebsiteCopyManifest): Promise<void> {
    const site = siteOf(this.deps.siteUrl());
    const newest = listWebsiteCopies(this.deps.dir)[0];
    if (!newest || newest.websiteId === manifest.websiteId) return;
    if (!site || newest.site !== site) return;
    const at = new Date(this.now()).toISOString();
    setSetting(this.deps.db, WEBSITE_COPY_REPLACED_KEY, { from: newest.websiteId, to: manifest.websiteId, at });
    this.deps.log?.warn('The website answers as a new website (its database was replaced)', {
      from: newest.websiteId,
      to: manifest.websiteId,
    });
    const own = manifest.tables.filter((t) => OWN_DATA_TABLES.includes(t.name)).reduce((n, t) => n + t.rows, 0);
    if (own > 0) return;
    // A failed put-back leaves the notice for the owner; the copy of the new website still goes ahead.
    await this.restore(newest.fileName, 'auto').catch(() => undefined);
  }

  private write(doc: WebsiteCopyDoc): WebsiteCopyFile {
    const { dir, db } = this.deps;
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `website-${stamp(doc.takenAt)}-${doc.websiteId.replace(/-/g, '').slice(0, 8).toLowerCase()}.json.gz`;
    if (!COPY_FILE.test(fileName)) throw new WebsiteCopyError('The website sent an identity this till cannot name a file after.');
    const gz = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 });
    const file: WebsiteCopyFile = {
      fileName,
      takenAt: doc.takenAt,
      websiteId: doc.websiteId,
      site: siteOf(this.deps.siteUrl()),
      rows: doc.tables.reduce((n, t) => n + t.rows.length, 0),
      bytes: gz.length,
    };
    writeAtomic(path.join(dir, fileName), gz);
    writeAtomic(path.join(dir, metaName(fileName)), JSON.stringify(file));
    rotate(dir);
    const second = getSecondCopyDir(db);
    if (second) {
      // Best effort, like the second copy of a backup: a missing USB drive never fails the copy here.
      try {
        const there = path.join(second, SECOND_COPY_SUBDIR);
        fs.mkdirSync(there, { recursive: true });
        writeAtomic(path.join(there, fileName), gz);
        writeAtomic(path.join(there, metaName(fileName)), JSON.stringify(file));
        rotate(there);
      } catch (e) {
        this.deps.log?.warn('Second copy of the website copy failed', { message: e instanceof Error ? e.message : String(e) });
      }
    }
    return file;
  }
}

let current: WebsiteCopyService | null = null;

/** The till's one service; the web bridge makes it at start-up (null before). */
export function websiteCopyService(): WebsiteCopyService | null {
  return current;
}

export function setWebsiteCopyService(s: WebsiteCopyService | null): void {
  current = s;
}
