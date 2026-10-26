/**
 * The website's own data over the bridge (apps/web/src/lib/website-copy.ts): pull a whole copy, page by page, and
 * put one back, a batch at a time. No Electron or database imports: the transfer takes a plain `BridgeApi`, so the
 * website's tests run it against the real route handlers (apps/web/src/lib/website-copy.test.ts).
 */
import { WEBSITE_COPY_FORMAT, type WebsiteCopyRestoreResult } from '@cheeseoclock/shared-types';
import type { BridgeApi } from './cloud-copy-chunks.js';

/** One restore request: rows up to this many characters of JSON (the bridge gives each call 20 s on shop Wi-Fi). */
export const RESTORE_BATCH_CHARS = 1_000_000;
export const RESTORE_BATCH_ROWS = 500;
/** A table is pulled in at most this many pages (a runaway `next` can never loop forever). */
const MAX_PAGES_PER_TABLE = 10_000;

export interface WebsiteCopyDoc {
  format: typeof WEBSITE_COPY_FORMAT;
  websiteId: string;
  websiteCreatedAt: string;
  takenAt: string;
  /** In the website's restore order (a parent before its children). */
  tables: Array<{ name: string; rows: unknown[] }>;
}

export interface WebsiteCopyManifest {
  format: string;
  websiteId: string;
  websiteCreatedAt: string;
  takenAt: string;
  tables: Array<{ name: string; rows: number }>;
}

/** The website has no copy routes yet (it predates 27 Oct 2026). */
export class WebsiteCopyUnsupportedError extends Error {
  constructor() {
    super('The website needs its update before it can be copied to the till.');
    this.name = 'WebsiteCopyUnsupportedError';
  }
}

function refused(what: string, status: number): Error {
  if (status === 404) return new WebsiteCopyUnsupportedError();
  if (status === 401 || status === 403) return new Error(`The website refused the till’s password while ${what} (check Settings → Online orders).`);
  return new Error(`The website did not answer while ${what} (HTTP ${status}). The till will try again.`);
}

function data<T>(json: unknown): T | null {
  const body = json as { ok?: unknown; data?: unknown } | null;
  return body && body.ok === true ? (body.data as T) : null;
}

export async function fetchWebsiteManifest(api: BridgeApi): Promise<WebsiteCopyManifest> {
  const res = await api('/api/bridge/website-copy');
  const m = res.status === 200 ? data<WebsiteCopyManifest>(res.json) : null;
  if (!m) throw refused('asking what it holds', res.status);
  if (m.format !== WEBSITE_COPY_FORMAT) throw new Error(`The website sent a copy this till does not know (${String(m.format)}).`);
  return m;
}

/** The whole copy: the manifest, then every table page by page. */
export async function pullWebsiteCopy(api: BridgeApi, manifest?: WebsiteCopyManifest): Promise<WebsiteCopyDoc> {
  const m = manifest ?? (await fetchWebsiteManifest(api));
  const tables: WebsiteCopyDoc['tables'] = [];
  for (const t of m.tables) {
    const rows: unknown[] = [];
    let offset: number | null = 0;
    for (let page = 0; offset !== null; page++) {
      if (page >= MAX_PAGES_PER_TABLE) throw new Error(`The website kept sending more of ${t.name}.`);
      const res = await api(`/api/bridge/website-copy?table=${encodeURIComponent(t.name)}&offset=${offset}`);
      const got = res.status === 200 ? data<{ rows: unknown[]; next: number | null }>(res.json) : null;
      if (!got || !Array.isArray(got.rows)) throw refused(`copying ${t.name}`, res.status);
      rows.push(...got.rows);
      offset = got.next;
    }
    tables.push({ name: t.name, rows });
  }
  return { format: WEBSITE_COPY_FORMAT, websiteId: m.websiteId, websiteCreatedAt: m.websiteCreatedAt, takenAt: m.takenAt, tables };
}

/** A table's rows in requests under the limits; a row bigger than a whole batch goes on its own. */
export function restoreBatches(rows: readonly unknown[], maxChars = RESTORE_BATCH_CHARS, maxRows = RESTORE_BATCH_ROWS): unknown[][] {
  const out: unknown[][] = [];
  let batch: unknown[] = [];
  let chars = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (batch.length > 0 && (chars + size > maxChars || batch.length >= maxRows)) {
      out.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(row);
    chars += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/**
 * Put a copy back: every table in the copy's order, a batch at a time. The website adds only the rows it does not
 * have (never over a newer one), so this is safe on a website that has carried on since, and safe to run again.
 */
export async function pushWebsiteCopy(api: BridgeApi, doc: WebsiteCopyDoc, fileName: string): Promise<WebsiteCopyRestoreResult> {
  const tables: WebsiteCopyRestoreResult['tables'] = [];
  for (const t of doc.tables) {
    let inserted = 0;
    for (const batch of restoreBatches(t.rows)) {
      const res = await api('/api/bridge/website-copy/restore', {
        method: 'POST',
        body: JSON.stringify({ format: WEBSITE_COPY_FORMAT, table: t.name, rows: batch }),
      });
      const got = res.status === 200 ? data<{ inserted: number }>(res.json) : null;
      if (!got) throw refused(`putting ${t.name} back`, res.status);
      inserted += got.inserted;
    }
    tables.push({ name: t.name, inserted });
  }
  return { fileName, inserted: tables.reduce((n, t) => n + t.inserted, 0), tables };
}
