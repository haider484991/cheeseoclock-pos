import { useMemo } from 'react';
import {
  validateOrderForTender,
  type ValidationResult,
} from '@cheeseoclock/pos-domain';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useCustomerForm } from './useCustomerForm';
import { useCheckoutRules } from '../settings/shop-rules/useShopSetting';

/** What the ticket says is still needed when the owner asks how each order came in and no chip is lit. */
export const CAME_BY_NEEDED = 'How the order came in (Walk-in, Phone or WhatsApp)';

/**
 * The owner asks how each counter takeaway and delivery came in (Settings →
 * Money & discounts): Send and Pay wait for a chip. Pure, for the tests.
 */
export function withCameByNeeded(
  base: ValidationResult,
  p: { askCameBy: boolean; mode: string; source: string; cameBy: string | null | undefined },
): ValidationResult {
  const asked = p.askCameBy && p.source === 'pos' && (p.mode === 'takeaway' || p.mode === 'delivery');
  if (!asked || p.cameBy) return base;
  return { ok: false, missing: [...base.missing, CAME_BY_NEEDED] };
}

/**
 * Live tender-readiness check. Combines the persisted order snapshot with the
 * currently-being-typed customer form (since customer info commits on tender,
 * we treat typed-but-not-yet-saved values as effectively present in the UI).
 *
 * Used by:
 *  - CartPane to render the "missing requirements" banner + disable Pay
 *  - CheckoutPage to gate the F1 hotkey
 */
export function useTenderGate(): ValidationResult {
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const storeMode = useCheckoutStore((s) => s.mode);
  const tableId = useCheckoutStore((s) => s.tableId);
  const cameBy = useCheckoutStore((s) => s.cameBy);
  const askCameBy = useCheckoutRules().data?.offers?.askCameBy ?? false;
  const { form } = useCustomerForm();

  return useMemo<ValidationResult>(() => {
    const itemCount = snapshot?.items.length ?? 0;
    const subtotalCents = snapshot?.order.subtotalCents ?? 0;
    // The saved order's mode is the source of truth — the server validates
    // against it too. Falling back to the store mode only before an order
    // exists keeps the client gate and the server in agreement.
    const mode = snapshot?.order.mode ?? storeMode;

    // Customer name/phone/address may be either committed on the snapshot OR
    // typed in the inline form — accept either.
    const customerName = snapshot?.customerName || form.name.trim() || null;
    const customerPhone = snapshot?.customerPhone || form.phone.trim() || null;
    const deliveryAddress =
      snapshot?.deliveryAddress ||
      (form.addressLine.trim()
        ? [form.addressLine, form.area, form.city].filter(Boolean).join(', ')
        : null);

    const base = validateOrderForTender({
      mode,
      itemCount,
      subtotalCents,
      tableId: snapshot?.order.tableId ?? tableId,
      customerName,
      customerPhone,
      deliveryAddress,
    });
    return withCameByNeeded(base, { askCameBy, mode, source: snapshot?.order.source ?? 'pos', cameBy });
  }, [snapshot, storeMode, tableId, form, askCameBy, cameBy]);
}
