/**
 * The website line a till from before v0.8 prints when it never stored one,
 * worked out when read — its settings are never written: a till linked to a
 * website prints that site's host; the first shop's till (by its receipt
 * name) keeps the site it always printed; any other till prints none; a
 * stored line, even an empty one, wins. Against a real SQLite database built
 * from every migration, with `node:sqlite` and a small `transaction()` shim
 * (better-sqlite3 is built for Electron's ABI); skips itself where node:sqlite
 * is missing. Every name is made up except the first shop's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '.' } }));

import { BRANDING_KEY, getReceiptBranding, legacyWebsiteLine, websiteHost } from './printer-config.js';

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
const WEB_BRIDGE_CONFIG_KEY = 'webBridge.config';

describe('websiteHost', () => {
  it('takes the host without www., and nothing from a bad or missing link', () => {
    expect(websiteHost('https://www.testshop.pk/')).toBe('testshop.pk');
    expect(websiteHost('https://orders.testshop.pk/menu')).toBe('orders.testshop.pk');
    expect(websiteHost('not a url')).toBeNull();
    expect(websiteHost(null)).toBeNull();
    expect(websiteHost(42)).toBeNull();
  });
});

describe.skipIf(!Sqlite)('the website line a till from before v0.8 prints', () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = openMigrated();
  });

  it('a till linked to a website prints that site, without www. — and nothing is written to its settings', () => {
    setSetting(db, BRANDING_KEY, legacyBranding('Test Shop'));
    setSetting(db, WEB_BRIDGE_CONFIG_KEY, { enabled: true, siteUrl: 'https://www.testshop.pk', bridgeSecret: 'sealed:x', pollIntervalMs: 20_000 });
    expect(getReceiptBranding(db).websiteLine).toBe('testshop.pk');
    expect(getReceiptBranding(db).storeName).toBe('Test Shop');
    expect(getSettingRaw(db, BRANDING_KEY)).toEqual(legacyBranding('Test Shop'));
  });

  it("the first shop's till keeps printing its own site, with or without the apostrophe", () => {
    setSetting(db, BRANDING_KEY, legacyBranding('Cheese O Clock'));
    expect(getReceiptBranding(db).websiteLine).toBe('cheeseoclock.net');
    expect(legacyWebsiteLine(db, "Cheese O'Clock")).toBe('cheeseoclock.net');
    expect(legacyWebsiteLine(db, 'CHEESE O’CLOCK')).toBe('cheeseoclock.net');
    expect(getSettingRaw(db, BRANDING_KEY)).toEqual(legacyBranding('Cheese O Clock'));
  });

  it('any other till prints no website line — never the first shop’s', () => {
    setSetting(db, BRANDING_KEY, legacyBranding('Test Shop'));
    expect(getReceiptBranding(db).websiteLine).toBe('');
    expect(legacyWebsiteLine(db, 'Test Shop')).toBe('');
  });

  it('a stored line wins, even an empty one — and a bad link is ignored', () => {
    setSetting(db, BRANDING_KEY, { ...legacyBranding('Cheese O Clock'), websiteLine: '' });
    setSetting(db, WEB_BRIDGE_CONFIG_KEY, { enabled: true, siteUrl: 'https://www.testshop.pk' });
    expect(getReceiptBranding(db).websiteLine).toBe('');
    setSetting(db, BRANDING_KEY, { ...legacyBranding('Test Shop'), websiteLine: 'myshop.pk' });
    expect(getReceiptBranding(db).websiteLine).toBe('myshop.pk');
    setSetting(db, BRANDING_KEY, legacyBranding('Test Shop'));
    setSetting(db, WEB_BRIDGE_CONFIG_KEY, { enabled: false, siteUrl: 'not a url' });
    expect(getReceiptBranding(db).websiteLine).toBe('');
  });
});
