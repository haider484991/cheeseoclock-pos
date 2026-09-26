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
  /**
   * Set when a manager or the owner signed in on a till a cashier was just
   * using (stepping in to approve or fix something): at this time (ISO),
   * however busy the counter is, this login is held until the same person
   * types their PIN or password again (then it is a normal login) or hands
   * the till back. Absent otherwise. See STEP_IN_MAX_MS in auth-service.ts.
   */
  stepInEndsAt?: string;
  /**
   * That time has come: the till refuses everything on this login until its
   * own PIN or password is typed (`auth:keepStepIn`) or it is logged out. The
   * screen stays as it was underneath. Only `auth:currentSession` returns a
   * held login; every other channel answers 'unauthenticated' with
   * `details.stepIn === 'held'`.
   */
  stepInHeld?: boolean;
}

/** `details.stepIn` on an 'unauthenticated' answer while the login is held (see `stepInHeld`). */
export const STEP_IN_HELD = 'held';

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
  | 'riders.manage'
  /**
   * The Customers page and everything behind it: the whole list, searching
   * it, a customer's past orders, and editing customers or their saved
   * addresses (it covers the edits, so it is not a harmless "view").
   * Checkout's own lookup (one customer, found by typing their whole phone
   * number), adding a new customer and saving the delivery address with an
   * order need only `order.create` (owner, 2026-09-26).
   */
  | 'customers.manage'
  /**
   * Order History: past and finished orders of any day, searching them, the
   * sales tiles, opening or reprinting an old order. Without it a counter
   * login sees the Live Orders board and the orders of the shift open now
   * (Recent Orders) only (owner, 2026-09-26).
   */
  | 'order.history';

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
    'customers.manage',
    'order.history',
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
    'customers.manage',
    'order.history',
  ]),
  // A cashier opens the shift (counts the float in the morning) but never
  // closes it: the close is the drawer count, done by a manager or the owner
  // (owner, 2026-09-25).
  //
  // A cashier gets only what serves the customer in front of them now
  // (owner, 2026-09-26): take and send orders, take payment, work the Live
  // Orders board, find ONE customer by their whole phone number, and see the
  // orders of the shift open now. No customer list, no order history, no
  // reports or sales totals, no shift totals or expected cash (the count is
  // blind). Toast (Find Checks, Customer Credits & Reports), Square
  // (Transactions, Customers, Reports) and Loyverse (View all receipts,
  // Manage customers, View shift report) all keep these for managers; the
  // main process refuses them, the screens only follow.
  cashier: new Set<Capability>([
    'order.create',
    'discount.apply',
    'shift.open',
  ]),
};

export const hasCapability = (role: Role, capability: Capability): boolean =>
  ROLE_CAPABILITIES[role].has(capability);
