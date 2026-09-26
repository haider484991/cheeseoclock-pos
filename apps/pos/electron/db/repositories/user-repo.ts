import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { hashPin, verifyPin } from '../../services/password.js';
import {
  assertSecretInUseNotLocked,
  oneSecretCheckAtATime,
  recordSecretInUse,
} from '../../services/login-attempts.js';
import { writeAudit } from './audit-repo.js';
import { enqueueSync } from './sync-repo.js';
import { PIN_NOT_SHARED } from './apply-remote.js';
import { normalizeSecret, secretKindOf, secretProblem } from '@cheeseoclock/shared-schemas';
import type { Role, SecretKind, User } from '@cheeseoclock/shared-types';

interface UserRow {
  id: string;
  full_name: string;
  pin_hash: string;
  /** 'pin' or 'password' (0027). Local-only, like pin_hash, and written with it. */
  secret_kind: SecretKind;
  role: Role;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
  device_id: string;
  version: number;
}

const USER_COLUMNS = `id, full_name, pin_hash, secret_kind, role, is_active, last_login_at,
              created_at, updated_at, synced_at, deleted_at, device_id, version`;

function rowToUser(row: UserRow): User {
  return {
    id: row.id as User['id'],
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Made on the other till: no PIN or password here yet, whatever the column says.
    secretKind: row.pin_hash === PIN_NOT_SHARED ? null : row.secret_kind,
  };
}

export function listUsers(db: AppDatabase): User[] {
  const rows = db
    .prepare(
      `SELECT ${USER_COLUMNS}
         FROM users
        WHERE deleted_at IS NULL
        ORDER BY full_name`,
    )
    .all() as UserRow[];
  return rows.map(rowToUser);
}

export function findUserById(db: AppDatabase, id: string): User | null {
  const row = db
    .prepare(
      `SELECT ${USER_COLUMNS}
         FROM users
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

interface InternalUser extends User {
  pinHash: string;
  version: number;
  deviceId: string;
}

function rowToInternal(row: UserRow): InternalUser {
  return {
    ...rowToUser(row),
    pinHash: row.pin_hash,
    version: row.version,
    deviceId: row.device_id,
  };
}

/**
 * A new PIN or password, checked against the one set of rules and
 * normalized (surrounding spaces dropped, Urdu digits as 0-9) — what gets
 * hashed. Every caller comes through here: users create/update, first-time
 * setup and the dev seed. The refusal is a plain-words Error for the screen.
 */
function requireSecret(raw: string): { secret: string; kind: SecretKind } {
  const problem = secretProblem(raw);
  if (problem !== null) throw new Error(problem);
  const secret = normalizeSecret(raw);
  return { secret, kind: secretKindOf(secret) };
}

/**
 * The active user whose PIN or password this is, or null. Only hashes of the
 * typed kind are checked (digits only = a PIN; a password always has a
 * letter), all at once: argon2 runs off the main thread (libuv pool, four at
 * a time), and checking them one after another made every entry (login, the
 * idle-lock unlock, each manager approval) wait for the sum — ~100-200 ms a
 * user on a till-class CPU, over a second with a full staff list or a wrong
 * PIN. First match in row order, as before. Fine for tens of users; with
 * hundreds, ask who is signing in first.
 */
export async function findUserBySecret(
  db: AppDatabase,
  secret: string,
): Promise<InternalUser | null> {
  const typed = normalizeSecret(secret);
  const rows = db
    .prepare(
      `SELECT ${USER_COLUMNS}
         FROM users
        WHERE deleted_at IS NULL AND is_active = 1 AND secret_kind = ?`,
    )
    .all(secretKindOf(typed)) as UserRow[];
  const matches = await Promise.all(rows.map((row) => verifyPin(typed, row.pin_hash)));
  const hit = matches.findIndex(Boolean);
  return hit >= 0 ? rowToInternal(rows[hit]!) : null;
}

const PIN_IN_USE = 'That PIN is already used by someone else — choose another';
const PASSWORD_IN_USE = 'That password is already used by someone else — choose another';

/**
 * The PIN or password is how the till tells people apart, so no two users
 * may share one. With a shared PIN the login took whichever matched first — a
 * new cashier given the manager's 1111 became the manager (audit
 * 2026-09-25). Inactive users count too: switching one back on must not
 * create a clash. A PIN and a password can never be equal, so only hashes of
 * the same kind are compared, all at once.
 *
 * A clash also tells whoever typed it that someone has that secret, so it is
 * written to the audit trail (without saying whose it was) and counted on
 * its own brake: five clashes in 15 minutes pause saving new PINs and
 * passwords for 30 s, ten for 5 min. It is NOT a wrong sign-in guess — the
 * owner typed it, not the person who has it — so it never locks that
 * person's PIN or the till's sign-in (review 2026-09-26: counting it did
 * both). Runs inside oneSecretCheckAtATime, so nobody can take the secret
 * between this check and the write.
 */
async function assertSecretFree(
  db: AppDatabase,
  secret: string,
  kind: SecretKind,
  who: { targetUserId: string | null; actorUserId: string | null },
): Promise<void> {
  assertSecretInUseNotLocked(db);
  const rows = db
    .prepare(`SELECT id, pin_hash FROM users WHERE deleted_at IS NULL AND secret_kind = ?`)
    .all(kind) as Array<{ id: string; pin_hash: string }>;
  const others = rows.filter((r) => r.id !== who.targetUserId);
  const matches = await Promise.all(others.map((r) => verifyPin(secret, r.pin_hash)));
  if (!matches.some(Boolean)) return;
  db.transaction(() => {
    recordSecretInUse(db);
    writeAudit(db, {
      entityType: 'users',
      entityId: who.targetUserId ?? 'new-user',
      action: 'secret_in_use_refused',
      actorUserId: who.actorUserId,
      before: null,
      after: { kind },
    });
  })();
  throw new Error(kind === 'pin' ? PIN_IN_USE : PASSWORD_IN_USE);
}

function countUsers(db: AppDatabase): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`).get() as { n: number }).n;
}

