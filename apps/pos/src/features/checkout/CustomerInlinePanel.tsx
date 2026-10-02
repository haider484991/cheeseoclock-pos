import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import {
  DELIVERY_CITY,
  deliveryZoneFeeItemIds,
  isDeliveryChargeLine,
  type CustomerAddress,
  type CustomerAddressMatch,
  type OrderSnapshot,
} from '@cheeseoclock/shared-types';
import {
  counterPhoneLookup,
  deliveryChargeRowState,
  deliveryChargeTarget,
  deliveryChargeWords,
  makeDeliveryAreaTeller,
  normalizePhone,
  type DeliveryAreaTeller,
} from '@cheeseoclock/pos-domain';
import { Phone, User, MapPin, Check, UserPlus, History, Bike, Plus, PauseCircle, RefreshCw, X } from 'lucide-react';
import { AreaPicker } from '../customers/AreaPicker';
import { useDeliveryAreas } from '../settings/shop-rules/useShopSetting';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useToast } from '../../components/toast/ToastProvider';
import { counterPhoneHint, savedAddressToMakeUsual, typedAddressToSave } from './counterCustomer';
import { customersChanged } from './customerLookups';

/**
 * Inline customer + delivery panel — lives in the second step of the order ticket (no modal).
 *
 * The cashier fills in phone / name / address as part of the order. Nothing is
 * persisted until tender time, when `useCustomerForm` commits via
 * `commitCustomerToOrder(orderId)`. If the typed phone matches an existing
 * customer, that customer is reused; otherwise a new customer is created.
 *
 * UX rules:
 *   • Phone autocompletes as you type — suggestions appear in a small dropdown.
 *   • Pick a suggestion → name + saved addresses pre-fill (you can still edit).
 *   • If `mode === 'delivery'`: house / street is typed (a saved house number
 *     brings its customer back); the AREA is picked from the owner's list
 *     (Settings → Delivery areas), and its delivery charge goes on the bill
 *     BY ITSELF (owner, 28 Sep 2026) — swapped when the area changes, taken
 *     off when it is cleared; the main process decides, on this panel's area
 *     (orders:setDeliveryArea) and on the address saved at Send and Pay.
 *   • No save buttons. A small status pill says "Existing customer" or "New".
 *
 * At the counter (a login without `customers.manage`, owner 2026-09-26) the
 * lookup is the WHOLE phone number only: the caller reads it out, and at most
 * one customer comes back, filled in by itself. No type-ahead list, no
 * house-number search, no past-order count — those read the customer list a
 * few at a time. The customer's own saved addresses still fill in, and the
 * main process refuses the rest anyway (customers-handlers.ts).
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
  /** If user wants to save a new address back to the customer's profile (ticked by default). */
  saveAddressToCustomer: boolean;
  /** Make the picked saved address, or the kept typed one, the one filled in next time (starts unticked). */
  makeDefault: boolean;
}

