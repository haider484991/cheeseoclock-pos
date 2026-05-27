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

  for (const row of rows) {
    const ok = await verifyPin(pin, row.pin_hash);
    if (ok) return rowToInternal(row);
  }
  return null;
}

export async function createUser(
  db: AppDatabase,
  input: { fullName: string; role: Role; pin: string },
  actor: { userId: string | null; deviceId: string },
): Promise<User> {
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

  const tx = db.transaction(() => {
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

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE users SET is_active = 0, deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(now, now, id);
    enqueueSync(db, {
      entityType: 'users',
      entityId: id,
      op: 'delete',
      payload: { id, deletedAt: now },
    });
    writeAudit(db, {
      entityType: 'users',
      entityId: id,
      action: 'delete',
      actorUserId: actor.userId,
      before: rowToUser(existingRow),
      after: null,
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
