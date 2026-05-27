import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import type { CustomerAddress } from '@cheeseoclock/shared-types';
import { Phone, User, MapPin, Check, UserPlus, History } from 'lucide-react';

/**
 * Inline customer + delivery panel — lives in the OrderModeBar (no modal).
 *
 * The cashier fills in phone / name / address as part of the order. Nothing is
 * persisted until tender time, when `useCustomerForm` commits via
 * `commitCustomerToOrder(orderId)`. If the typed phone matches an existing
 * customer, that customer is reused; otherwise a new customer is created.
 *
 * UX rules:
 *   • Phone autocompletes as you type — suggestions appear in a small dropdown.
 *   • Pick a suggestion → name + saved addresses pre-fill (you can still edit).
 *   • If `mode === 'delivery'`, an address picker (saved) + freeform fields appear.
 *   • All inputs are debounced on blur for autocomplete; no save buttons.
 *   • A small status pill says "Existing customer" or "New — will save".
 */

export interface CustomerFormState {
  phone: string;
  name: string;
  addressLabel: string;
  addressLine: string;
  area: string;
  city: string;
  deliveryNotes: string;
  /** When the form picks an existing customer, we store the id for commit. */
  matchedCustomerId: string | null;
  /** When the form picks one of the matched customer's saved addresses. */
  matchedAddressId: string | null;
  /** If user wants to save a new address back to the customer's profile. */
  saveAddressToCustomer: boolean;
}

export function makeEmptyCustomerForm(): CustomerFormState {
  return {
    phone: '',
    name: '',
    addressLabel: 'Order',
    addressLine: '',
    area: '',
    city: '',
    deliveryNotes: '',
    matchedCustomerId: null,
    matchedAddressId: null,
    saveAddressToCustomer: true,
  };
}

interface PanelProps {
  mode: 'takeaway' | 'delivery';
  form: CustomerFormState;
  setForm: (next: CustomerFormState | ((prev: CustomerFormState) => CustomerFormState)) => void;
}

