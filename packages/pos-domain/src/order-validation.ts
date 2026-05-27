/**
 * Order validation rules — pure functions that return a list of failed
 * requirements. Both the renderer (UI gates) and the main process (defense
 * in depth at the repository layer) call these.
 *
 * Returning `{ ok, missing }` rather than throwing keeps the same shape
 * usable for both "should I enable the Pay button?" UI logic and
 * "is this safe to commit?" server-side enforcement.
 */

import type { OrderMode } from '@cheeseoclock/shared-types';

export interface OrderValidationContext {
  mode: OrderMode;
  itemCount: number;
  subtotalCents: number;
  tableId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable, e.g. "Delivery needs a customer address". */
  missing: string[];
}

/**
 * Can this order be tendered RIGHT NOW? World-standard POS rules:
 *  - Must have at least one item with positive subtotal.
 *  - Dine-in: table required.
 *  - Takeaway: customer phone OR name required (so the order can be called out).
 *  - Delivery: customer name + phone + address required.
 *  - Online: same as delivery (web channel still needs the address).
 */
export function validateOrderForTender(ctx: OrderValidationContext): ValidationResult {
  const missing: string[] = [];

  if (ctx.itemCount <= 0 || ctx.subtotalCents <= 0) {
    missing.push('Add at least one item');
  }

  switch (ctx.mode) {
    case 'dine_in':
      if (!ctx.tableId) missing.push('Pick a table for dine-in');
      break;
    case 'takeaway':
      if (!ctx.customerPhone && !ctx.customerName) {
        missing.push('Takeaway needs a customer phone or name');
      }
      break;
    case 'delivery':
    case 'online':
      if (!ctx.customerName) missing.push(`${labelMode(ctx.mode)} needs a customer name`);
      if (!ctx.customerPhone) missing.push(`${labelMode(ctx.mode)} needs a customer phone`);
      if (!ctx.deliveryAddress)
        missing.push(`${labelMode(ctx.mode)} needs a delivery address`);
      break;
  }

  return { ok: missing.length === 0, missing };
}

/** Validates a void request — refunded orders cannot be voided, reason mandatory. */
export function validateVoid(input: {
  status: string;
  reason: string;
}): ValidationResult {
  const missing: string[] = [];
  if (input.status === 'paid')
    missing.push('Paid orders must be refunded, not voided');
  if (input.status === 'refunded')
    missing.push('Refunded orders are final; they cannot be voided');
  if (input.status === 'void') missing.push('Order is already voided');
  if (!input.reason.trim()) missing.push('Void reason is required');
  return { ok: missing.length === 0, missing };
}

/**
 * Validates a discount input. Percent must be 0–100, flat amount must be
 * non-negative. Approval-required check is in `requiresManagerApproval` —
 * this function only checks the shape.
 */
export function validateDiscountInput(input: {
  discountType: 'percent' | 'flat';
  value: number;
}): ValidationResult {
  const missing: string[] = [];
  if (!Number.isFinite(input.value) || input.value < 0)
    missing.push('Discount must be a non-negative number');
  if (input.discountType === 'percent' && input.value > 100)
    missing.push('Percent discount cannot exceed 100');
  return { ok: missing.length === 0, missing };
}

function labelMode(mode: OrderMode): string {
  switch (mode) {
    case 'dine_in':
      return 'Dine-in';
    case 'takeaway':
      return 'Takeaway';
    case 'delivery':
      return 'Delivery';
    case 'online':
      return 'Online';
  }
}
