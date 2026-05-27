import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { CustomerDialog, AddressDialog } from '../customers/CustomersPage';
import type { Customer, CustomerAddress } from '@cheeseoclock/shared-types';
import { X, Phone, Plus, UserPlus, MapPin } from 'lucide-react';

interface Props {
  /** When mode is delivery, force the cashier to also pick an address. */
  requireAddress?: boolean;
  /** Pre-fill the search box. */
  initialSearch?: string;
  onClose: () => void;
  onPicked: (customer: Customer, address: CustomerAddress | null, deliveryNotes: string | null) => void;
}

export function CustomerPickerDialog({ requireAddress, initialSearch, onClose, onPicked }: Props) {
  const [phone, setPhone] = useState(initialSearch ?? '');
  const [picked, setPicked] = useState<Customer | null>(null);
  const [pickedAddress, setPickedAddress] = useState<CustomerAddress | null>(null);
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [creatingAddress, setCreatingAddress] = useState(false);

  // Search by phone OR name
  const searchQ = useQuery({
    queryKey: ['customers', 'search', phone],
    queryFn: () => ipc.customers.list({ search: phone, limit: 20 }),
    enabled: phone.length >= 2 && !picked,
  });

  // Once picked, load their full details (addresses)
  const detailQ = useQuery({
    queryKey: ['customers', 'detail', picked?.id],
    queryFn: () => (picked ? ipc.customers.get(picked.id) : Promise.resolve(null)),
    enabled: !!picked,
  });

  // Default-select the customer's default address once details load
  useEffect(() => {
    if (detailQ.data && !pickedAddress) {
      const def = detailQ.data.addresses.find((a) => a.isDefault) ?? detailQ.data.addresses[0];
      if (def) setPickedAddress(def);
    }
  }, [detailQ.data, pickedAddress]);

  function confirmSelection() {
    if (!picked) return;
    if (requireAddress && !pickedAddress) {
      return;
    }
    onPicked(picked, pickedAddress, deliveryNotes || null);
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <Dialog.Title className="text-lg font-bold">
              {picked ? 'Confirm customer' : 'Pick customer'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-auto p-5">
            {!picked && (
              <>
                <div className="relative mb-3">
                  <Phone className="absolute left-3 top-3 h-4 w-4 text-stone-400" />
                  <input
                    type="tel"
                    autoFocus
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Type phone or name…"
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 pl-9 font-mono dark:border-stone-700 dark:bg-stone-800"
                  />
                </div>
                {phone.length < 2 ? (
                  <div className="py-6 text-center text-sm text-stone-500">
                    Start typing to search existing customers.
                  </div>
                ) : (searchQ.data ?? []).length === 0 ? (
                  <div className="text-center">
                    <div className="py-4 text-sm text-stone-500">
                      No customer found with "{phone}".
                    </div>
                    <Button variant="primary" onClick={() => setCreatingCustomer(true)}>
                      <UserPlus className="h-4 w-4" /> Create new customer
                    </Button>
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {searchQ.data?.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setPicked(c)}
                          className="flex w-full items-center justify-between rounded-lg border border-stone-200 p-3 text-left hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
                        >
                          <div>
                            <div className="font-medium">{c.name}</div>
                            <div className="text-xs text-stone-500">
                              {c.phone ? <span className="font-mono">{c.phone}</span> : 'no phone'}
                              {c.email ? ` · ${c.email}` : ''}
                            </div>
                          </div>
                          {c.loyaltyPoints > 0 && (
                            <div className="text-xs text-amber-600 dark:text-amber-300">
                              {c.loyaltyPoints} pts
                            </div>
                          )}
                        </button>
                      </li>
                    ))}
                    <li>
                      <button
                        type="button"
                        onClick={() => setCreatingCustomer(true)}
                        className="mt-2 inline-flex items-center gap-1 text-sm text-amber-700 hover:underline dark:text-amber-300"
                      >
                        <Plus className="h-3 w-3" /> Create new instead
                      </button>
                    </li>
                  </ul>
                )}
              </>
            )}

            {picked && (
              <div>
                <div className="mb-4 rounded-lg bg-stone-100 p-3 dark:bg-stone-800">
                  <div className="font-semibold">{picked.name}</div>
                  <div className="text-xs text-stone-500">
                    {picked.phone ? <span className="font-mono">{picked.phone}</span> : 'no phone'}
                    {picked.email ? ` · ${picked.email}` : ''}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked(null);
                      setPickedAddress(null);
                    }}
                    className="mt-1 text-xs text-stone-500 underline"
                  >
                    Change customer
                  </button>
                </div>

                {requireAddress && (
                  <section>
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs uppercase tracking-wider text-stone-500">
                        Delivery address
                      </h3>
                      <button
                        type="button"
                        onClick={() => setCreatingAddress(true)}
                        className="inline-flex items-center gap-1 text-xs text-amber-700 hover:underline dark:text-amber-300"
                      >
                        <Plus className="h-3 w-3" /> Add new
                      </button>
                    </div>
                    {detailQ.data?.addresses.length ? (
                      <ul className="space-y-1">
                        {detailQ.data.addresses.map((a) => (
                          <li key={a.id}>
                            <button
                              type="button"
                              onClick={() => setPickedAddress(a)}
                              className={cn(
                                'flex w-full items-start gap-2 rounded-lg border-2 p-3 text-left transition-colors',
                                pickedAddress?.id === a.id
                                  ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                                  : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                              )}
                            >
                              <MapPin className="mt-0.5 h-4 w-4 text-stone-400" />
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{a.label}</span>
                                  {a.isDefault && (
                                    <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-stone-700 dark:bg-stone-700 dark:text-stone-300">
                                      default
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-stone-500">
                                  {a.addressLine}
                                  {a.area ? `, ${a.area}` : ''}
                                  {a.city ? `, ${a.city}` : ''}
                                </div>
                                {a.notes && <div className="text-xs text-stone-400">{a.notes}</div>}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="rounded-lg border-2 border-dashed border-stone-200 p-4 text-center text-sm text-stone-500 dark:border-stone-700">
                        No address on file. Add one before continuing.
                      </div>
                    )}
                    <div className="mt-3">
                      <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                        Delivery notes for this order
                      </label>
                      <input
                        type="text"
                        value={deliveryNotes}
                        onChange={(e) => setDeliveryNotes(e.target.value)}
                        placeholder="e.g. extra ketchup, call before arrival"
                        className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                      />
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>

          <footer className="flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!picked || (requireAddress && !pickedAddress)}
              onClick={confirmSelection}
            >
              Attach to order
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>

      {creatingCustomer && (
        <CustomerDialog
          existing={null}
          onClose={() => setCreatingCustomer(false)}
          onCreated={(c) => {
            setPicked(c);
            setCreatingCustomer(false);
          }}
        />
      )}
      {creatingAddress && picked && (
        <AddressDialog
          customerId={picked.id}
          onClose={() => setCreatingAddress(false)}
          onCreated={(a) => {
            setPickedAddress(a);
            setCreatingAddress(false);
          }}
        />
      )}
    </Dialog.Root>
  );
}
