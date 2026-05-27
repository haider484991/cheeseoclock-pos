import { useMemo } from 'react';
import {
  validateOrderForTender,
  type ValidationResult,
} from '@cheeseoclock/pos-domain';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useCustomerForm } from './useCustomerForm';

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
  const mode = useCheckoutStore((s) => s.mode);
  const tableId = useCheckoutStore((s) => s.tableId);
  const { form } = useCustomerForm();

  return useMemo<ValidationResult>(() => {
    const itemCount = snapshot?.items.length ?? 0;
    const subtotalCents = snapshot?.order.subtotalCents ?? 0;

    // Customer name/phone/address may be either committed on the snapshot OR
    // typed in the inline form — accept either.
    const customerName = snapshot?.customerName || form.name.trim() || null;
    const customerPhone = snapshot?.customerPhone || form.phone.trim() || null;
    const deliveryAddress =
      snapshot?.deliveryAddress ||
      (form.addressLine.trim()
        ? [form.addressLine, form.area, form.city].filter(Boolean).join(', ')
        : null);

    return validateOrderForTender({
      mode,
      itemCount,
      subtotalCents,
      tableId: snapshot?.order.tableId ?? tableId,
      customerName,
      customerPhone,
      deliveryAddress,
    });
  }, [snapshot, mode, tableId, form]);
}