export const SETUP_ALREADY_COMPLETE = 'Setup is already complete';

export async function createUser(
  db: AppDatabase,
  input: { fullName: string; role: Role; pin: string },
  actor: { userId: string | null; deviceId: string },
  opts: {
    /**
     * First-time setup: refuse if anyone exists by the time this runs (two
     * setup calls at once must not make two owners).
     */
    firstUserOnly?: boolean;
    /** More writes that must land with the user or not at all (setup's branding and tax). */
    inSameTransaction?: () => void;
  } = {},
): Promise<User> {
  const { secret, kind } = requireSecret(input.pin);
  return oneSecretCheckAtATime(async () => {
    if (opts.firstUserOnly && countUsers(db) > 0) throw new Error(SETUP_ALREADY_COMPLETE);
    await assertSecretFree(db, secret, kind, { targetUserId: null, actorUserId: actor.userId });
    const pinHash = await hashPin(secret);
    const id = uuidv7();
    const now = new Date().toISOString();

    const newUser: User = {
      id: id as User['id'],
      fullName: input.fullName,
      role: input.role,
      isActive: true,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
      secretKind: kind,
    };

    const tx = db.transaction(() => {
      if (opts.firstUserOnly && countUsers(db) > 0) throw new Error(SETUP_ALREADY_COMPLETE);
      db.prepare(
        `INSERT INTO users
           (id, full_name, pin_hash, secret_kind, role, is_active, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
      ).run(id, input.fullName, pinHash, kind, input.role, now, now, actor.deviceId);

      enqueueSync(db, {
        entityType: 'users',
        entityId: id,
        op: 'upsert',
        payload: newUser,
      });

      writeAudit(db, {
        entityType: 'users',
        entityId: id,
        action: 'create',
        actorUserId: actor.userId,
        before: null,
        after: { ...newUser, pinHash: '<redacted>' },
      });

      opts.inSameTransaction?.();
    });
    tx();

    log.info('User created', { id, role: input.role, secretKind: kind });
    return newUser;
  });
}

/**
 * Refuse a change that would leave the device with no active admin — there
 * would be nobody left who can manage users, restore backups, or undo it.
 * Call inside the write transaction so the count and the write are one unit.
 */
function assertNotLastActiveAdmin(db: AppDatabase, exceptId: string): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE role = 'admin' AND is_active = 1 AND deleted_at IS NULL AND id != ?`,
    )
    .get(exceptId) as { n: number };
  if (row.n === 0) throw new Error('Cannot remove the last admin');
}

export async function updateUser(
  db: AppDatabase,
  input: {
    id: string;
    fullName?: string;
    role?: Role;
    isActive?: boolean;
    /** A new PIN or password: replaces the hash and its kind together. */
    pin?: string;
  },
  actor: { userId: string | null; deviceId: string },
): Promise<User> {
  const next = input.pin ? requireSecret(input.pin) : null;
  return oneSecretCheckAtATime(async () => {
    const existingRow = db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`)
      .get(input.id) as UserRow | undefined;

    if (!existingRow) throw new Error('User not found');

    const fullName = input.fullName ?? existingRow.full_name;
    const role = input.role ?? existingRow.role;
    const isActive = input.isActive ?? existingRow.is_active === 1;
    if (next) {
      await assertSecretFree(db, next.secret, next.kind, {
        targetUserId: existingRow.id,
        actorUserId: actor.userId,
      });
    }
    const pinHash = next ? await hashPin(next.secret) : existingRow.pin_hash;
    const secretKind = next ? next.kind : existingRow.secret_kind;
    const now = new Date().toISOString();
    const nextVersion = existingRow.version + 1;

    const updated: User = {
      id: existingRow.id as User['id'],
      fullName,
      role,
      isActive,
      lastLoginAt: existingRow.last_login_at,
      createdAt: existingRow.created_at,
      updatedAt: now,
      secretKind: next ? next.kind : rowToUser(existingRow).secretKind,
    };

    const wasActiveAdmin = existingRow.role === 'admin' && existingRow.is_active === 1;
    const staysActiveAdmin = role === 'admin' && isActive;

    const tx = db.transaction(() => {
      if (wasActiveAdmin && !staysActiveAdmin) assertNotLastActiveAdmin(db, input.id);

      // The hash and its kind only ever change together (both local-only).
      db.prepare(
        `UPDATE users
            SET full_name = ?, role = ?, is_active = ?, pin_hash = ?, secret_kind = ?,
                updated_at = ?, version = ?
          WHERE id = ?`,
      ).run(fullName, role, isActive ? 1 : 0, pinHash, secretKind, now, nextVersion, input.id);

      enqueueSync(db, {
        entityType: 'users',
        entityId: input.id,
        op: 'upsert',
        payload: updated,
      });

      writeAudit(db, {
        entityType: 'users',
        entityId: input.id,
        action: 'update',
        actorUserId: actor.userId,
        before: rowToUser(existingRow),
        // The trail shows that a PIN or password was changed, and by whom — never what to.
        after: next ? { ...updated, secretChanged: true } : updated,
      });
    });
    tx();

    return updated;
  });
}

export function deactivateUser(
  db: AppDatabase,
  id: string,
  actor: { userId: string | null; deviceId: string },
): void {
  const existingRow = db
    .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    .get(id) as UserRow | undefined;
  if (!existingRow) throw new Error('User not found');

  // Switched OFF, not deleted (2026-09-26): this used to set deleted_at too, so
  // a deactivated user vanished from Users and could never be switched back on.
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    if (existingRow.role === 'admin' && existingRow.is_active === 1) {
      assertNotLastActiveAdmin(db, id);
    }
    db.prepare(
      `UPDATE users SET is_active = 0, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(now, id);
    const after = rowToUser(
      db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow,
    );
    enqueueSync(db, {
      entityType: 'users',
      entityId: id,
      op: 'upsert',
      payload: after,
    });
    writeAudit(db, {
      entityType: 'users',
      entityId: id,
      action: 'update',
      actorUserId: actor.userId,
      before: rowToUser(existingRow),
      after,
    });
  });
  tx();
}

export function touchUserLogin(db: AppDatabase, id: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

const SEED_PIN = '1234';
const MANAGER_PIN = '5678';
const ADMIN_PIN = '9999';

export function ensureSeedUsers(db: AppDatabase, deviceId: string): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (count.c > 0) return;

  log.info('Seeding initial users (dev only)');
  void Promise.all([
    createUser(db, { fullName: 'Admin', role: 'admin', pin: ADMIN_PIN }, { userId: null, deviceId }),
    createUser(db, { fullName: 'Manager', role: 'manager', pin: MANAGER_PIN }, { userId: null, deviceId }),
    createUser(db, { fullName: 'Cashier', role: 'cashier', pin: SEED_PIN }, { userId: null, deviceId }),
  ]).catch((err) => log.error('Failed to seed users', err));
}
