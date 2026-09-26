/**
 * First-time setup through the real `system:completeOnboarding` handler,
 * against a real SQLite database built from every migration:
 *   - the owner's name and PIN or password are checked before anything is
 *     written (a bad PIN once saved the branding and tax, and each retry
 *     added the tax categories again);
 *   - the owner, branding and tax land together or not at all;
 *   - it runs once.
 * The repository mechanism is tested in auth-service.db.test.ts; this pins
 * the handler's wiring, so moving a write back above createUser fails here.
 *
 * Only `defineHandler` is replaced (it captures the handler instead of
 * registering it with Electron); the handler body, createUser, the branding
 * and tax repositories are the real ones. better-sqlite3 is built for
 * Electron's ABI, so this uses `node:sqlite` with a small `transaction()`
 * shim and skips itself where node:sqlite is missing. Every name and secret
 * is made up.
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

const setup = (pin: string, more: Record<string, unknown> = {}) => ({
  storeName: 'Test Pizza',
  storeTagline: 'Hot and fresh',
  taxCategories: [
    { name: 'GST', rateBps: 1600 },
    { name: '  ', rateBps: 0 }, // a blank row on the form: skipped
    { name: 'Card', rateBps: 500 },
  ],
  admin: { fullName: 'Owner', pin },
  ...more,
});

describe.skipIf(!Sqlite)('first-time setup through system:completeOnboarding', () => {
  it('checks the owner first, then writes owner, branding and tax together — once', async () => {
    const { registerSystemHandlers } = await import('./system-handlers.js');
    const { BRANDING_KEY } = await import('../../services/printer-config.js');
    const { verifyAuditChain } = await import('../../db/audit-chain.js');
    const { raw, db } = makeDb();
    const ctx = { db, deviceId: 'dev-A' };
    registerSystemHandlers(ctx as never);
    const complete = registered.get('system:completeOnboarding')!;
    expect(complete).toBeTypeOf('function');

    const count = (sql: string) => Number(raw.prepare(sql).get()?.n ?? 0);
    const snapshot = () => ({
      users: count(`SELECT COUNT(*) AS n FROM users`),
      tax: count(`SELECT COUNT(*) AS n FROM tax_categories`),
      branding: count(`SELECT COUNT(*) AS n FROM settings WHERE key = '${BRANDING_KEY}'`),
      settings: count(`SELECT COUNT(*) AS n FROM settings`),
      sync: count(`SELECT COUNT(*) AS n FROM sync_queue`),
      audit: count(`SELECT COUNT(*) AS n FROM audit_log`),
    });
    const empty = snapshot();
    expect(empty.users).toBe(0);

    // A PIN or name that breaks the rules is refused before anything is written.
    await expect(complete(ctx, setup('12'))).rejects.toMatchObject({
      apiError: { code: 'validation_failed', message: 'A PIN is 4 to 12 numbers' },
    });
    await expect(complete(ctx, setup('abc'))).rejects.toMatchObject({
      apiError: { code: 'validation_failed', message: 'A password is at least 6 characters' },
    });
    await expect(
      complete(ctx, setup('Owner pass 1', { admin: { fullName: '   ', pin: 'Owner pass 1' } })),
    ).rejects.toMatchObject({ apiError: { code: 'validation_failed', message: 'Type your name' } });
    expect(snapshot()).toEqual(empty);

    // Something failing after the owner is written takes the owner back out,
    // and the branding and tax written before it.
    await expect(complete(ctx, setup('Owner pass 1', { storeName: undefined }))).rejects.toThrow();
    expect(snapshot()).toEqual(empty);

    // Then a good one: one owner, the branding, the two named tax rates.
    await expect(complete(ctx, setup(' Owner pass 1 '))).resolves.toMatchObject({ ok: true });
    const done = snapshot();
    expect(done.users).toBe(1);
    expect(done.tax).toBe(empty.tax + 2);
    expect(done.branding).toBe(1);
    const branding = JSON.parse(
      String(raw.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(BRANDING_KEY)?.value_json),
    ) as Record<string, unknown>;
    expect(branding).toMatchObject({ storeName: 'Test Pizza', storeTagline: 'Hot and fresh' });
    expect(raw.prepare(`SELECT role, secret_kind FROM users`).get()).toEqual({
      role: 'admin',
      secret_kind: 'password',
    });

    // A second run is refused and adds nothing — no second owner, no tax twice.
    await expect(complete(ctx, setup('Other pass 2'))).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: 'Setup is already complete' },
    });
    expect(snapshot()).toEqual(done);

    // The rolled-back attempt left no gap in the audit trail.
    const rows = raw
      .prepare(
        `SELECT rowid, id, entity_type, entity_id, action, actor_user_id, before_json, after_json,
                ip, created_at, prev_hash, row_hash
           FROM audit_log ORDER BY rowid`,
      )
      .all()
      .map((r) => ({
        rowid: Number(r.rowid),
        id: String(r.id),
        entityType: String(r.entity_type),
        entityId: String(r.entity_id),
        action: String(r.action),
        actorUserId: (r.actor_user_id as string | null) ?? null,
        beforeJson: (r.before_json as string | null) ?? null,
        afterJson: (r.after_json as string | null) ?? null,
        ip: (r.ip as string | null) ?? null,
        createdAt: String(r.created_at),
        prevHash: (r.prev_hash as string | null) ?? null,
        rowHash: (r.row_hash as string | null) ?? null,
      }));
    expect(rows.length).toBeGreaterThan(0);
    expect(verifyAuditChain(rows)).toMatchObject({ ok: true, brokenAt: null });
  });
});
