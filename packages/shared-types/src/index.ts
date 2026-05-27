/**
 * Domain types shared across the POS app, the ordering website, and shared packages.
 * Zod schemas in @cheeseoclock/shared-schemas are the runtime source of truth;
 * many of these types are exported from there. This module defines pure types
 * that are runtime-irrelevant (enums, branded types, IPC envelopes).
 */

export * from './money.js';
export * from './ids.js';
export * from './ipc.js';
export * from './ipc-contract.js';
export * from './inventory.js';
export * from './customer.js';
export * from './auth.js';
export * from './sync.js';
export * from './order.js';
export * from './menu.js';
export * from './customer.js';
export * from './shift.js';
export * from './printer.js';
