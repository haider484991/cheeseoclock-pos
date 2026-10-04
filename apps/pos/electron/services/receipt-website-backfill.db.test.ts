/**
 * The one-time website-line backfill for tills from before v0.8, against a
 * real SQLite database built from every migration: nothing happens without
 * branding or when a line is already stored; a till linked to a website gets
 * that site's host; the first shop's till (by its receipt name) keeps the
 * site it always printed; any other till gets no line; running twice changes
 * nothing. Uses `node:sqlite` with a small `transaction()` shim (better-sqlite3
 * is built for Electron's ABI) and skips itself where node:sqlite is missing.
 * Every name is made up except the first shop's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';

const link = vi.hoisted(() => ({ siteUrl: null as string | null }));
vi.mock('./web-bridge-config.js', () => ({ getWebBridgeConfig: () => ({ siteUrl: link.siteUrl }) }));
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '.' } }));

import { backfillReceiptWebsiteLine, websiteHost } from './receipt-website-backfill.js';
import { BRANDING_KEY, getReceiptBranding } from './printer-config.js';

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
const Sqlite = (() => {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }).DatabaseSync;
  } catch {
    return null;
  }
})();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function openMigrated(): AppDatabase {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth += 1;
        try {
          const out = fn(...args);
          depth -= 1;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (e) {
          depth -= 1;
          if (depth === 0) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      },
  };
  return db as unknown as AppDatabase;
}

/** Exactly what tills up to v0.7.x stored: no website field. */
const legacyBranding = (storeName: string) => ({ storeName, storeTagline: 'Test tagline', phoneLine: '0300 0000000' });

describe('websiteHost', () => {
  it('takes the host without www., and nothing from a bad or missing link', () => {
    expect(websiteHost('https://www.testshop.pk/')).toBe('testshop.pk');
    expect(websiteHost('https://orders.testshop.pk/menu')).toBe('orders.testshop.pk');
    expect(websiteHost('not a url')).toBeNull();
    expect(websiteHost(null)).toBeNull();
  });
});

describe.skipIf(!Sqlite)('receipt website line backfill', () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = openMigrated();
    link.siteUrl = null;
  });

  it('does nothing on a till with no branding yet (first-time setup writes the line itself)', () => {
    expect(backfillReceiptWebsiteLine(db)).toEqual({ kind: 'none', why: 'no-branding' });
    expect(getSettingRaw(db, BRANDING_KEY)).toBeNull();
  });

  it('a till linked to a website prints that site, without www.', () => {
    setSetting(db, BRANDING_KEY, legacyBranding('Test Shop'));
    link.siteUrl = 'https://www.testshop.pk';
    expect(backfillReceiptWebsiteLine(db)).toEqual({ kind: 'written', websiteLine: 'testshop.pk', from: 'website-link' });
    expect(getReceiptBranding(db).websiteLine).toBe('testshop.pk');
    expect(getReceiptBranding(db).storeName).toBe('Test Shop');
  });

  it("the first shop's till keeps printing its own site, with or without the apostrophe", () => {
    setSetting(db, BRANDING_KEY, legacyBranding('Cheese O Clock'));
    expect(backfillReceiptWebsiteLine(db)).toEqual({ kind: 'written', websiteLine: 'cheeseoclock.net', from: 'first-shop' });
    expect(getReceiptBranding(db).websiteLine).toBe('cheeseoclock.net');

    const db2 = openMigrated();
    setSetting(db2, BRANDING_KEY, legacyBranding("Cheese O'Clock"));
    expect(backfillReceiptWebsiteLine(db2).kind).toBe('written');
    expect(getReceiptBranding(db2).websiteLine).toBe('cheeseoclock.net');
  });

  it('any other till gets no website line — never the first shop’s', () => {
    setSetting(db, BRANDING_KEY, legacyBranding('Test Shop'));
    expect(backfillReceiptWebsiteLine(db)).toEqual({ kind: 'written', websiteLine: '', from: 'empty' });
    expect(getReceiptBranding(db).websiteLine).toBe('');
  });

  it('a stored line, even an empty one, is left alone; a second run changes nothing', () => {
    setSetting(db, BRANDING_KEY, { ...legacyBranding('Cheese O Clock'), websiteLine: '' });
    expect(backfillReceiptWebsiteLine(db)).toEqual({ kind: 'none', why: 'already-set' });
    expect(getReceiptBranding(db).websiteLine).toBe('');

    const db2 = openMigrated();
    setSetting(db2, BRANDING_KEY, legacyBranding('Test Shop'));
    link.siteUrl = 'https://testshop.pk';
    expect(backfillReceiptWebsiteLine(db2).kind).toBe('written');
    link.siteUrl = 'https://other.example';
    expect(backfillReceiptWebsiteLine(db2)).toEqual({ kind: 'none', why: 'already-set' });
    expect(getReceiptBranding(db2).websiteLine).toBe('testshop.pk');
  });
});
