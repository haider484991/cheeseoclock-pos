/**
 * Signing in with a number PIN or a password, against a real SQLite database
 * built from every migration (0027 included) and real argon2id hashes:
 *   - a till upgraded from a PIN-only version keeps signing everyone in;
 *   - PINs of 4-12 digits and passwords both sign in and approve as manager;
 *   - no two people may share a PIN or a password (inactive ones included);
 *   - the lockout still counts every wrong guess, and never files one under
 *     a digest a copy of the database could reverse;
 *   - the kind of secret, like its hash, never leaves this till;
 *   - first-time setup makes one owner, with branding and tax, or nothing.
 *
 * better-sqlite3 here is built for Electron's ABI and will not open under
 * plain node, so this uses node's own `node:sqlite` (Node 22.5+), with a
 * small `transaction()` shim in better-sqlite3's shape, and skips itself
 * where node:sqlite is missing. Every name and secret is made up.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncChange } from '@cheeseoclock/sync-core';

// Real argon2id (19 MiB, t=2) for every user made here: seconds on a slow CI
// runner, well past the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const userData = mkdtempSync(joinPath(tmpdir(), 'coc-auth-test-'));
  return {
    BrowserWindow: { getAllWindows: () => [] },
    safeStorage: { isEncryptionAvailable: () => false },
    app: { getPath: () => userData },
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

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const MIGRATION_FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** A fresh in-memory till, migrated up to (not including) `before` when given. */
function makeDb(before?: string) {
  const raw = new Sqlite!(':memory:');
  for (const f of MIGRATION_FILES) {
    if (before && f >= before) break;
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return { raw, db: withTransactions(raw) as never };
}

function migrate(raw: RawDb, name: string): void {
  raw.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
}

const mods = async () => ({
  ...(await import('./auth-service.js')),
  ...(await import('./login-attempts.js')),
  ...(await import('./password.js')),
  ...(await import('../db/repositories/user-repo.js')),
  ...(await import('../db/repositories/apply-remote.js')),
  ...(await import('../db/replicable-schema.js')),
  ...(await import('@cheeseoclock/shared-schemas')),
});

const actor = { userId: null, deviceId: 'dev-A' };
const T0 = '2026-09-26T08:00:00.000Z';

function n(raw: RawDb, sql: string, ...p: unknown[]): number {
  return Number(raw.prepare(sql).get(...p)?.n ?? 0);
}

describe.skipIf(!Sqlite)('an upgraded till (PINs stored before 0027)', () => {
  it('signs everyone in as before, and shows them as PIN users', async () => {
    const m = await mods();
    const { raw, db } = makeDb('0027');
    const insert = raw.prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, 'dev-A')`,
    );
    insert.run('u-admin', 'Owner', await m.hashPin('9999'), 'admin', T0, T0);
    insert.run('u-cash', 'Cashier Eight', await m.hashPin('12345678'), 'cashier', T0, T0);
    insert.run('u-remote', 'From Till B', m.PIN_NOT_SHARED, 'cashier', T0, T0);
    migrate(raw, '0027_user_secret_kind.sql');

    expect(raw.prepare(`SELECT secret_kind FROM users WHERE id = 'u-admin'`).get()?.secret_kind).toBe('pin');
    expect((await m.login(db, '9999', 'dev-A')).id).toBe('u-admin');
    expect((await m.login(db, ' 12345678 ', 'dev-A')).id).toBe('u-cash');
    expect((await m.verifyManagerPin(db, '9999')).approverUserId).toBe('u-admin');

    const kinds = Object.fromEntries(m.listUsers(db).map((u) => [u.id, u.secretKind]));
    expect(kinds).toEqual({ 'u-admin': 'pin', 'u-cash': 'pin', 'u-remote': null });
  });

  it('refuses a bad secret_kind', () => {
    const { raw } = makeDb();
    expect(() =>
      raw
        .prepare(
          `INSERT INTO users (id, full_name, pin_hash, secret_kind, role, created_at, updated_at, device_id)
           VALUES ('x', 'X', 'x', 'passphrase', 'cashier', ?, ?, 'dev-A')`,
        )
        .run(T0, T0),
    ).toThrow(/CHECK/i);
  });
});

describe.skipIf(!Sqlite)('signing in with a PIN or a password', () => {
  const till = Sqlite ? makeDb() : null;
  const raw = till?.raw as RawDb;
  const db = till?.db as never;
  const ids: Record<string, string> = {};

  beforeEach(() => raw.exec('DELETE FROM login_attempts'));

  it('makes a 5-digit PIN user, a 12-digit PIN user and password users', async () => {
    const m = await mods();
    const make = async (fullName: string, role: 'admin' | 'manager' | 'cashier', typed: string) =>
      (await m.createUser(db, m.createUserInputSchema.parse({ fullName, role, pin: typed }), actor)).id;
    ids['five'] = await make('Five Digits', 'cashier', '24680');
    ids['twelve'] = await make('Twelve Digits', 'cashier', '135791357913');
    ids['owner'] = await make('Owner', 'admin', ' Owner pass 1 ');
    ids['manager'] = await make('Manager', 'manager', 'Manager pass 2');
    ids['cashier'] = await make('Cashier', 'cashier', 'Cashier pass 3');

    const kindOf = (id: string) => raw.prepare(`SELECT secret_kind FROM users WHERE id = ?`).get(id)?.secret_kind;
    expect(kindOf(ids['five']!)).toBe('pin');
    expect(kindOf(ids['twelve']!)).toBe('pin');
    expect(kindOf(ids['owner']!)).toBe('password');
    const listed = Object.fromEntries(m.listUsers(db).map((u) => [u.fullName, u.secretKind]));
    expect(listed).toMatchObject({ 'Five Digits': 'pin', Owner: 'password', Manager: 'password' });
    // Only argon2id hashes are kept, never what was typed.
    const hashes = raw.prepare(`SELECT pin_hash FROM users`).all().map((r) => String(r.pin_hash));
    expect(hashes.every((h) => h.startsWith('$argon2id$'))).toBe(true);
  });

  it('signs in with a 5-digit PIN (as always) and a 12-digit one', async () => {
    const m = await mods();
    expect((await m.login(db, '24680', 'dev-A')).id).toBe(ids['five']);
    expect((await m.login(db, '135791357913', 'dev-A')).id).toBe(ids['twelve']);
  });

  it('signs in with a password, trimmed; capital and small letters count', async () => {
    const m = await mods();
    const typed = m.loginInputSchema.parse({ pin: '  Owner pass 1 ' }).pin;
    const session = await m.login(db, typed, 'dev-A');
    expect(session).toMatchObject({ id: ids['owner'], role: 'admin' });
    await expect(m.login(db, 'owner pass 1', 'dev-A')).rejects.toThrow(m.WRONG_SECRET);
    await expect(m.login(db, 'OWNER PASS 1', 'dev-A')).rejects.toThrow('PIN or password is wrong');
  });

  it('approves as manager with a password; refuses a cashier and a wrong one alike', async () => {
    const m = await mods();
    expect(await m.verifyManagerPin(db, 'Manager pass 2')).toEqual({
      approverUserId: ids['manager'],
      approverName: 'Manager',
    });
    expect((await m.verifyManagerPin(db, ' Owner pass 1')).approverUserId).toBe(ids['owner']);
    // A cashier's real password and a wrong one get the same answer: the
    // screen must not confirm that a string is someone's password.
    await expect(m.verifyManagerPin(db, 'Cashier pass 3')).rejects.toThrow(m.NOT_A_MANAGER);
    await expect(m.verifyManagerPin(db, 'Nobody pass 9')).rejects.toThrow(m.NOT_A_MANAGER);
    await expect(m.verifyManagerPin(db, '24680')).rejects.toThrow(m.NOT_A_MANAGER);
    // Both were counted as wrong guesses.
    expect(n(raw, `SELECT failed_count AS n FROM login_attempts WHERE pin_hash = '__device__'`)).toBe(3);
  });

  it('refuses a secret that breaks the rules without counting it or hashing it', async () => {
    const m = await mods();
    await expect(m.login(db, '12', 'dev-A')).rejects.toThrow('A PIN is 4 to 12 numbers');
    await expect(m.login(db, 'abc', 'dev-A')).rejects.toThrow('A password is at least 6 characters');
    await expect(m.login(db, undefined as unknown as string, 'dev-A')).rejects.toThrow('Type a PIN or password');
    // orders:refund once passed a missing approver PIN straight through.
    await expect(m.verifyManagerPin(db, undefined as unknown as string)).rejects.toThrow('Type a PIN or password');
    expect(n(raw, `SELECT COUNT(*) AS n FROM login_attempts`)).toBe(0);
  });

  it('refuses a PIN or password someone else already has — even someone switched off', async () => {
    const m = await mods();
    const auditBefore = n(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret_in_use_refused'`);
    await expect(
      m.createUser(db, { fullName: 'Copycat', role: 'cashier', pin: 'Manager pass 2' }, actor),
    ).rejects.toThrow('That password is already used by someone else — choose another');
    await expect(m.createUser(db, { fullName: 'Copycat', role: 'cashier', pin: '24680' }, actor)).rejects.toThrow(
      'That PIN is already used by someone else — choose another',
    );
    await expect(m.updateUser(db, { id: ids['cashier']!, pin: ' Owner pass 1 ' }, actor)).rejects.toThrow(
      'That password is already used',
    );

    await m.updateUser(db, { id: ids['twelve']!, isActive: false }, actor);
    await expect(
      m.createUser(db, { fullName: 'Copycat', role: 'cashier', pin: '135791357913' }, actor),
    ).rejects.toThrow('That PIN is already used');

    // Saving your own current secret again is fine.
    await expect(m.updateUser(db, { id: ids['cashier']!, pin: 'Cashier pass 3' }, actor)).resolves.toMatchObject({
      secretKind: 'password',
    });
    expect(n(raw, `SELECT COUNT(*) AS n FROM users WHERE full_name = 'Copycat'`)).toBe(0);
    // Each clash is counted on its own brake and leaves a trace, never saying
    // whose it was. It is not a wrong sign-in guess: no sign-in counter moves.
    expect(n(raw, `SELECT failed_count AS n FROM login_attempts WHERE pin_hash = ?`, m.SECRET_IN_USE_ATTEMPTS_KEY)).toBe(4);
    expect(n(raw, `SELECT COUNT(*) AS n FROM login_attempts WHERE pin_hash != ?`, m.SECRET_IN_USE_ATTEMPTS_KEY)).toBe(0);
    const refusals = raw
      .prepare(`SELECT after_json FROM audit_log WHERE action = 'secret_in_use_refused' ORDER BY rowid`)
      .all()
      .slice(auditBefore)
      .map((r) => JSON.parse(String(r.after_json)) as unknown);
    expect(refusals).toEqual([{ kind: 'password' }, { kind: 'pin' }, { kind: 'password' }, { kind: 'pin' }]);
  });

  it('clashes on the Users page never lock the person who has that PIN, or the till', async () => {
    const m = await mods();
    // The owner keeps picking 24680, which "Five Digits" already has.
    for (let i = 0; i < 5; i += 1) {
      await expect(m.createUser(db, { fullName: 'Copycat', role: 'cashier', pin: '24680' }, actor)).rejects.toThrow(
        'That PIN is already used',
      );
    }
    // Saving new PINs and passwords is paused for a moment…
    await expect(m.createUser(db, { fullName: 'Copycat', role: 'cashier', pin: '24680' }, actor)).rejects.toThrow(
      /^Too many PINs or passwords that are already used\. Try again in \d+s\.$/,
    );
    await expect(m.updateUser(db, { id: ids['cashier']!, pin: 'Fresh pass 8' }, actor)).rejects.toThrow(
      /Too many PINs or passwords/,
    );
    // …but nothing else is: other edits still save, the holder of 24680 signs
    // in, and managers still approve.
    await expect(m.updateUser(db, { id: ids['cashier']!, fullName: 'Cashier' }, actor)).resolves.toMatchObject({
      fullName: 'Cashier',
    });
    expect((await m.login(db, '24680', 'dev-A')).id).toBe(ids['five']);
    expect((await m.verifyManagerPin(db, 'Manager pass 2')).approverUserId).toBe(ids['manager']);
    expect(n(raw, `SELECT COUNT(*) AS n FROM login_attempts WHERE pin_hash != ?`, m.SECRET_IN_USE_ATTEMPTS_KEY)).toBe(0);
    expect(n(raw, `SELECT COUNT(*) AS n FROM users WHERE full_name = 'Copycat'`)).toBe(0);
  });

  it('two saves at once cannot give two people the same password', async () => {
    const m = await mods();
    const both = await Promise.allSettled([
      m.createUser(db, { fullName: 'Twin A', role: 'cashier', pin: 'Twin pass 7' }, actor),
      m.createUser(db, { fullName: 'Twin B', role: 'cashier', pin: 'Twin pass 7' }, actor),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(n(raw, `SELECT COUNT(*) AS n FROM users WHERE full_name LIKE 'Twin %'`)).toBe(1);
  });

  it('changes a PIN to a password: the old one stops, the new one works, sync and audit say so', async () => {
    const m = await mods();
    const id = ids['five']!;
    const syncBefore = n(raw, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`, id);
    const auditBefore = n(raw, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?`, id);

    const updated = await m.updateUser(db, { id, pin: 'Five now words 5' }, { userId: ids['owner']!, deviceId: 'dev-A' });
    expect(updated.secretKind).toBe('password');
    expect(raw.prepare(`SELECT secret_kind FROM users WHERE id = ?`).get(id)?.secret_kind).toBe('password');

    await expect(m.login(db, '24680', 'dev-A')).rejects.toThrow(m.WRONG_SECRET);
    expect((await m.login(db, 'Five now words 5', 'dev-A')).id).toBe(id);

    expect(n(raw, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`, id)).toBe(syncBefore + 1);
    const queued = JSON.parse(
      String(
        raw
          .prepare(`SELECT payload_json FROM sync_queue WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`)
          .get(id)?.payload_json,
      ),
    ) as Record<string, unknown>;
    expect(queued['fullName']).toBe('Five Digits');
    expect(Object.keys(queued)).not.toContain('pinHash');
    expect(Object.keys(queued)).not.toContain('secretKind');

    const audits = raw
      .prepare(`SELECT action, actor_user_id, after_json FROM audit_log WHERE entity_id = ? ORDER BY rowid`)
      .all(id)
      .slice(auditBefore);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'update', actor_user_id: ids['owner'] });
    const after = JSON.parse(String(audits[0]!.after_json)) as Record<string, unknown>;
    expect(after['secretChanged']).toBe(true);
    expect(String(audits[0]!.after_json)).not.toMatch(/argon2|Five now words/);
  });

  it('five wrong passwords lock sign-in, even for the right one', async () => {
    const m = await mods();
    for (const guess of ['Owner pass 2', 'Owner pass 3', 'Owner pass 4', 'Owner pass 5', 'Owner pass 6']) {
      await expect(m.login(db, guess, 'dev-A')).rejects.toThrow(m.WRONG_SECRET);
    }
    await expect(m.login(db, 'Owner pass 1', 'dev-A')).rejects.toThrow(/Too many failed attempts/);
  });

  it('five failed manager approvals lock the sign-in screen too', async () => {
    const m = await mods();
    for (const guess of ['Cashier pass 3', 'Nope pass 1', '11112222', 'Cashier pass 3', 'Nope pass 2']) {
      await expect(m.verifyManagerPin(db, guess)).rejects.toThrow(m.NOT_A_MANAGER);
    }
    await expect(m.login(db, 'Manager pass 2', 'dev-A')).rejects.toThrow(/Too many failed attempts/);
    await expect(m.verifyManagerPin(db, 'Manager pass 2')).rejects.toThrow(/Too many failed attempts/);
  });

  it('guesses sent at the same moment are all counted (no slipping past the lock check)', async () => {
    const m = await mods();
    const guesses = ['Wrong a1', 'Wrong b2', 'Wrong c3', 'Wrong d4', 'Wrong e5', 'Wrong f6', 'Wrong g7'];
    const results = await Promise.allSettled(guesses.map((g) => m.login(db, g, 'dev-A')));
    const messages = results.map((r) => (r.status === 'rejected' ? String((r.reason as Error).message) : 'ok'));
    expect(messages.filter((x) => x === m.WRONG_SECRET)).toHaveLength(5);
    expect(messages.filter((x) => /Too many failed attempts/.test(x))).toHaveLength(2);
    expect(n(raw, `SELECT failed_count AS n FROM login_attempts WHERE pin_hash = '__device__'`)).toBe(5);
  });

  it('never files a guess under a digest a copy of the database could reverse', async () => {
    const m = await mods();
    const guesses = ['Owner pass 9', '98765', 'Cashier pass 3'];
    await m.login(db, 'Owner pass 9', 'dev-A').catch(() => undefined);
    await m.login(db, '98765', 'dev-A').catch(() => undefined);
    // A cashier's CORRECT password typed into a manager box is filed too.
    await m.verifyManagerPin(db, 'Cashier pass 3').catch(() => undefined);
    const keys = raw
      .prepare(`SELECT pin_hash FROM login_attempts WHERE pin_hash != '__device__'`)
      .all()
      .map((r) => String(r.pin_hash));
    expect(keys).toHaveLength(guesses.length);
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    for (const g of guesses) {
      expect(keys).not.toContain(g);
      expect(keys).not.toContain(sha(g));
      expect(keys).not.toContain(sha(`attempts:${g}`)); // the old, unkeyed digest
      expect(keys).toContain(m.attemptsKeyFor(g));
    }
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
    // The key lives next to the database, never in it.
    const { app } = await import('electron');
    expect(existsSync(join(app.getPath('userData'), 'login-attempts.key'))).toBe(true);
  });

  it('forgets per-secret rows nobody has failed on for an hour', async () => {
    const m = await mods();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    raw
      .prepare(`INSERT INTO login_attempts (pin_hash, failed_count, last_failed_at, locked_until) VALUES (?, 3, ?, NULL)`)
      .run('a'.repeat(64), old);
    raw
      .prepare(`INSERT INTO login_attempts (pin_hash, failed_count, last_failed_at, locked_until) VALUES (?, 3, ?, NULL)`)
      .run(createHash('sha256').update('attempts:1234').digest('hex'), old);
    await m.login(db, 'Wrong again 1', 'dev-A').catch(() => undefined);
    expect(n(raw, `SELECT COUNT(*) AS n FROM login_attempts WHERE last_failed_at = ?`, old)).toBe(0);
    expect(n(raw, `SELECT COUNT(*) AS n FROM login_attempts WHERE pin_hash = '__device__'`)).toBe(1);
  });
});

describe.skipIf(!Sqlite)('the kind of secret never leaves this till', () => {
  const image = (payload: Record<string, unknown>, version = 1): SyncChange =>
    ({
      entityType: 'users',
      entityId: String(payload['id']),
      op: 'upsert',
      payload: { __rowImage: 1, ...payload },
      updatedAt: T0,
      deviceId: 'dev-B',
      version,
    }) as SyncChange;

  it('is not in what is sent, not taken from what arrives, and not overwritten', async () => {
    const m = await mods();
    const { raw, db } = makeDb();
    const local = await m.createUser(db, { fullName: 'Local Owner', role: 'admin', pin: 'Local pass 1' }, actor);

    const sent = m.readRowImage(db, 'users', local.id)!;
    expect(sent['fullName']).toBe('Local Owner');
    expect(Object.keys(sent)).not.toContain('secretKind');
    expect(Object.keys(sent)).not.toContain('pinHash');

    const remote = {
      id: 'u-remote',
      fullName: 'Remote Cashier',
      role: 'cashier',
      isActive: 1,
      createdAt: T0,
      updatedAt: T0,
      deviceId: 'dev-B',
      secretKind: 'password',
      pinHash: 'attacker',
    };
    expect(m.applyRemoteChange(db, image(remote)).applied).toBe(true);
    expect(raw.prepare(`SELECT pin_hash, secret_kind FROM users WHERE id = 'u-remote'`).get()).toEqual({
      pin_hash: m.PIN_NOT_SHARED,
      secret_kind: 'pin',
    });
    expect(m.listUsers(db).find((u) => u.id === 'u-remote')?.secretKind).toBeNull();

    // The other till renames our owner and claims a PIN: the name is taken,
    // the password here (hash and kind) is not touched.
    expect(
      m.applyRemoteChange(db, image({ ...remote, id: local.id, fullName: 'Owner Renamed', role: 'admin', secretKind: 'pin' }, 50))
        .applied,
    ).toBe(true);
    const row = raw.prepare(`SELECT full_name, secret_kind, pin_hash FROM users WHERE id = ?`).get(local.id)!;
    expect(row).toMatchObject({ full_name: 'Owner Renamed', secret_kind: 'password' });
    expect(String(row.pin_hash)).toMatch(/^\$argon2id\$/);
    expect((await m.login(db, 'Local pass 1', 'dev-A')).id).toBe(local.id);
  });
});

describe.skipIf(!Sqlite)('first-time setup', () => {
  it('makes one owner with a password, and the setup writes land with it or not at all', async () => {
    const m = await mods();
    const { raw, db } = makeDb();

    // Something in the same transaction fails: no owner is left behind.
    await expect(
      m.createUser(db, { fullName: 'Owner', role: 'admin', pin: 'Setup pass 1' }, actor, {
        firstUserOnly: true,
        inSameTransaction: () => {
          raw.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('test.marker', '1', ?)`).run(T0);
          throw new Error('Branding could not be saved');
        },
      }),
    ).rejects.toThrow('Branding could not be saved');
    expect(n(raw, `SELECT COUNT(*) AS n FROM users`)).toBe(0);
    expect(n(raw, `SELECT COUNT(*) AS n FROM settings WHERE key = 'test.marker'`)).toBe(0);

    // Two setups at once: one owner.
    const both = await Promise.allSettled([
      m.createUser(db, { fullName: 'Owner', role: 'admin', pin: 'Setup pass 1' }, actor, { firstUserOnly: true }),
      m.createUser(db, { fullName: 'Owner Two', role: 'admin', pin: '7777' }, actor, { firstUserOnly: true }),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toContain(m.SETUP_ALREADY_COMPLETE);
    expect(n(raw, `SELECT COUNT(*) AS n FROM users`)).toBe(1);
    expect((await m.login(db, 'Setup pass 1', 'dev-A')).role).toBe('admin');
  });
});
