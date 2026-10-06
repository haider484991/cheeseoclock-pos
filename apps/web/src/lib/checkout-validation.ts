import {
  BUY_1_GET_1_CLOSED_MESSAGE,
  BUY_1_GET_1_SOCIAL_MESSAGE,
  deliveryMinimumShortfallCents,
  type WebFulfilment,
} from '@cheeseoclock/shared-types';
import { cleanSocial } from './checkout-extras';
import { DEFAULT_FACTS, deliveryAreasText, deliveryMinimumMessage } from './delivery-facts';
import { normalizePhone } from './format';

/**
 * The checkout form's own checks, in the order the form reads top to bottom,
 * so the customer is sent to the first thing to fix. The server re-checks all
 * of it (api/orders); these only save a round trip and say it in plain words.
 */

export type CheckoutField = 'cart' | 'zone' | 'name' | 'phone' | 'address' | 'social';

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
  /** Where the owner delivers, in a sentence ("DHA and Clifton"; '' while every area is off). Default: the built-in areas. */
  deliveryAreas?: string;
  /** The owner's smallest website delivery order's food, paisa (v0.7.30). Default 0: no minimum, as before. */
  minDeliveryOrderCents?: number;
  /** The cart's food: each line with its choices × quantity, before tax, the delivery charge and any discount (lib/cart cartSubtotalCents). */
  foodSubtotalCents?: number;
  /** A Buy 1 Get 1 deal is in the cart (shared-types buy-1-get-1): the hours and the Instagram / Facebook name apply. */
  buy1Get1InCart?: boolean;
  /** Buy 1 Get 1 deals are on sale right now (1–7 PM, Karachi). Default true. */
  buy1Get1Open?: boolean;
  /** The customer's Instagram / Facebook name as typed (required with a Buy 1 Get 1 deal). */
  social?: string;
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
  // Buy 1 Get 1 deals sell 1–7 PM only (the server refuses them too: api/orders 'buy1get1_closed').
  if (v.buy1Get1InCart && v.buy1Get1Open === false) {
    return { field: 'cart', message: `${BUY_1_GET_1_CLOSED_MESSAGE} Remove the deal to order now.` };
  }
  // The server's rule and words (api/orders 'below_minimum'): a delivery only, never a pick-up.
  const short = pickup ? 0 : deliveryMinimumShortfallCents(v.foodSubtotalCents ?? 0, v.minDeliveryOrderCents ?? 0);
  if (short > 0) {
    return { field: 'cart', message: deliveryMinimumMessage(v.minDeliveryOrderCents ?? 0, short, v.canPickup) };
  }
  if (!pickup && !v.hasZone) {
    const where = v.deliveryAreas ?? deliveryAreasText(DEFAULT_FACTS);
    return {
      field: 'zone',
      message: where
        ? `Choose your delivery area — we deliver in ${where} only.`
        : `Delivery is paused right now${v.canPickup ? ' — choose pick-up, or order on WhatsApp.' : ' — please order on WhatsApp.'}`,
    };
  }
  if (v.name.trim().length < 2) return { field: 'name', message: 'Please enter your name.' };
  if (v.phone.trim().length === 0) return { field: 'phone', message: 'Please enter your mobile number.' };
  if (!normalizePhone(v.phone)) {
    return { field: 'phone', message: 'Enter a Pakistani mobile number, like 0300 1234567.' };
  }
  if (!pickup && v.address.trim().length < 5) {
    return { field: 'address', message: 'Please enter your house number and street.' };
  }
  // The customer earns the free item by tagging the shop: the cashier needs whose post to check (api/orders 'buy1get1_social').
  if (v.buy1Get1InCart && cleanSocial(v.social ?? '') === null) {
    return { field: 'social', message: BUY_1_GET_1_SOCIAL_MESSAGE };
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
  social: 'social',
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
  if (body?.message) {
    const zone = body.error === 'outside_zone' || body.error === 'zone_paused';
    // Under the smallest delivery order, or a Buy 1 Get 1 deal outside its hours: the cart is what to change (no "send it
    // on WhatsApp" link); a deal without the customer's Instagram / Facebook name: that field.
    const cart = body.error === 'below_minimum' || body.error === 'buy1get1_closed';
    if (body.error === 'buy1get1_social') return { field: 'social', message: body.message };
    return { field: zone ? 'zone' : cart ? 'cart' : null, message: body.message };
  }
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