export function makeEmptyCustomerForm(): CustomerFormState {
  return {
    phone: '',
    name: '',
    addressLabel: 'Order',
    addressLine: '',
    area: '',
    // The shop delivers in DHA and Clifton only; the city is never in question.
    city: DELIVERY_CITY,
    deliveryNotes: '',
    matchedCustomerId: null,
    matchedAddressId: null,
    saveAddressToCustomer: true,
    makeDefault: false,
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
  // House-number typeahead: known addresses by what was typed.
  const [addrOpen, setAddrOpen] = useState(false);
  const addrWrapRef = useRef<HTMLDivElement | null>(null);

  // Managers and the owner search the customer list as they type; the
  // counter finds one customer by the whole number (see the header).
  const canBrowse = useSessionStore((s) => s.can('customers.manage'));
  const lookup = counterPhoneLookup(form.phone);

  // Debounced lookup for phone autocomplete.
  const suggestionsQ = useQuery({
    queryKey: ['customers', 'inlineSearch', form.phone],
    queryFn: () => ipc.customers.list({ search: form.phone, limit: 6 }),
    enabled: canBrowse && form.phone.length >= 2 && !form.matchedCustomerId,
  });

  const exactQ = useQuery({
    queryKey: ['customers', 'byPhone', lookup.canonical],
    queryFn: () => ipc.customers.findByPhone(lookup.canonical ?? ''),
    enabled: !canBrowse && lookup.canonical !== null && !form.matchedCustomerId,
  });
  const matches = canBrowse ? (suggestionsQ.data ?? []) : exactQ.data ? [exactQ.data] : [];
  const counterHint = canBrowse ? null : counterPhoneHint(lookup, exactQ.isFetching, !!exactQ.data);

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
    enabled: canBrowse && !!form.matchedCustomerId,
  });

  // "41-C" typed at the counter → every saved address starting with it, with
  // the customer it belongs to. Regulars are known by their house number.
  // A search of everyone's addresses, so managers and the owner only.
  const addrMatchesQ = useQuery({
    queryKey: ['customers', 'addressSearch', form.addressLine.trim().toLowerCase()],
    queryFn: () => ipc.customers.searchAddresses(form.addressLine.trim(), 6),
    enabled: canBrowse && mode === 'delivery' && form.addressLine.trim().length >= 2 && !form.matchedAddressId,
  });
  const addrMatches = !canBrowse || form.matchedAddressId ? [] : (addrMatchesQ.data ?? []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!addrWrapRef.current) return;
      if (!addrWrapRef.current.contains(e.target as Node)) setAddrOpen(false);
    }
    if (addrOpen) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [addrOpen]);

  function pickAddressMatch(a: CustomerAddressMatch) {
    setAddrOpen(false);
    setForm((prev) => ({
      ...prev,
      matchedAddressId: a.id,
      makeDefault: false,
      addressLabel: a.label,
      addressLine: a.addressLine,
      area: a.area ?? '',
      city: a.city ?? DELIVERY_CITY,
      // The house tells us who it is, unless the cashier already picked someone.
      ...(prev.matchedCustomerId
        ? {}
        : { matchedCustomerId: a.customerId, name: a.customerName, phone: a.customerPhone ?? prev.phone }),
    }));
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
        makeDefault: false,
        addressLabel: def.label,
        addressLine: def.addressLine,
        area: def.area ?? '',
        city: def.city ?? DELIVERY_CITY,
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
      makeDefault: false,
      phone: customer.phone ?? prev.phone,
      name: customer.name,
    }));
  }

  // At the counter the whole number finds at most one customer: fill them in
  // straight away while the name is still empty (the "Existing customer" pill
  // undoes it), so a regular takes no extra tap.
  const exactMatch = canBrowse ? null : (exactQ.data ?? null);
  useEffect(() => {
    if (!exactMatch || form.matchedCustomerId || form.name.trim()) return;
    pickSuggestion(exactMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exactMatch?.id]);

  function pickSavedAddress(a: CustomerAddress) {
    setForm((prev) => ({
      ...prev,
      matchedAddressId: a.id,
      makeDefault: false,
      addressLabel: a.label,
      addressLine: a.addressLine,
      area: a.area ?? '',
      city: a.city ?? DELIVERY_CITY,
    }));
  }

  function unmatch() {
    setForm((prev) => ({
      ...prev,
      matchedCustomerId: null,
      matchedAddressId: null,
      makeDefault: false,
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
          onKeyDown={(e) => {
            // One match (always so at the counter): Enter takes it.
            if (e.key === 'Enter' && phoneOpen && !form.matchedCustomerId && matches.length === 1 && matches[0]) {
              e.preventDefault();
              pickSuggestion(matches[0]);
            }
          }}
          placeholder={canBrowse ? '+92 300…' : '0300 1234567'}
          className="cust-input is-mono"
        />
        {phoneOpen && form.phone.length >= 2 && !form.matchedCustomerId && (
          <div className="cust-dropdown-wrap">
            {counterHint !== null ? (
              <div className="p-2 text-xs text-stone-500" role="status">
                {counterHint}
              </div>
            ) : matches.length === 0 ? (
              <div className="p-2 text-xs text-stone-500">
                No match. Fill name + address — we'll save this customer with the order.
              </div>
            ) : (
              <ul className="max-h-56 overflow-auto">
                {matches.map((c) => (
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
                  // Leaving a saved address: its "use next time" tick does not carry over to the typing.
                  setForm((p) => ({
                    ...p,
                    addressLine: e.target.value,
                    matchedAddressId: null,
                    makeDefault: p.matchedAddressId ? false : p.makeDefault,
                  }));
                  setAddrOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setAddrOpen(false);
                  if (e.key === 'Enter' && addrOpen && addrMatches[0]) {
                    e.preventDefault();
                    pickAddressMatch(addrMatches[0]);
                  }
                }}
                placeholder="House 41-C, Lane 3 (house and street)"
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
            {/* The area gets the whole row: its list, fee and "which phase?" chips need the width. */}
            <div style={{ gridColumn: '1 / -1' }}>
              <AreaPicker
                value={form.area}
                onChange={(area) =>
                  setForm((p) => ({
                    ...p,
                    area,
                    city: DELIVERY_CITY,
                    matchedAddressId: null,
                    makeDefault: p.matchedAddressId ? false : p.makeDefault,
                  }))
                }
              />
            </div>
          </div>
          <DeliveryChargeRow area={form.area} phone={form.phone} />
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
          {/* Kept, for a customer with a usual address already: replace it only when asked
              (a one-day office delivery must not become where their pizza goes next week). */}
          {form.matchedCustomerId &&
            form.addressLine &&
            !form.matchedAddressId &&
            form.saveAddressToCustomer &&
            savedAddresses.length > 0 && (
              <label className="flex items-center gap-1 text-[10px] text-stone-500">
                <input
                  type="checkbox"
                  checked={form.makeDefault}
                  onChange={(e) => setForm((p) => ({ ...p, makeDefault: e.target.checked }))}
                />
                Use it next time instead of their usual address (they moved)
              </label>
            )}
          {/* A saved address that is not the usual one: make it the one filled in next time. */}
          {form.matchedCustomerId &&
            form.matchedAddressId &&
            savedAddresses.some((a) => a.id === form.matchedAddressId && !a.isDefault) && (
              <label className="flex items-center gap-1 text-[10px] text-stone-500">
                <input
                  type="checkbox"
                  checked={form.makeDefault}
                  onChange={(e) => setForm((p) => ({ ...p, makeDefault: e.target.checked }))}
                />
                Use this address for {customerDetailQ.data?.name ?? 'customer'} next time
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
            New customer
          </span>
        ) : (
          <span className="text-[10px] text-stone-500">No customer yet</span>
        )}
        {canBrowse && form.matchedCustomerId && (customerHistoryQ.data?.length ?? 0) > 0 && (
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
 * The picked area's delivery charge — on the bill BY ITSELF (owner, 28 Sep
 * 2026: "if delivery area selected the delivery fee should be automatically
 * added"). The main process decides, on every path that gives the order its
 * area (order-repo deliveryChargeForArea): this panel's area, the customer
 * saved at Send and Pay, the order becoming a delivery. The area's fee item
 * (Settings → Delivery areas) goes on, a charge at another fee is swapped,
 * none when the area is cleared, free or switched off, never twice; and
 * only when the area CHANGES, so a charge taken off by hand stays off. A
 * charge at another fee on the bill (the fee raised while the order was
 * open, or another tapped on by hand) is named with the area's fee, with one
 * tap to swap it (pos-domain deliveryChargeRowState).
 * This row tells the main process the panel's area (a moment after the last
 * keystroke — nothing depends on that moment: Send and Pay save the address
 * with its area themselves), and only SHOWS what the bill carries, with
 * "Take it off" / "Put it back". It never tells "no area" for an empty form
 * it did not see filled (pos-domain makeDeliveryAreaTeller): an order-type switch and a
 * restart empty the form, not the order's area.
 *
 * Add-on delivery (the owner, 2 Oct 2026: "if its out then it should charge
 * if the rider is not out"): the row tells the panel's phone with the area
 * (deliveryTellPhone), and the main process leaves the area's charge off
 * while the same phone has another delivery still in the shop. The row then
 * says so in green — "Goes with #0042: no second delivery charge" — with
 * "Put it back" (OrderSnapshot.addOnTo). No phone simply means no add-on
 * rule: the phone stays optional.
 */
function DeliveryChargeRow({ area, phone }: { area: string; phone: string }) {
  const A = useDeliveryAreas();
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const mode = useCheckoutStore((s) => s.mode);
  const busy = useCheckoutStore((s) => s.busy);
  const setDeliveryArea = useCheckoutStore((s) => s.setDeliveryArea);
  const removeItem = useCheckoutStore((s) => s.removeItem);
  const { toast } = useToast();
  // Same query (and cache) as the menu grid's "All" view.
  const itemsQ = useQuery({
    queryKey: ['menu', 'items', { categoryId: null, activeOnly: true }],
    queryFn: () => ipc.menu.listItems({ activeOnly: true }),
    staleTime: 60_000,
  });
  const target = useMemo(() => deliveryChargeTarget(A, mode, area, itemsQ.data ?? []), [A, mode, area, itemsQ.data]);
  const wouldAdd = target.kind === 'fee' && target.itemId !== null;
  const orderId = snapshot && snapshot.order.status === 'open' ? snapshot.order.id : null;
  // The phone told with the area (the add-on rule): a whole number, none once emptied, and the one
  // told before while a digit is being typed or fixed (deliveryTellPhone).
  const tellPhoneRef = useRef<string | null>(null);
  const tellPhone = deliveryTellPhone(tellPhoneRef.current, phone);
  tellPhoneRef.current = tellPhone;
  // What the row last told the main process (order · type · area · phone): until then the bill may not show it yet.
  const key = `${orderId ?? ''}|${mode}|${area.trim()}|${normalizePhone(tellPhone) ?? ''}`;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  // What this row has told the main process: an empty form it never saw filled (an order-type
  // switch or a restart empties it) is not "no area" — the order keeps its area and charge.
  const tellerRef = useRef<DeliveryAreaTeller | null>(null);
  if (!tellerRef.current) tellerRef.current = makeDeliveryAreaTeller();
  const teller = tellerRef.current;

  useEffect(() => {
    if (!teller.shouldTell(orderId, area)) {
      setSettledKey(key);
      return;
    }
    const t = setTimeout(() => {
      teller.told(orderId, area);
      setDeliveryArea(area, { mayStartOrder: wouldAdd, forOrderId: orderId, phone: tellPhone }).then(
        () => setSettledKey(key),
        (e: unknown) => {
          setSettledKey(key);
          toast({
            title: 'Could not put the delivery charge on',
            description: e instanceof Error ? e.message : 'Unknown error',
            variant: 'error',
          });
        },
      );
    }, 250);
    return () => clearTimeout(t);
    // wouldAdd follows area/mode/menu, tellPhone the key's phone; the key decides what the main process is told.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wouldAdd, setDeliveryArea, toast]);

  const words = deliveryChargeWords(target);
  if (!words) return null;
  const base = 'mt-1 flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs';
  const amber = cn(base, 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200');

  if (target.kind !== 'fee') {
    return (
      <div className={amber}>
        <span className="inline-flex items-center gap-1">
          {(target.kind === 'none' && target.reason === 'paused') || (target.kind === 'leave' && target.pausedName) ? (
            <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Bike className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {words}
        </span>
      </div>
    );
  }

  const feeIds = deliveryZoneFeeItemIds(A.zones);
  const lines = (snapshot?.items ?? []).filter((l) => isDeliveryChargeLine(l, feeIds));
  const right = lines.filter((l) => l.unitPriceCents === target.feeCents);
  const pill = 'inline-flex min-h-[32px] items-center gap-1 rounded-full px-3 font-semibold';
  const failed = (title: string) => (e: unknown) =>
    toast({ title, description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });

  if (!target.itemId) {
    return (
      <div className={amber}>
        <span className="inline-flex items-center gap-1">
          <Bike className="h-3.5 w-3.5" aria-hidden="true" />
          {words}
        </span>
      </div>
    );
  }

  // "Put it back" with the phone told: it then holds while the area and the delivery it goes with stay the same.
  const putBack = () =>
    void setDeliveryArea(area, { putBack: true, forOrderId: orderId, phone: tellPhone }).catch(
      failed('Could not put the delivery charge on'),
    );

  // An add-on: the till left the area's charge off because the same customer's delivery has not
  // gone out yet (as the main process last settled it). A charge on the bill anyway (tapped on by
  // hand) reads as the bill has it, below.
  const addOnTo = snapshot?.addOnTo ?? null;
  if (addOnTo && orderId && lines.length === 0) {
    return <AddOnChargeRow addOnTo={addOnTo} onPutBack={busy ? null : putBack} />;
  }

  // Still being told the area (a moment after it changed), the bill may not show its charge yet;
  // once the till has answered, none on the bill means it was taken off by hand.
  const settling = busy || !orderId || settledKey !== key;
  const row = deliveryChargeRowState(target.feeCents, lines, !settling);

  if (row.kind === 'on') {
    return (
      <div className={cn(base, 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200')}>
        <span className="inline-flex items-center gap-1">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {row.text}
          {row.qty > 1 && <strong className="ml-1 text-amber-700 dark:text-amber-300">— {row.qty} times, check it</strong>}
        </span>
        {!busy && orderId && (
          <button
            type="button"
            onClick={() => {
              // Taken off by hand: it stays off until the area changes, or "Put it back" (the removal is audited).
              for (const l of right) void removeItem(l.id).catch(failed('Could not take the delivery charge off'));
            }}
            className={cn(pill, 'bg-white/70 text-emerald-900 hover:bg-white dark:bg-stone-800 dark:text-emerald-100')}
          >
            <X className="h-3.5 w-3.5" /> Take it off
          </button>
        )}
      </div>
    );
  }

  // A charge at another fee on the bill: both fees, and one tap swaps it ("Put it back" in the
  // main process: the area's charge on, the others off). Never "taken off by hand".
  if (row.kind === 'other') {
    return (
      <div className={amber}>
        <span className="inline-flex items-center gap-1">
          <Bike className="h-3.5 w-3.5" aria-hidden="true" />
          {row.text}
        </span>
        {!busy && orderId && (
          <button type="button" onClick={putBack} className={cn(pill, 'bg-amber-500 text-stone-900 hover:bg-amber-400')}>
            <RefreshCw className="h-3.5 w-3.5" /> {row.action}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={amber}>
      <span className="inline-flex items-center gap-1">
        <Bike className="h-3.5 w-3.5" aria-hidden="true" />
        {row.text}
      </span>
      {row.kind === 'off' && (
        <button type="button" onClick={putBack} className={cn(pill, 'bg-amber-500 text-stone-900 hover:bg-amber-400')}>
          <Plus className="h-3.5 w-3.5" /> {row.action}
        </button>
      )}
    </div>
  );
}

/** "Goes with #0042: no second delivery charge" — the add-on row's words (OrderSnapshot.addOnTo). */
export function addOnChargeWords(addOnTo: NonNullable<OrderSnapshot['addOnTo']>): string {
  const n = addOnTo.orderNumber.split('-').pop() ?? addOnTo.orderNumber;
  return `Goes with #${n}: no second delivery charge`;
}

/**
 * The delivery-charge row of an add-on (the owner, 2 Oct 2026: "if its out
 * then it should charge if the rider is not out"): green, the delivery it
 * goes with, and "Put it back" (the area's charge on; it stays on while the
 * area and that delivery stay the same). `onPutBack` null: no button for
 * now (a change on its way to the till).
 */
export function AddOnChargeRow({
  addOnTo,
  onPutBack,
}: {
  addOnTo: NonNullable<OrderSnapshot['addOnTo']>;
  onPutBack: (() => void) | null;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
      <span className="inline-flex items-center gap-1">
        <Bike className="h-3.5 w-3.5" aria-hidden="true" />
        {addOnChargeWords(addOnTo)}
      </span>
      {onPutBack && (
        <button
          type="button"
          onClick={onPutBack}
          className="inline-flex min-h-[32px] items-center gap-1 rounded-full bg-white/70 px-3 font-semibold text-emerald-900 hover:bg-white dark:bg-stone-800 dark:text-emerald-100"
        >
          <Plus className="h-3.5 w-3.5" /> Put it back
        </button>
      )}
    </div>
  );
}

/**
 * The phone the delivery-charge row tells with the area (the add-on rule,
 * OrderSnapshot.addOnTo), from the one it told before (`told`) and what is
 * in the phone box now (`typed`):
 *  - a whole number (pos-domain normalizePhone): that number, as typed;
 *  - the box emptied: none (null) — no phone, no add-on rule;
 *  - anything else (a digit being typed, deleted or fixed): the one told
 *    before. One digit short is not another customer: telling it would put
 *    the charge back on, and lose a "Put it back", at every keystroke.
 */
export function deliveryTellPhone(told: string | null, typed: string): string | null {
  const t = typed.trim();
  if (!t) return null;
  return normalizePhone(t) ? t : told;
}

/**
 * Persist whatever's in the form to the order at tender time.
 * - If the phone matched an existing customer → reuse.
 * - Else if name+phone given → create the customer.
 * - If the user picked a saved address → use it.
 * - Else if address fields are filled → save them on the customer (kept: on
 *   their list; unticked: as a "One-off"), the usual one only when "use it
 *   next time" is ticked too.
 * - Attach customer + chosen address + delivery notes to the order.
 * - No customer typed in, only an "Order notes" ("collect by 7pm"): the note
 *   goes on the order by itself — it used to be dropped here, unsaved.
 * - The order's note is what the box says now, with or without a customer:
 *   an emptied box takes off a note saved by an earlier Pay or Send that did
 *   not go through (a payment refused with no shift open), so it does not
 *   print on the kitchen ticket or the bill. The same words again write
 *   nothing (setOrderDeliveryNotes).
 * - A saved address picked with "use it next time" becomes the usual one.
 *
 * Resolves with the customer and address now on the order (null when none
 * was written), so the form can point at them: Pay saves the customer before
 * it opens, and a second save (a note changed after closing Pay) then reuses
 * them instead of adding the address, or a nameless customer, again. With
 * them, `snapshot`: the order as the till answered the save (the phone now
 * saved on it, so its offerHeldBy and addOnTo are worked out), or null.
 */
export async function commitCustomerToOrder(
  orderId: string,
  mode: 'dine_in' | 'takeaway' | 'delivery' | 'online' | 'foodpanda',
  form: CustomerFormState,
): Promise<{ customerId: string; addressId: string | null; snapshot: OrderSnapshot | null } | null> {
  if (mode === 'dine_in' || mode === 'online' || mode === 'foodpanda') return null;
  const note = form.deliveryNotes.trim() || null;
  if (!form.phone.trim() && !form.name.trim() && !form.addressLine.trim()) {
    await ipc.orders.setNote({ orderId, note });
    return null;
  }
  try {
    return await saveTypedCustomer(orderId, mode, form, note);
  } finally {
    // Saved (or tried): the phone typed next is looked up again, not "No match" from
    // before this save (customerLookups.ts, e2e smoke bug 3).
    customersChanged();
  }
}

/** commitCustomerToOrder's save, once something was typed: the customer, a typed address, the order. */
async function saveTypedCustomer(
  orderId: string,
  mode: 'takeaway' | 'delivery',
  form: CustomerFormState,
  note: string | null,
): Promise<{ customerId: string; addressId: string | null; snapshot: OrderSnapshot | null }> {
  let customerId = form.matchedCustomerId;
  // The name on the reused customer's master record, to compare against
  // what the till typed for this order.
  let masterName: string | null = null;
  // Their saved addresses, as stored (for "use this address next time").
  let savedAddresses: CustomerAddress[] = [];

  if (customerId) {
    const master = await ipc.customers.get(customerId);
    masterName = master?.name ?? null;
    savedAddresses = master?.addresses ?? [];
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
  // A typed address is saved either way (the order needs an address row to
  // point at); "One-off" keeps a do-not-save address out of the customer's
  // usual list of places, and a kept one is filled in next time.
  const typedAddress = typedAddressToSave(form, mode, DELIVERY_CITY);
  if (typedAddress) {
    addressId = (await ipc.customers.createAddress({ customerId, ...typedAddress })).id;
  }

  const attached = await ipc.customers.attachToOrder({
    orderId,
    customerId,
    addressId,
    deliveryNotes: note,
    ...(nameOverride ? { nameOverride } : {}),
  });

  // "Use this address next time" on a saved address: after the order has its
  // customer, and never in the way of the sale.
  const usual = savedAddressToMakeUsual(form, mode, savedAddresses);
  if (usual) {
    try {
      await ipc.customers.createAddress({ customerId, ...usual });
    } catch (e) {
      console.warn('Could not make the address the usual one (order not affected):', e);
    }
  }
  // The till's answer is the order with the customer on it (a stand-in may answer nothing).
  const snapshot = attached && typeof attached === 'object' && 'order' in attached ? attached : null;
  return { customerId, addressId, snapshot };
}

/**
 * The form once its customer is saved on the order: it points at the saved
 * customer and address, so saving it again reuses them (no second address,
 * no second nameless customer). "Use it next time" was done by that save.
 */
export function formAfterCommit(
  form: CustomerFormState,
  saved: { customerId: string; addressId: string | null },
): CustomerFormState {
  return {
    ...form,
    matchedCustomerId: saved.customerId,
    matchedAddressId: saved.addressId ?? form.matchedAddressId,
    makeDefault: false,
  };
}
