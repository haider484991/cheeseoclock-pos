import type { UUID } from './ids.js';

export type Role = 'admin' | 'manager' | 'cashier';

export interface User {
  id: UUID;
  fullName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  | 'printer.manage';

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
  ]),
  cashier: new Set<Capability>([
    'order.create',
    'discount.apply',
    'shift.open',
    'shift.close',
  ]),
};

export const hasCapability = (role: Role, capability: Capability): boolean =>
  ROLE_CAPABILITIES[role].has(capability);
