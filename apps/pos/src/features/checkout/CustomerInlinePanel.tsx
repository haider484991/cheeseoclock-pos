import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import type { CustomerAddress, CustomerAddressMatch } from '@cheeseoclock/shared-types';
import { suggestDhaAreas, formatDhaArea, DHA_CITY, type DhaPlace } from '@cheeseoclock/pos-domain';
import { Phone, User, MapPin, Check, UserPlus, History } from 'lucide-react';

/**
 * Inline customer + delivery panel — lives above the menu (no modal).
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
    // The shop delivers inside DHA only; the city is never in question.
    city: DHA_CITY,
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
  // Wraps both the input AND the suggestions dropdown, so click-outside only
  // fires when the user clicks somewhere *truly* outside (a mousedown on a
  // suggestion button used to unmount the button before its click event could
  // run — that's the "selecting doesn't pre-fill" bug).
  const phoneWrapRef = useRef<HTMLDivElement | null>(null);
  // Address typeahead: known addresses by house number, DHA places by name.
  const [addrOpen, setAddrOpen] = useState(false);
  const [areaOpen, setAreaOpen] = useState(false);
  const addrWrapRef = useRef<HTMLDivElement | null>(null);

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

  // "41-C" typed at the counter → every saved address starting with it, with
  // the customer it belongs to. Regulars are known by their house number.
  const addrMatchesQ = useQuery({
    queryKey: ['customers', 'addressSearch', form.addressLine.trim().toLowerCase()],
    queryFn: () => ipc.customers.searchAddresses(form.addressLine.trim(), 6),
    enabled: mode === 'delivery' && form.addressLine.trim().length >= 2 && !form.matchedAddressId,
  });
  const addrMatches = form.matchedAddressId ? [] : (addrMatchesQ.data ?? []);
  const areaSuggestions = useMemo(() => suggestDhaAreas(form.area, 8), [form.area]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!addrWrapRef.current) return;
      if (!addrWrapRef.current.contains(e.target as Node)) {
        setAddrOpen(false);
        setAreaOpen(false);
      }
    }
    if (addrOpen || areaOpen) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [addrOpen, areaOpen]);

  function pickAddressMatch(a: CustomerAddressMatch) {
    setAddrOpen(false);
    setForm((prev) => ({
      ...prev,
      matchedAddressId: a.id,
      addressLabel: a.label,
      addressLine: a.addressLine,
      area: a.area ?? '',
      city: a.city ?? DHA_CITY,
      // The house tells us who it is, unless the cashier already picked someone.
      ...(prev.matchedCustomerId
        ? {}
        : { matchedCustomerId: a.customerId, name: a.customerName, phone: a.customerPhone ?? prev.phone }),
    }));
  }

  function pickArea(p: DhaPlace) {
    setAreaOpen(false);
    setForm((prev) => ({ ...prev, area: formatDhaArea(p), city: DHA_CITY, matchedAddressId: null }));
  }

  // After matching a customer, auto-pick their default address for delivery
  // mode so the cashier doesn't have to click a chip. Only runs when the
  // address line is still empty (so we don't overwrite an in-progress edit).
  useEffect(() => {
    if (mode !== 'delivery') return;
    if (!form.matchedCustomerId) return;
    if (form.matchedAddressId) return;
    if (form.addressLine.trim()) return; // user typed something already
    const addrs = customerDetailQ.data?.addresses ?? [];
    const def = addrs.find((a) => a.isDefault) ?? addrs[0];
    if (def) {
      setForm((prev) => ({
        ...prev,
        matchedAddressId: def.id,
        addressLabel: def.label,
        addressLine: def.addressLine,
        area: def.area ?? '',
        city: def.city ?? '',
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerDetailQ.data?.addresses, form.matchedCustomerId, mode]);

  // Close the dropdown when clicking outside. Crucially, check against the
  // *wrapper* (which contains both the input and the suggestion list) so
  // clicking a suggestion doesn't trigger an "outside" close that unmounts
  // the button before its onClick fires.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!phoneWrapRef.current) return;
      if (!phoneWrapRef.current.contains(e.target as Node)) setPhoneOpen(false);
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
    <div className="checkout-customer">
      {/* Phone with autocomplete */}
      <div className="relative" ref={phoneWrapRef}>
        <div className="flex items-center gap-1">
          <Phone className="h-3 w-3 text-stone-400" />
          <span className="text-xs uppercase tracking-wider text-stone-500">Phone</span>
        </div>
        <input
          ref={phoneRef}
          type="tel"
          aria-label="Customer phone"
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
          className="cust-input is-mono"
        />
        {phoneOpen && form.phone.length >= 2 && !form.matchedCustomerId && (
          <div className="cust-dropdown-wrap">
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
          aria-label="Customer name"
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          placeholder="Customer name"
          className="cust-input"
        />
      </div>

      {showAddress && (
        <div className="checkout-address flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <MapPin className="h-3 w-3 text-stone-400" />
            <span className="text-xs uppercase tracking-wider text-stone-500">Address</span>
          </div>
          <div className="checkout-address-fields" ref={addrWrapRef}>
            <div className="relative">
              <input
                type="text"
                value={form.addressLine}
                aria-label="House and street"
                autoComplete="off"
                onFocus={() => setAddrOpen(true)}
                onBlur={() => setTimeout(() => setAddrOpen(false), 150)}
                onChange={(e) => {
                  setForm((p) => ({ ...p, addressLine: e.target.value, matchedAddressId: null }));
                  setAddrOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setAddrOpen(false);
                  if (e.key === 'Enter' && addrOpen && addrMatches[0]) {
                    e.preventDefault();
                    pickAddressMatch(addrMatches[0]);
                  }
                }}
                placeholder="House 41-C, Sehar Lane 3"
                className="cust-input"
              />
              {addrOpen && addrMatches.length > 0 && (
                <ul className="cust-dropdown" role="listbox" aria-label="Known addresses">
                  {addrMatches.map((a) => (
                    <li key={a.id}>
                      <button type="button" onClick={() => pickAddressMatch(a)}>
                        <span>{a.addressLine}</span>
                        <small>{[a.area, a.city].filter(Boolean).join(', ')}</small>
                        <small>
                          {a.customerName}
                          {a.customerPhone ? ` · ${a.customerPhone}` : ''}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="relative">
              <input
                type="text"
                value={form.area}
                aria-label="Phase or commercial area"
                autoComplete="off"
                onFocus={() => setAreaOpen(true)}
                onBlur={() => setTimeout(() => setAreaOpen(false), 150)}
                onChange={(e) => {
                  setForm((p) => ({ ...p, area: e.target.value, matchedAddressId: null }));
                  setAreaOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setAreaOpen(false);
                  if (e.key === 'Enter' && areaOpen && areaSuggestions[0]) {
                    e.preventDefault();
                    pickArea(areaSuggestions[0]);
                  }
                }}
                placeholder="Phase / commercial"
                className="cust-input"
              />
              {areaOpen && areaSuggestions.length > 0 && (
                <ul className="cust-dropdown" role="listbox" aria-label="DHA areas">
                  {areaSuggestions.map((p) => (
                    <li key={p.label}>
                      <button type="button" onClick={() => pickArea(p)}>
                        <span>{p.label}</span>
                        {p.kind !== 'phase' && <small>{p.phase ? `DHA ${p.phase}` : 'DHA'}</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <input
              type="text"
              value={form.city}
              aria-label="City"
              onChange={(e) =>
                setForm((p) => ({ ...p, city: e.target.value, matchedAddressId: null }))
              }
              placeholder="City"
              className="cust-input"
            />
          </div>
          {savedAddresses.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-stone-500">Saved:</span>
              {savedAddresses.map((a) => {
                const preview = [a.addressLine, a.area].filter(Boolean).join(', ');
                const isSelected = form.matchedAddressId === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => pickSavedAddress(a)}
                    title={[a.label, a.addressLine, a.area, a.city]
                      .filter(Boolean)
                      .join(' · ')}
                    className={cn(
                      'inline-flex max-w-[14rem] items-center gap-1 truncate rounded-full px-2 py-0.5 text-[10px]',
                      isSelected
                        ? 'bg-amber-500 text-stone-900'
                        : 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300',
                    )}
                  >
                    {/* Show the address line itself — labels can collide
                        ("Order", "Home" …); the line is what's distinguishing. */}
                    <span className="truncate">{preview || a.label}</span>
                    {a.isDefault && (
                      <span
                        className={cn(
                          'rounded-sm px-1 text-[9px] uppercase tracking-wider',
                          isSelected
                            ? 'bg-stone-900/15 text-stone-800'
                            : 'bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
                        )}
                      >
                        default
                      </span>
                    )}
                  </button>
                );
              })}
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
      <details className="checkout-notes" open={!!form.deliveryNotes}>
        <summary>Order notes</summary>
        <input
          type="text"
          value={form.deliveryNotes}
          aria-label="Order notes"
          onChange={(e) => setForm((p) => ({ ...p, deliveryNotes: e.target.value }))}
          placeholder={mode === 'delivery' ? 'ring upper bell' : 'collect by 7pm'}
          className="cust-input"
        />
      </details>

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
  mode: 'dine_in' | 'takeaway' | 'delivery' | 'online' | 'foodpanda',
  form: CustomerFormState,
): Promise<void> {
  if (mode === 'dine_in' || mode === 'online' || mode === 'foodpanda') return;
  if (!form.phone.trim() && !form.name.trim() && !form.addressLine.trim()) return;

  let customerId = form.matchedCustomerId;
  // The name on the reused customer's master record, to compare against
  // what the till typed for this order.
  let masterName: string | null = null;

  if (customerId) {
    masterName = (await ipc.customers.get(customerId))?.name ?? null;
  } else if (form.phone.trim()) {
    // Try one more lookup in case they typed without picking the suggestion
    const found = await ipc.customers.findByPhone(form.phone.trim());
    if (found) {
      customerId = found.id;
      masterName = found.name;
    }
  }

  let nameOverride: string | undefined;
  if (!customerId) {
    // Create a new customer — name fallback to phone if empty
    const name = form.name.trim() || form.phone.trim() || 'Walk-in';
    const created = await ipc.customers.create({
      name,
      phone: form.phone.trim() || null,
    });
    customerId = created.id;
  } else {
    // Existing customer: a different name typed here is frozen onto this
    // order only. Tender never rewrites the master record — it used to
    // rename the customer (for every past and future order) from the till.
    const typed = form.name.trim();
    if (typed && typed !== masterName) nameOverride = typed;
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

  await ipc.customers.attachToOrder({
    orderId,
    customerId,
    addressId,
    ...(form.deliveryNotes.trim() ? { deliveryNotes: form.deliveryNotes.trim() } : {}),
    ...(nameOverride ? { nameOverride } : {}),
  });
}
