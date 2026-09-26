import type { CounterPhoneLookup } from '@cheeseoclock/pos-domain';

/**
 * The checkout customer panel's rules that don't need a screen: what the
 * phone box's dropdown says at the counter, and which address is saved for
 * the customer when the order is sent or paid.
 */

/** Hint under the phone box for a counter login (whole number only), or null to show the match. */
export function counterPhoneHint(lookup: CounterPhoneLookup, looking: boolean, found: boolean): string | null {
  switch (lookup.stage) {
    case 'empty':
      return null;
    case 'typing':
      return 'Type the whole number (0300 1234567 or 021 3587 1234) to find a saved customer.';
    case 'unknown':
      return "Not a number the till can look up. Fill name + address — we'll save this customer as typed.";
    case 'complete':
      if (looking) return 'Looking…';
      return found ? null : "No match. Fill name + address — we'll save this customer with the order.";
  }
}

type Mode = 'dine_in' | 'takeaway' | 'delivery' | 'online' | 'foodpanda';

export interface AddressFields {
  addressLabel: string;
  addressLine: string;
  area: string;
  city: string;
  /** One of the customer's saved addresses, picked as it is. */
  matchedAddressId: string | null;
  /** A typed address: keep it on this customer's list (ticked by default). */
  saveAddressToCustomer: boolean;
  /**
   * Make this address the one filled in next time: a saved one that is not
   * their usual one, or a kept typed one. Always starts unticked — "send it
   * to my office today" must not move a regular's usual address.
   */
  makeDefault: boolean;
}

export interface AddressWrite {
  label: string;
  addressLine: string;
  area: string | null;
  city: string | null;
  isDefault: boolean;
}

/**
 * A typed address, saved when the order is committed — the order needs a row
 * to point at. Kept ("save", ticked by default) it joins the customer's saved
 * addresses; unticked it is a "One-off". It becomes the one filled in next
 * time only when "use it next time" is ticked too (unticked by default), so a
 * regular who moved is fixed at the counter in one tap, and a one-day office
 * delivery never replaces their home. Null when there is none to save (not a
 * delivery, nothing typed, or a saved address picked as it is).
 */
export function typedAddressToSave(form: AddressFields, mode: Mode, defaultCity: string): AddressWrite | null {
  if (mode !== 'delivery' || form.matchedAddressId) return null;
  const addressLine = form.addressLine.trim();
  if (!addressLine) return null;
  return {
    label: form.saveAddressToCustomer ? form.addressLabel || 'Order' : 'One-off',
    addressLine,
    area: form.area.trim() || null,
    city: form.city.trim() || defaultCity,
    isDefault: form.saveAddressToCustomer && form.makeDefault,
  };
}

/**
 * A saved address picked with "use it next time" ticked, re-saved exactly as
 * it is stored (the till then reuses the same row and makes it the usual
 * one). Null when not asked, not a delivery, or it already is the usual one.
 */
export function savedAddressToMakeUsual<
  A extends { id: string; label: string; addressLine: string; area: string | null; city: string | null; isDefault: boolean },
>(form: AddressFields, mode: Mode, saved: readonly A[]): AddressWrite | null {
  if (mode !== 'delivery' || !form.matchedAddressId || !form.makeDefault) return null;
  const a = saved.find((x) => x.id === form.matchedAddressId);
  if (!a || a.isDefault) return null;
  return { label: a.label, addressLine: a.addressLine, area: a.area, city: a.city, isDefault: true };
}
