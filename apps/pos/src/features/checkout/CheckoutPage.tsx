import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CategoryRail } from './CategoryRail';
import { ItemGrid } from './ItemGrid';
import { CartPane } from './CartPane';
import { OrderModeBar } from './OrderModeBar';
import { ModifierModal } from './ModifierModal';
import { TenderDialog } from './TenderDialog';
import { ReceiptDialog } from './ReceiptDialog';
import { DiscountDialog } from './DiscountDialog';
import { useTenderGate } from './useTenderGate';
import { useToast } from '../../components/toast/ToastProvider';
import type { MenuItem } from '@cheeseoclock/shared-types';
import { Search, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';

export function CheckoutPage() {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [modifierForItem, setModifierForItem] = useState<MenuItem | null>(null);
  const [tenderOpen, setTenderOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [search, setSearch] = useState('');

  const snapshot = useCheckoutStore((s) => s.snapshot);
  const reset = useCheckoutStore((s) => s.reset);
  const resumeDraft = useCheckoutStore((s) => s.resumeDraft);
  const gate = useTenderGate();
  const { toast } = useToast();

  // After a restart the cashier's half-built order is still 'open' in the
  // database but gone from the screen. Pick it back up once per mount so it is
  // never orphaned — and so Pay / Send to kitchen act on the order they can see.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    if (useCheckoutStore.getState().snapshot) return;
    resumeDraft()
      .then((snap) => {
        if (!snap) return;
        toast({
          title: 'Unfinished order restored',
          description: `Order #${snap.order.orderNumber} was still open from before — carry on, or discard it with the ✕ beside the order number.`,
        });
      })
      .catch(() => {
        // Nothing to restore, or the till is not ready yet: start with an empty cart.
      });
  }, [resumeDraft, toast]);

  const categoriesQ = useQuery({
    queryKey: ['menu', 'categories', { activeOnly: true }],
    queryFn: () => ipc.menu.listCategories({ activeOnly: true }),
  });
  const itemsQ = useQuery({
    queryKey: ['menu', 'items', { categoryId: selectedCategoryId, activeOnly: true }],
    queryFn: () =>
      ipc.menu.listItems({
        ...(selectedCategoryId ? { categoryId: selectedCategoryId } : {}),
        activeOnly: true,
      }),
  });

  const visibleItems = (itemsQ.data ?? []).filter((item) =>
    `${item.name} ${item.description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  // F-key shortcuts. F1 = pay, F3 = discount, Esc = cancel modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (modifierForItem || tenderOpen || receiptOpen || discountOpen) {
        if (e.key === 'Escape') {
          if (receiptOpen) {
            setReceiptOpen(false);
            reset();
          } else if (tenderOpen) setTenderOpen(false);
          else if (discountOpen) setDiscountOpen(false);
          else if (modifierForItem) setModifierForItem(null);
        }
        return;
      }
      if (e.key === 'F1' && snapshot && snapshot.items.length > 0) {
        e.preventDefault();
        if (!gate.ok) {
          toast({
            title: 'Cannot pay yet',
            description: gate.missing.join(' · '),
            variant: 'warning',
          });
          return;
        }
        setTenderOpen(true);
      } else if (e.key === 'F3' && snapshot && snapshot.items.length > 0) {
        e.preventDefault();
        setDiscountOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modifierForItem, tenderOpen, receiptOpen, discountOpen, snapshot, reset, gate, toast]);

  async function handleAddItem(item: MenuItem) {
    // If the item has modifier groups, open the modal first.
    const groups = await ipc.menu.listModifierGroupsForItem(item.id);
    if (groups.length > 0) {
      setModifierForItem(item);
      return;
    }
    try {
      await useCheckoutStore.getState().addItem(item.id);
    } catch (e) {
      toast({
        title: 'Could not add item',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    }
  }

  function handlePaid() {
    setTenderOpen(false);
    setReceiptOpen(true);
  }

  function handleReceiptClose() {
    setReceiptOpen(false);
    reset();
  }

  async function handleSendToKitchen() {
    try {
      const next = await useCheckoutStore.getState().sendToKitchen();
      toast({
        title: 'Sent to kitchen',
        description: `Order #${next.order.orderNumber.split('-').pop()} is now on the Live Orders board.`,
      });
      reset();
    } catch (e) {
      toast({
        title: 'Could not send',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    }
  }

  return (
    <div className="checkout-page">
      <OrderModeBar />
      <button type="button" className="checkout-order-jump" onClick={() => document.getElementById('checkout-order')?.scrollIntoView({ block: 'start' })}>
        <span>View order · {snapshot?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0} items</span>
        <strong>{formatCents(snapshot?.order.totalCents ?? 0)}</strong>
      </button>
      <div className="checkout-workspace">
        <section className="checkout-menu" aria-label="Menu">
          <div className="checkout-menu-heading">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Build an order</h1>
              <p className="text-sm text-stone-500">Choose an item to add it to the order.</p>
            </div>
            <label className="checkout-search">
              <Search className="h-4 w-4 shrink-0 text-stone-500" aria-hidden="true" />
              <input aria-label="Search menu" placeholder="Search this menu…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}><X className="h-4 w-4" /></button>}
            </label>
          </div>
        <CategoryRail
          categories={categoriesQ.data ?? []}
          selectedId={selectedCategoryId}
          onSelect={setSelectedCategoryId}
        />
        <div className="checkout-items">
          {itemsQ.isLoading ? <p role="status" className="p-6 text-stone-500">Loading menu…</p>
            : itemsQ.isError || categoriesQ.isError ? <div role="alert" className="p-6 text-red-700">Could not load the menu. <button className="underline" onClick={() => { void itemsQ.refetch(); void categoriesQ.refetch(); }}>Try again</button></div>
            : search && visibleItems.length === 0 ? <div role="status" className="py-12 text-center text-stone-500">No items match “{search}”. Try another name or category.</div>
            : <ItemGrid items={visibleItems} onAdd={handleAddItem} />}
        </div>
        </section>
        <CartPane
          onPay={() => setTenderOpen(true)}
          onDiscount={() => setDiscountOpen(true)}
          onSendToKitchen={handleSendToKitchen}
        />
      </div>

      {modifierForItem && (
        <ModifierModal
          item={modifierForItem}
          onCancel={() => setModifierForItem(null)}
          onConfirm={async (modifierIds) => {
            setModifierForItem(null);
            try {
              await useCheckoutStore.getState().addItem(modifierForItem.id, 1, modifierIds);
            } catch (e) {
              toast({
                title: 'Could not add item',
                description: e instanceof Error ? e.message : 'Unknown error',
                variant: 'error',
              });
            }
          }}
        />
      )}

      {tenderOpen && snapshot && (
        <TenderDialog
          snapshot={snapshot}
          onClose={() => setTenderOpen(false)}
          onPaid={handlePaid}
        />
      )}

      {discountOpen && snapshot && (
        <DiscountDialog onClose={() => setDiscountOpen(false)} />
      )}

      {receiptOpen && snapshot && (
        <ReceiptDialog snapshot={snapshot} onClose={handleReceiptClose} />
      )}
    </div>
  );
}