export function CustomerInlinePanel({ mode, form, setForm }: PanelProps) {
  const [phoneOpen, setPhoneOpen] = useState(false);
  const phoneRef = useRef<HTMLInputElement | null>(null);

  // Debounced lookup for phone autocomplete.
  const suggestionsQ = useQuery({
    queryKey: ['customers', 'inlineSearch', form.phone],
    queryFn: () => ipc.customers.list({ search: form.phone, limit: 6 }),
    enabled: form.phone.length >= 2 && !form.matchedCustomerId,
  });

  // When we have a matched customer, load their addresses
  const customerDetailQ = useQuery({
    queryKey: ['customers', 'detail', form.matchedCustomerId],
    queryFn: () =>
      form.matchedCustomerId
        ? ipc.customers.get(form.matchedCustomerId)
        : Promise.resolve(null),
    enabled: !!form.matchedCustomerId,
  });

  const customerHistoryQ = useQuery({
    queryKey: ['customers', 'history', form.matchedCustomerId],
    queryFn: () =>
      form.matchedCustomerId
        ? ipc.customers.orderHistory(form.matchedCustomerId, 5)
        : Promise.resolve([]),
    enabled: !!form.matchedCustomerId,
  });

  // Close the dropdown when clicking outside.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!phoneRef.current) return;
      if (!phoneRef.current.contains(e.target as Node)) setPhoneOpen(false);
    }
    if (phoneOpen) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [phoneOpen]);

  function pickSuggestion(customer: {
    id: string;
    name: string;
    phone: string | null;
  }) {
    setPhoneOpen(false);
    setForm((prev) => ({
      ...prev,
      matchedCustomerId: customer.id,
      matchedAddressId: null,
      phone: customer.phone ?? prev.phone,
      name: customer.name,
    }));
  }

  function pickSavedAddress(a: CustomerAddress) {
    setForm((prev) => ({
      ...prev,
      matchedAddressId: a.id,
      addressLabel: a.label,
      addressLine: a.addressLine,
      area: a.area ?? '',
      city: a.city ?? '',
    }));
  }

  function unmatch() {
    setForm((prev) => ({
      ...prev,
      matchedCustomerId: null,
      matchedAddressId: null,
    }));
    phoneRef.current?.focus();
  }

  const showAddress = mode === 'delivery';
  const savedAddresses = customerDetailQ.data?.addresses ?? [];

  return (
    <div className="flex flex-1 flex-wrap items-start gap-2 border-l border-stone-200 pl-3 dark:border-stone-700">
      {/* Phone with autocomplete */}
      <div className="relative">
        <div className="flex items-center gap-1">
          <Phone className="h-3 w-3 text-stone-400" />
          <span className="text-xs uppercase tracking-wider text-stone-500">Phone</span>
        </div>
        <input
          ref={phoneRef}
          type="tel"
          value={form.phone}
          onFocus={() => setPhoneOpen(true)}
          onChange={(e) => {
            setForm((p) => ({
              ...p,
              phone: e.target.value,
              matchedCustomerId: null,
              matchedAddressId: null,
            }));
            setPhoneOpen(true);
          }}
          placeholder="+92 300…"
          className="w-40 rounded-md border border-stone-300 px-2 py-1 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
        />
        {phoneOpen && form.phone.length >= 2 && !form.matchedCustomerId && (
          <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900">
            {(suggestionsQ.data ?? []).length === 0 ? (
              <div className="p-2 text-xs text-stone-500">
                No match. Fill name + address — we'll save this customer when you tender.
              </div>
            ) : (
              <ul className="max-h-56 overflow-auto">
                {suggestionsQ.data?.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => pickSuggestion(c)}
                      className="flex w-full items-center justify-between px-2 py-2 text-left text-sm hover:bg-stone-50 dark:hover:bg-stone-800"
                    >
                      <div>
                        <div className="font-medium">{c.name}</div>
                        <div className="font-mono text-xs text-stone-500">
                          {c.phone ?? '—'}
                        </div>
                      </div>
                      {c.loyaltyPoints > 0 && (
                        <span className="text-xs text-amber-600 dark:text-amber-300">
                          {c.loyaltyPoints}pt
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Name */}
      <div>
        <div className="flex items-center gap-1">
          <User className="h-3 w-3 text-stone-400" />
          <span className="text-xs uppercase tracking-wider text-stone-500">Name</span>
        </div>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          placeholder="Customer name"
          className="w-44 rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
        />
      </div>

      {showAddress && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <MapPin className="h-3 w-3 text-stone-400" />
            <span className="text-xs uppercase tracking-wider text-stone-500">Address</span>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={form.addressLine}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  addressLine: e.target.value,
                  matchedAddressId: null,
                }))
              }
              placeholder="House 12, Street 4"
              className="w-56 rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
            />
            <input
              type="text"
              value={form.area}
              onChange={(e) =>
                setForm((p) => ({ ...p, area: e.target.value, matchedAddressId: null }))
              }
              placeholder="Area"
              className="w-24 rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
            />
            <input
              type="text"
              value={form.city}
              onChange={(e) =>
                setForm((p) => ({ ...p, city: e.target.value, matchedAddressId: null }))
              }
              placeholder="City"
              className="w-24 rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
            />
          </div>
          {savedAddresses.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-stone-500">Saved:</span>
              {savedAddresses.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => pickSavedAddress(a)}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px]',
                    form.matchedAddressId === a.id
                      ? 'bg-amber-500 text-stone-900'
                      : 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300',
                  )}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {form.matchedCustomerId && form.addressLine && !form.matchedAddressId && (
            <label className="flex items-center gap-1 text-[10px] text-stone-500">
              <input
                type="checkbox"
                checked={form.saveAddressToCustomer}
                onChange={(e) =>
                  setForm((p) => ({ ...p, saveAddressToCustomer: e.target.checked }))
                }
              />
              Save this address to {customerDetailQ.data?.name ?? 'customer'} for next time
            </label>
          )}
        </div>
      )}

      {/* Delivery notes — both modes */}
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wider text-stone-500">Notes</span>
        <input
          type="text"
          value={form.deliveryNotes}
          onChange={(e) => setForm((p) => ({ ...p, deliveryNotes: e.target.value }))}
          placeholder={mode === 'delivery' ? 'ring upper bell' : 'collect by 7pm'}
          className="w-40 rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
        />
      </div>

      {/* Status pill + history hint */}
      <div className="ml-auto flex flex-col items-end gap-1">
        {form.matchedCustomerId ? (
          <button
            type="button"
            onClick={unmatch}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-200"
            title="Click to clear and pick a different customer"
          >
            <Check className="h-3 w-3" />
            Existing customer
          </button>
        ) : form.name || form.phone ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <UserPlus className="h-3 w-3" />
            New — saves on tender
          </span>
        ) : (
          <span className="text-[10px] text-stone-500">No customer yet</span>
        )}
        {form.matchedCustomerId && (customerHistoryQ.data?.length ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-stone-500">
            <History className="h-3 w-3" />
            {customerHistoryQ.data?.length} past order
            {(customerHistoryQ.data?.length ?? 0) === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Persist whatever's in the form to the order at tender time.
 * - If the phone matched an existing customer → reuse.
 * - Else if name+phone given → create the customer.
 * - If the user picked a saved address → use it.
 * - Else if address fields are filled → optionally save as a new address on the customer.
 * - Attach customer + chosen address + delivery notes to the order.
 */
export async function commitCustomerToOrder(
  orderId: string,
  mode: 'dine_in' | 'takeaway' | 'delivery' | 'online',
  form: CustomerFormState,
): Promise<void> {
  if (mode === 'dine_in' || mode === 'online') return;
  if (!form.phone.trim() && !form.name.trim() && !form.addressLine.trim()) return;

  let customerId = form.matchedCustomerId;

  if (!customerId) {
    // Try one more lookup in case they typed without picking the suggestion
    if (form.phone.trim()) {
      const found = await ipc.customers.findByPhone(form.phone.trim());
      if (found) customerId = found.id;
    }
  }

  if (!customerId) {
    // Create a new customer — name fallback to phone if empty
    const name = form.name.trim() || form.phone.trim() || 'Walk-in';
    const created = await ipc.customers.create({
      name,
      phone: form.phone.trim() || null,
    });
    customerId = created.id;
  } else {
    // Update name/phone if changed
    await ipc.customers.update({
      id: customerId,
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    });
  }

  let addressId: string | null = form.matchedAddressId;
  if (mode === 'delivery' && !addressId && form.addressLine.trim()) {
    if (form.saveAddressToCustomer) {
      const created = await ipc.customers.createAddress({
        customerId,
        label: form.addressLabel || 'Order',
        addressLine: form.addressLine.trim(),
        area: form.area.trim() || null,
        city: form.city.trim() || null,
      });
      addressId = created.id;
    } else {
      // One-off: create a temporary address (still saved but unflagged)
      const created = await ipc.customers.createAddress({
        customerId,
        label: 'One-off',
        addressLine: form.addressLine.trim(),
        area: form.area.trim() || null,
        city: form.city.trim() || null,
      });
      addressId = created.id;
    }
  }

  await ipc.orders.attachCustomer({
    orderId,
    customerId,
    addressId,
    ...(form.deliveryNotes.trim() ? { deliveryNotes: form.deliveryNotes.trim() } : {}),
  });
}
