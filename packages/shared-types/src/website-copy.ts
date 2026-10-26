/**
 * The website's own data, copied to the till every day and put back from there (27 Oct 2026; the user, after the
 * website's database hit its monthly limit: "both sync to pos laptop and all data circular so if it go down other
 * can back it up"). The website's side: apps/web/src/lib/website-copy.ts; the till's:
 * apps/pos/electron/services/website-copy-service.ts.
 */

/** The copy's format, on the file and on every restore batch. */
export const WEBSITE_COPY_FORMAT = 'coc-website-copy-v1';

/** One copy on this till (a file in its website-copies folder). */
export interface WebsiteCopyFile {
  fileName: string;
  takenAt: string;
  /** The website's identity: a new database has a new one. */
  websiteId: string;
  /** The website's address it came from ('cheeseoclock.net', without www.): only a copy of the same site is put back by itself. */
  site: string | null;
  rows: number;
  bytes: number;
}

/** Settings → Backups → Website copy. */
export interface WebsiteCopyStatus {
  /** The website link is set up (copies are taken only then). */
  linked: boolean;
  lastAt: string | null;
  lastError: { at: string; message: string } | null;
  /** Newest first. */
  copies: WebsiteCopyFile[];
  /**
   * The website answers with a different identity from this till's newest copy: its database was replaced. The
   * owner can put the older website's data back (an empty one gets it by itself).
   */
  replaced: { from: string; to: string; at: string } | null;
  /** The last put-back (by itself or by the owner). */
  lastRestore: { at: string; fileName: string; inserted: number; by: 'auto' | 'owner' } | null;
  busy: boolean;
}

export interface WebsiteCopyRestoreResult {
  fileName: string;
  inserted: number;
  tables: Array<{ name: string; inserted: number }>;
}
