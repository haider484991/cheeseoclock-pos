import type { WebFulfilment } from '@cheeseoclock/shared-types';
import { normalizePhone } from './format';

/**
 * The checkout form's own checks, in the order the form reads top to bottom,
 * so the customer is sent to the first thing to fix. The server re-checks all
 * of it (api/orders); these only save a round trip and say it in plain words.
 */

export type CheckoutField = 'cart' | 'zone' | 'name' | 'phone' | 'address';

export interface CheckoutProblem {
  /** The field to focus, or null for a problem with no single field. */
  field: CheckoutField | null;
  message: string;
}

export interface CheckoutInput {
  fulfilment: WebFulfilment;
  /** A zone was chosen (the area list's own validation). */
  hasZone: boolean;
  name: string;
  phone: string;
  address: string;
  cartSize: number;
  /** Labels of pick-up-only lines in the cart. */
  pickupOnlyInCart: readonly string[];
  /** Online pick-up is on offer right now. */
  canPickup: boolean;
}

export function validateCheckout(v: CheckoutInput): CheckoutProblem | null {
  const pickup = v.fulfilment === 'pickup';
  if (v.cartSize === 0) return { field: 'cart', message: 'Your order is empty — add something from the menu.' };
  if (!pickup && v.pickupOnlyInCart.length > 0) {
    const many = v.pickupOnlyInCart.length > 1;
    const them = many ? 'them' : 'it';
    return {
      field: 'cart',
      message: `${v.pickupOnlyInCart.join(', ')} ${many ? 'are' : 'is'} pick-up only — ${
        v.canPickup ? `switch to pick-up, or remove ${them}` : `remove ${them}`
      } to order delivery.`,
    };
  }
  if (!pickup && !v.hasZone) {
    return { field: 'zone', message: 'Choose your delivery area — we deliver in DHA and Clifton only.' };
  }
  if (v.name.trim().length < 2) return { field: 'name', message: 'Please enter your name.' };
  if (v.phone.trim().length === 0) return { field: 'phone', message: 'Please enter your mobile number.' };
  if (!normalizePhone(v.phone)) {
    return { field: 'phone', message: 'Enter a Pakistani mobile number, like 0300 1234567.' };
  }
  if (!pickup && v.address.trim().length < 5) {
    return { field: 'address', message: 'Please enter your house number and street.' };
  }
  return null;
}

/** The api/orders error body, as far as the page reads it. */
export interface OrderErrorBody {
  error?: string;
  message?: string;
  details?: Record<string, string[] | undefined>;
}

const SERVER_FIELDS: Record<string, CheckoutField> = {
  customerName: 'name',
  customerPhone: 'phone',
  addressLine: 'address',
  zoneId: 'zone',
  items: 'cart',
};

/**
 * Say what the server said. The shop can close between loading the page and
 * pressing the button, a phone number can be malformed, an item can leave the
 * menu — each has its own message, and a field error points at its field.
 */
export function problemFromServer(body: OrderErrorBody | null): CheckoutProblem {
  if (body?.details) {
    for (const [key, messages] of Object.entries(body.details)) {
      const message = messages?.find((m) => typeof m === 'string' && m.length > 0);
      if (message) return { field: SERVER_FIELDS[key] ?? null, message };
    }
  }
  if (body?.message) return { field: body.error === 'outside_zone' ? 'zone' : null, message: body.message };
  switch (body?.error) {
    case 'store_closed':
      return { field: null, message: 'We are not taking online orders at the moment. Please order on WhatsApp.' };
    case 'pickup_unavailable':
      return { field: null, message: 'Online pick-up is not available right now — choose delivery.' };
    case 'menu_not_published':
    case 'item_not_on_menu':
    case 'modifier_not_on_item':
      return { field: null, message: 'The menu was just updated — please refresh the page and try again.' };
    case 'rate_limited':
      return { field: null, message: 'Too many orders in a short time. Please wait a few minutes or call us.' };
    default:
      return { field: null, message: 'Could not place the order. Please try again, or order on WhatsApp.' };
  }
}
