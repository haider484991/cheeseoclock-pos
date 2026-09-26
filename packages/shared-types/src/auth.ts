import type { UUID } from './ids.js';

export type Role = 'admin' | 'manager' | 'cashier';

/**
 * How someone signs in: a number PIN (4-12 digits, the keypad) or a password
 * (6-64 characters with at least one letter). The rules live in
 * @cheeseoclock/shared-schemas (sign-in-secret.ts).
 */
export type SecretKind = 'pin' | 'password';

export interface User {
  id: UUID;
  fullName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * How this person signs in on THIS till. Null: the user was made on the
   * other till and has no PIN or password here yet (they never travel).
   */
  secretKind: SecretKind | null;
}

export interface UserSession {
  id: UUID;
  userId: UUID;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
}

export interface AuthenticatedUser {
  id: UUID;
  fullName: string;
  role: Role;
  sessionId: UUID;
}

/** Capability gates checked in IPC handlers + UI route guards. */
export type Capability =
  | 'menu.manage'
  | 'order.create'
  | 'order.void'
  | 'order.refund'
  | 'discount.apply'
  | 'discount.approve'
  | 'shift.open'
  | 'shift.close'
  | 'cash.movement'
  | 'report.view'
  | 'settings.manage'
  | 'users.manage'
  | 'fbr.manage'
  | 'printer.manage'
  /**
   * Edit or deactivate riders. Adding one only needs `order.create`: the
   * cashier dispatching a delivery must be able to put a new rider on the
   * roster there and then (owner, 2026-09-25).
   */
  | 'riders.manage';

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  admin: new Set<Capability>([
    'menu.manage',
    'order.create',
    'order.void',
    'order.refund',
    'discount.apply',
    'discount.approve',
    'shift.open',
    'shift.close',
    'cash.movement',
    'report.view',
    'settings.manage',
    'users.manage',
    'fbr.manage',
    'printer.manage',
    'riders.manage',
  ]),
  manager: new Set<Capability>([
    'menu.manage',
    'order.create',
    'order.void',
    'order.refund',
    'discount.apply',
    'discount.approve',
    'shift.open',
    'shift.close',
    'cash.movement',
    'report.view',
    'printer.manage',
    'riders.manage',
  ]),
  // A cashier opens the shift (counts the float in the morning) but never
  // closes it: the close is the drawer count, done by a manager or the owner
  // (owner, 2026-09-25).
  cashier: new Set<Capability>([
    'order.create',
    'discount.apply',
    'shift.open',
  ]),
};

export const hasCapability = (role: Role, capability: Capability): boolean =>
  ROLE_CAPABILITIES[role].has(capability);
