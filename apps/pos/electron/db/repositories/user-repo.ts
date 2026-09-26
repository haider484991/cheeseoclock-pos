import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { hashPin, verifyPin } from '../../services/password.js';
import { writeAudit } from './audit-repo.js';
import { enqueueSync } from './sync-repo.js';
import type { Role, User } from '@cheeseoclock/shared-types';

interface UserRow {
  id: string;
  full_name: string;
  pin_hash: string;
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

function rowToUser(row: UserRow): User {
  return {
    id: row.id as User['id'],
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listUsers(db: AppDatabase): User[] {
  const rows = db
    .prepare(
      `SELECT id, full_name, pin_hash, role, is_active, last_login_at,
              created_at, updated_at, synced_at, deleted_at, device_id, version
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
      `SELECT id, full_name, pin_hash, role, is_active, last_login_at,
              created_at, updated_at, synced_at, deleted_at, device_id, version
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
 * Linear scan of active users to find one whose PIN matches.
 * Argon2 verify is intentionally slow, so this is fine for tens of users.
 * If we ever grow to hundreds, add a per-user identifier prompt instead.
 */
export async function findUserByPin(
  db: AppDatabase,
  pin: string,
): Promise<InternalUser | null> {
  const rows = db
    .prepare(
      `SELECT id, full_name, pin_hash, role, is_active, last_login_at,
              created_at, updated_at, synced_at, deleted_at, device_id, version
         FROM users
        WHERE deleted_at IS NULL AND is_active = 1`,
    )
    .all() as UserRow[];

  // All hashes at once: argon2 runs off the main thread (libuv pool, four at
  // a time), and checking them one after another made every PIN entry
  // (login, the idle-lock unlock, each manager approval) wait for the sum —
  // ~100-200 ms a user on a till-class CPU, over a second with a full staff
  // list or a wrong PIN. First match in row order, as before.
  const matches = await Promise.all(rows.map((row) => verifyPin(pin, row.pin_hash)));
  const hit = matches.findIndex(Boolean);
  return hit >= 0 ? rowToInternal(rows[hit]!) : null;
}

/**
 * The PIN is how the till tells people apart, so no two users may share one.
 * With a shared PIN `findUserByPin` logged in whichever matched first — a new
 * cashier given the manager's 1111 became the manager (audit 2026-09-25).
 * Inactive users count too: switching one back on must not create a clash.
 */
async function assertPinFree(db: AppDatabase, pin: string, exceptUserId?: string): Promise<void> {
  const rows = db
    .prepare(`SELECT id, pin_hash FROM users WHERE deleted_at IS NULL`)
    .all() as Array<{ id: string; pin_hash: string }>;
  for (const r of rows) {
    if (r.id === exceptUserId) continue;
    if (await verifyPin(pin, r.pin_hash)) {
      throw new Error('That PIN is already used by someone else — choose another');
    }
  }
}

export async function createUser(
  db: AppDatabase,
  input: { fullName: string; role: Role; pin: string },
  actor: { userId: string | null; deviceId: string },
): Promise<User> {
  await assertPinFree(db, input.pin);
  const pinHash = await hashPin(input.pin);
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
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users
         (id, full_name, pin_hash, role, is_active, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)`,
    ).run(id, input.fullName, pinHash, input.role, now, now, actor.deviceId);

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
  });
  tx();

  log.info('User created', { id, role: input.role });
  return newUser;
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
    pin?: string;
  },
  actor: { userId: string | null; deviceId: string },
): Promise<User> {
  const existingRow = db
    .prepare(
      `SELECT id, full_name, pin_hash, role, is_active, last_login_at,
              created_at, updated_at, synced_at, deleted_at, device_id, version
         FROM users WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(input.id) as UserRow | undefined;

  if (!existingRow) throw new Error('User not found');

  const fullName = input.fullName ?? existingRow.full_name;
  const role = input.role ?? existingRow.role;
  const isActive = input.isActive ?? existingRow.is_active === 1;
  if (input.pin) await assertPinFree(db, input.pin, existingRow.id);
  const pinHash = input.pin ? await hashPin(input.pin) : existingRow.pin_hash;
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
  };

  const wasActiveAdmin = existingRow.role === 'admin' && existingRow.is_active === 1;
  const staysActiveAdmin = role === 'admin' && isActive;

  const tx = db.transaction(() => {
    if (wasActiveAdmin && !staysActiveAdmin) assertNotLastActiveAdmin(db, input.id);

    db.prepare(
      `UPDATE users
          SET full_name = ?, role = ?, is_active = ?, pin_hash = ?, updated_at = ?, version = ?
        WHERE id = ?`,
    ).run(fullName, role, isActive ? 1 : 0, pinHash, now, nextVersion, input.id);

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
      after: updated,
    });
  });
  tx();

  return updated;
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
