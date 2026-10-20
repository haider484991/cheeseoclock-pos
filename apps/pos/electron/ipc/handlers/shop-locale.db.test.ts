/**
 * The shop's country through the real handlers, against a real SQLite built
 * from every migration (the harness is system-handlers.db.test.ts's):
 *   - Cheese O'Clock's setup sends no country and stores none: its tills read
 *     as Pakistan, and the process runs as DEFAULT_SHOP_LOCALE itself;
 *   - a Pixel & Oak setup for a US shop stores the choice with its sync and
 *     audit rows, in setup's own transaction, and the process runs as the US
 *     from that moment;
 *   - a country or zone that does not fit is refused before anything at all
 *     is written — no owner, no branding, no half-set-up till;
 *   - the country locks once the till has taken an order.
 * Every name and secret is made up.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Real argon2id for the owner's secret: seconds on a slow CI runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

type Handler = (ctx: unknown, payload: unknown) => Promise<unknown>;
const registered = vi.hoisted(() => new Map<string, Handler>());

vi.mock('../registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      registered.set(channel, fn);
    },
  };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const userData = mkdtempSync(joinPath(tmpdir(), 'coc-setup-test-'));
  return {
    BrowserWindow: { getAllWindows: () => [] },
    safeStorage: { isEncryptionAvailable: () => false },
    app: { getPath: () => userData, getVersion: () => '0.0.0-test', isPackaged: false },
  };
});

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
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb })
      .DatabaseSync;
  } catch {
    return null;
  }
})();

/** better-sqlite3's `db.transaction(fn)`: BEGIN at the outside, SAVEPOINTs inside. */
function withTransactions(raw: RawDb) {
  let depth = 0;
  return {
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
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

function makeDb() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return { raw, db: withTransactions(raw) as never };
}

/** The Website step's answers (made up). */
const WEBSITE = {
  phone: ' 0300 1112233 ',
  whatsapp: '0321 4445566',
  street: 'Plot 9, Test Street, Test Block 2',
  areaLine: 'Test Town, Karachi',
  postalCode: '75999',
  priceRange: 'PKR 100–900',
  opens: '12:00',
  closes: '00:00',
  days: ['sun', 'tue', 'wed', 'thu', 'fri', 'sat'],
  pickup: { offered: false, percent: 15 },
};

const setup = (pin: string, more: Record<string, unknown> = {}) => ({
  storeName: 'Test Pizza',
  storeTagline: 'Hot and fresh',
  taxCategories: [{ name: 'Sales tax', rateBps: 825 }],
  website: WEBSITE,
  admin: { fullName: 'Owner', pin },
  ...more,
});

describe.skipIf(!Sqlite)('the shop locale through setup and system:getShopLocale', () => {
  const load = async () => {
    const { registerSystemHandlers } = await import('./system-handlers.js');
    const shared = await import('@cheeseoclock/shared-types');
    shared.resetShopLocale();
    const { raw, db } = makeDb();
    registerSystemHandlers({ db, deviceId: 'dev-A' } as never);
    return {
      raw,
      shared,
      complete: registered.get('system:completeOnboarding')!,
      getLocale: registered.get('system:getShopLocale')!,
      count: (sql: string) => Number(raw.prepare(sql).get()?.n ?? 0),
    };
  };

  it("Cheese O'Clock's setup stores no country, and the till is Pakistan", async () => {
    const { shared, complete, getLocale, count } = await load();
    await complete({}, setup('2580'));
    expect(count(`SELECT COUNT(*) AS n FROM business_settings WHERE key = 'shop.locale'`)).toBe(0);
    const answer = (await getLocale({}, undefined)) as { data: { country: string; timeZone: string; locked: boolean } };
    expect(answer.data).toEqual({ country: 'PK', timeZone: 'Asia/Karachi', locked: false });
    expect(shared.getShopLocale()).toBe(shared.DEFAULT_SHOP_LOCALE);
  });

  it('a US setup stores the choice with its sync and audit rows, and the till runs as the US', async () => {
    const { raw, shared, complete, getLocale, count } = await load();
    await complete({}, setup('2580', { shopLocale: { country: 'US', timeZone: 'America/Chicago' } }));

    const row = raw.prepare(`SELECT value_json FROM business_settings WHERE key = 'shop.locale'`).get();
    expect(JSON.parse(String(row?.value_json))).toEqual({ v: 1, country: 'US', timeZone: 'America/Chicago' });
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE payload_json LIKE '%shop.locale%'`)).toBeGreaterThan(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE after_json LIKE '%America/Chicago%'`)).toBeGreaterThan(0);

    const answer = (await getLocale({}, undefined)) as { data: { country: string; timeZone: string } };
    expect(answer.data.country).toBe('US');
    expect(answer.data.timeZone).toBe('America/Chicago');
    expect(shared.getShopLocale().currency).toBe('USD');
    expect(shared.getShopLocale().timeZone).toBe('America/Chicago');
    expect(shared.formatCents(400_000)).toBe('$4,000');
    shared.resetShopLocale();
  });

  it('refuses a country or zone that does not fit before anything is written', async () => {
    const { shared, complete, count } = await load();
    const nothingWritten = () => ({
      users: count(`SELECT COUNT(*) AS n FROM users`),
      business: count(`SELECT COUNT(*) AS n FROM business_settings`),
      settings: count(`SELECT COUNT(*) AS n FROM settings`),
    });
    const before = nothingWritten();
    for (const shopLocale of [
      { country: 'GB', timeZone: 'Europe/London' },
      { country: 'US', timeZone: 'Europe/London' },
      { country: 'PK', timeZone: 'America/Chicago' },
    ]) {
      await expect(complete({}, setup('2580', { shopLocale }))).rejects.toThrow();
      expect(nothingWritten(), JSON.stringify(shopLocale)).toEqual(before);
    }
    expect(shared.getShopLocale()).toBe(shared.DEFAULT_SHOP_LOCALE);
  });

  it('locks the country once the till has taken an order', async () => {
    const { raw, complete, getLocale } = await load();
    await complete({}, setup('2580', { shopLocale: { country: 'US', timeZone: 'America/Denver' } }));
    const locked = async () => ((await getLocale({}, undefined)) as { data: { locked: boolean } }).data.locked;
    expect(await locked()).toBe(false);

    const owner = raw.prepare(`SELECT id FROM users LIMIT 1`).get();
    const now = new Date().toISOString();
    raw.prepare(
      `INSERT INTO orders (id, order_number, mode, cashier_id, created_at, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('o-1', '0001', 'takeaway', String(owner?.id), now, now, 'dev-A');
    expect(await locked()).toBe(true);
    (await import('@cheeseoclock/shared-types')).resetShopLocale();
  });
});
