/**
 * The licence service against a real SQLite database built from every
 * migration: the trial begins at the first start and is not reset by later
 * starts; a bad key changes nothing; a genuine key for this till is stored
 * (with its audit row) and licenses the till; the latest time seen is kept so
 * a clock set back does not lengthen the trial. The vendor key is replaced by
 * a throwaway pair made here. Uses `node:sqlite` with a small `transaction()`
 * shim (better-sqlite3 is built for Electron's ABI) and skips itself where
 * node:sqlite is missing. Every name is made up.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/connection.js';
import { getSettingRaw } from '../../db/repositories/settings-repo.js';

const keys = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync: gen } = require('node:crypto') as typeof import('node:crypto');
  const pair = gen('ed25519');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  return {
    pair,
    publicRaw: Buffer.from(spki.subarray(spki.length - 32)).toString('base64url'),
  };
});

vi.mock('./public-key.js', () => ({ LICENCE_PUBLIC_KEY: keys.publicRaw }));
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

import { LICENCE_SETTING_LAST_SEEN, LICENCE_SETTING_TOKEN, LICENCE_SETTING_TRIAL_STARTED, licenceService } from './licence-service.js';

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
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

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

const DAY = 24 * 60 * 60 * 1000;
const DEVICE = '01a10799-4d17-7ff9-9b8a-25c16b9d08e7';
const T0 = new Date('2026-10-05T09:00:00.000Z');

function issue(device = DEVICE, expires = new Date(T0.getTime() + 365 * DAY).toISOString(), privateKey = keys.pair.privateKey): string {
  const payload = { v: 1, id: 'lic_db_test', shop: 'Made Up Grill', device, plan: 'pro', issued: T0.toISOString(), expires, graceDays: 14 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = sign(null, body, createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })));
  return `COC1.${body.toString('base64url')}.${sig.toString('base64url')}`;
}

function auditRows(db: AppDatabase): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
}

describe.skipIf(!Sqlite)('licence service on a real database', () => {
  it('begins the 30-day trial at the first start and keeps that date at later starts', () => {
    const db = openMigrated();
    const first = licenceService.init(db, DEVICE, T0, null);
    expect(first.state).toBe('trial');
    expect(first.daysLeft).toBe(30);
    expect(first.salesAllowed).toBe(true);
    expect(getSettingRaw(db, LICENCE_SETTING_TRIAL_STARTED)).toBe(T0.toISOString());

    const later = licenceService.init(db, DEVICE, new Date(T0.getTime() + 10 * DAY), null);
    expect(later.state).toBe('trial');
    expect(later.daysLeft).toBe(20);
    expect(getSettingRaw(db, LICENCE_SETTING_TRIAL_STARTED)).toBe(T0.toISOString());

    expect(licenceService.status(new Date(T0.getTime() + 31 * DAY)).state).toBe('expired');
    expect(licenceService.salesAllowed(new Date(T0.getTime() + 31 * DAY))).toBe(false);
  });

  it('a bad key changes nothing; a genuine key for this till is stored with an audit row and licenses it', () => {
    const db = openMigrated();
    licenceService.init(db, DEVICE, T0, null);
    const before = auditRows(db);

    const wrongTill = licenceService.activate(issue('01a10799-4d17-7ff9-9b8a-000000000000'), 'owner-1', T0);
    expect(wrongTill.ok).toBe(false);
    if (!wrongTill.ok) expect(wrongTill.problem).toMatch(/another till/);
    const forged = licenceService.activate(issue(DEVICE, undefined, generateKeyPairSync('ed25519').privateKey), 'owner-1', T0);
    expect(forged.ok).toBe(false);
    expect(getSettingRaw(db, LICENCE_SETTING_TOKEN)).toBeNull();
    expect(auditRows(db)).toBe(before);

    const good = licenceService.activate(`  ${issue()}\n`, 'owner-1', T0);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.status.state).toBe('active');
      expect(good.status.shop).toBe('Made Up Grill');
      expect(good.status.daysLeft).toBe(365);
    }
    expect(getSettingRaw(db, LICENCE_SETTING_TOKEN)).toBe(issue());
    expect(auditRows(db)).toBeGreaterThan(before);

    // Well past the trial, the key is what keeps the till selling.
    expect(licenceService.salesAllowed(new Date(T0.getTime() + 200 * DAY))).toBe(true);
    // And past paid-until plus grace, it stops.
    expect(licenceService.status(new Date(T0.getTime() + 365 * DAY + 15 * DAY)).state).toBe('expired');
  });

  it('remembers the latest time seen, so a clock set back does not lengthen the trial', () => {
    const db = openMigrated();
    const started = new Date(T0.getTime() - 29 * DAY);
    licenceService.init(db, DEVICE, started, null);
    expect(licenceService.status(T0).daysLeft).toBe(1);
    expect(getSettingRaw(db, LICENCE_SETTING_LAST_SEEN)).toBe(T0.toISOString());

    const rolledBack = licenceService.status(new Date(T0.getTime() - 20 * DAY));
    expect(rolledBack.daysLeft).toBe(1);
    expect(getSettingRaw(db, LICENCE_SETTING_LAST_SEEN)).toBe(T0.toISOString());
  });
});

describe.skipIf(!Sqlite)('the machine marker outside the data folder', () => {
  const roots: string[] = [];
  const markerFile = () => {
    const d = mkdtempSync(join(tmpdir(), 'coc-licence-marker-'));
    roots.push(d);
    return join(d, 'CheeseOclock POS', 'licence-marker.json');
  };
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it('a wiped or redirected data folder starts a new device but not a new trial on the same PC', () => {
    const file = markerFile();
    const firstDb = openMigrated();
    const started = new Date(T0.getTime() - 20 * DAY);
    expect(licenceService.init(firstDb, DEVICE, started, file).daysLeft).toBe(30);
    expect(existsSync(file)).toBe(true);

    const freshDb = openMigrated(); // a new data folder: new device id, nothing saved
    const again = licenceService.init(freshDb, '01a10799-4d17-7ff9-9b8a-111111111111', T0, file);
    expect(again.state).toBe('trial');
    expect(again.daysLeft).toBe(10);
    expect(getSettingRaw(freshDb, LICENCE_SETTING_TRIAL_STARTED)).toBe(started.toISOString());
  });

  it('the latest time seen also comes from the marker, and the owner can reset it when the clock was wrong', () => {
    const file = markerFile();
    const db1 = openMigrated();
    licenceService.init(db1, DEVICE, T0, file);
    // The PC's clock jumped 60 days ahead for one look, then was corrected.
    const ahead = new Date(T0.getTime() + 60 * DAY);
    licenceService.status(ahead);
    const db2 = openMigrated();
    const seenFromMarker = licenceService.init(db2, DEVICE, T0, file);
    expect(seenFromMarker.clockSuspect).toBe(true);
    expect(getSettingRaw(db2, LICENCE_SETTING_LAST_SEEN)).toBe(ahead.toISOString());
    // The owner says the clock is right now.
    const fixed = licenceService.resetClock('owner-1', T0);
    expect(fixed.clockSuspect).toBe(false);
    expect(getSettingRaw(db2, LICENCE_SETTING_LAST_SEEN)).toBe(T0.toISOString());
    expect(licenceService.status(T0).clockSuspect).toBe(false);
  });

  it('an unwritable marker never stops the till: the settings alone decide', () => {
    const d = mkdtempSync(join(tmpdir(), 'coc-licence-marker-'));
    roots.push(d);
    const notADir = join(d, 'file-not-folder');
    rmSync(notADir, { force: true });
    writeFileSync(notADir, 'x');
    const db = openMigrated();
    const s = licenceService.init(db, DEVICE, T0, join(notADir, 'inside', 'licence-marker.json'));
    expect(s.state).toBe('trial');
    expect(s.daysLeft).toBe(30);
  });
});
