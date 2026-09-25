import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CategoryRail } from './CategoryRail';
import { ItemGrid } from './ItemGrid';
import { PizzaSizeDialog } from './PizzaSizeDialog';
import type { MenuChoice } from './pizzaChoices';
import { CartPane } from './CartPane';
import { OrderDetails } from './OrderDetails';
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
  /** The cart line being customised (leave-outs, extras, allergy note). */
  const [customizeLineId, setCustomizeLineId] = useState<string | null>(null);
  const [pizzaChoice, setPizzaChoice] = useState<MenuChoice | null>(null);
  const sizeTriggerRef = useRef<HTMLElement | null>(null);
  const [tenderOpen, setTenderOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [checkoutStep, setCheckoutStep] = useState<'items' | 'details'>('items');
  const searchRef = useRef<HTMLInputElement | null>(null);

  const snapshot = useCheckoutStore((s) => s.snapshot);
  const mode = useCheckoutStore((s) => s.mode);
  const busy = useCheckoutStore((s) => s.busy);
  const reset = useCheckoutStore((s) => s.reset);
  const resumeDraft = useCheckoutStore((s) => s.resumeDraft);
  const gate = useTenderGate();
  const { toast } = useToast();
  const needsCustomer = mode === 'takeaway' || mode === 'delivery';
  const hasItems = (snapshot?.items.length ?? 0) > 0;

  useEffect(() => {
    setCheckoutStep('items');
  }, [snapshot?.order.id, mode, hasItems]);

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

  const customizeLine = customizeLineId ? snapshot?.items.find((i) => i.id === customizeLineId) ?? null : null;
  // The line's menu item (name, description, price) from the menu the grid shows;
  // a line whose item has since left the menu cannot be customised.
  const customizeItem = customizeLine
    ? (itemsQ.data ?? []).find((m) => m.id === customizeLine.menuItemId) ?? null
    : null;
  const visibleItems = (itemsQ.data ?? []).filter((item) =>
    `${item.name} ${item.description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

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

  // Keys a cashier can hit without looking: F1 pay, F2 send, F3 discount,
  // "/" jumps to search, Esc closes whatever is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (pizzaChoice || modifierForItem || tenderOpen || receiptOpen || discountOpen) {
        if (e.key === 'Escape') {
          if (pizzaChoice) setPizzaChoice(null);
          else if (receiptOpen) {
            setReceiptOpen(false);
            reset();
          } else if (tenderOpen) setTenderOpen(false);
          else if (discountOpen) setDiscountOpen(false);
          else if (modifierForItem) setModifierForItem(null);
        }
        return;
      }
      if (e.key === 'Escape' && checkoutStep === 'details' && !busy && document.activeElement?.tagName !== 'INPUT') {
        setCheckoutStep('items');
        return;
      }
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!hasItems || busy) return;
      if (e.key === 'F1' || e.key === 'F2') {
        e.preventDefault();
        if (needsCustomer && checkoutStep === 'items') {
          setCheckoutStep('details');
          return;
        }
        if (!gate.ok) {
          toast({ title: e.key === 'F1' ? 'Cannot pay yet' : 'Cannot send yet', description: gate.missing.join(' · '), variant: 'warning' });
          return;
        }
        // Foodpanda has no 'send unpaid': F2 takes the payment too.
        if (e.key === 'F1' || mode === 'foodpanda') setTenderOpen(true);
        else void handleSendToKitchen();
      } else if (e.key === 'F3') {
        e.preventDefault();
        setDiscountOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pizzaChoice, modifierForItem, tenderOpen, receiptOpen, discountOpen, snapshot, reset, gate, toast, checkoutStep, needsCustomer, hasItems, busy, mode]);

  function handleChooseSize(choice: MenuChoice) {
    sizeTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPizzaChoice(choice);
  }

  async function handleAddItem(item: MenuItem) {
    try {
      // Only a choice the item cannot be sold without (a dip, the five veggies,
      // a deal's pizzas) opens the choices first. Leave-outs, extras and the
      // allergy note are optional: the item goes straight in, and "Customize"
      // on its cart line opens them — so every pizza is still one tap.
      const groups = await ipc.menu.listModifierGroupsForItem(item.id);
      if (groups.some((g) => g.isRequired || g.minSelect > 0)) {
        setModifierForItem(item);
        return;
      }
      await useCheckoutStore.getState().addItem(item.id);
      setCheckoutStep('items');
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

  const itemCount = snapshot?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;

  return (
    <div className="checkout">
      <OrderDetails />
      {/* Narrow screens stack the ticket under the menu; this bar keeps the
          running total in view and jumps to it. */}
      <button type="button" className="checkout-jump" onClick={() => document.getElementById('checkout-order')?.scrollIntoView({ block: 'start' })}>
        <span>{itemCount === 0 ? 'Order' : `${itemCount} item${itemCount === 1 ? '' : 's'}`}</span>
        <strong>{formatCents(snapshot?.order.totalCents ?? 0)}</strong>
      </button>
      <section className="menu" aria-label="Menu">
        <div className="menu-toolbar">
          <label className="menu-search">
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <input
              ref={searchRef}
              aria-label="Search menu"
              placeholder="Search the menu  ( / )"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" aria-label="Clear search" onClick={() => setSearch('')}>
                <X className="h-4 w-4" />
              </button>
            )}
          </label>
          <CategoryRail categories={categoriesQ.data ?? []} selectedId={selectedCategoryId} onSelect={setSelectedCategoryId} />
        </div>
        <div className="menu-body">
          {itemsQ.isLoading ? (
            <p role="status" className="menu-empty">Loading the menu…</p>
          ) : itemsQ.isError || categoriesQ.isError ? (
            <div role="alert" className="menu-empty">
              <p>Could not load the menu.</p>
              <button type="button" className="ticket-link" onClick={() => { void itemsQ.refetch(); void categoriesQ.refetch(); }}>Try again</button>
            </div>
          ) : search && visibleItems.length === 0 ? (
            <div role="status" className="menu-empty">
              <p>Nothing called “{search}”.</p>
              <p>Try another name, or clear the search.</p>
            </div>
          ) : !selectedCategoryId && !search.trim() ? (
            // "All" reads as the printed menu does: section by section, in
            // the shop's own category order, not one alphabetical heap.
            <div className="menu-sections">
              {(categoriesQ.data ?? []).map((c) => {
                const inCat = visibleItems.filter((i) => i.categoryId === c.id);
                if (inCat.length === 0) return null;
                return (
                  <section key={c.id} className="menu-section" aria-label={c.name}>
                    <h2 className="menu-section-title">
                      <span className="menu-tab-dot" style={{ background: c.colorHex }} aria-hidden="true" />
                      {c.name}
                    </h2>
                    <ItemGrid items={inCat} categories={categoriesQ.data ?? []} onAdd={handleAddItem} onChooseSize={handleChooseSize} />
                  </section>
                );
              })}
            </div>
          ) : (
            <ItemGrid items={visibleItems} categories={categoriesQ.data ?? []} onAdd={handleAddItem} onChooseSize={handleChooseSize} />
          )}
        </div>
      </section>

      <CartPane step={checkoutStep} onContinue={() => setCheckoutStep('details')} onBack={() => setCheckoutStep('items')} onPay={() => setTenderOpen(true)} onDiscount={() => setDiscountOpen(true)} onSendToKitchen={handleSendToKitchen} onCustomize={setCustomizeLineId} />

      {pizzaChoice && (
        <PizzaSizeDialog choice={pizzaChoice} returnFocus={sizeTriggerRef.current} onClose={() => setPizzaChoice(null)} onSelect={(item) => { setPizzaChoice(null); void handleAddItem(item); }} />
      )}

      {modifierForItem && (
        <ModifierModal
          item={modifierForItem}
          onCancel={() => setModifierForItem(null)}
          onConfirm={async (modifierIds, notes) => {
            setModifierForItem(null);
            try {
              await useCheckoutStore.getState().addItem(modifierForItem.id, 1, modifierIds, notes);
              setCheckoutStep('items');
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

      {customizeLine && customizeItem && (
        <ModifierModal
          item={customizeItem}
          initialModifierIds={customizeLine.modifiers.map((m) => m.modifierId)}
          initialNotes={customizeLine.notes}
          confirmLabel="Save"
          onCancel={() => setCustomizeLineId(null)}
          onConfirm={async (modifierIds, notes) => {
            setCustomizeLineId(null);
            try {
              await useCheckoutStore.getState().updateItemOptions(customizeLine.id, modifierIds, notes);
            } catch (e) {
              toast({
                title: 'Could not change the item',
                description: e instanceof Error ? e.message : 'Unknown error',
                variant: 'error',
              });
            }
          }}
        />
      )}

      {tenderOpen && snapshot && (
        <TenderDialog snapshot={snapshot} onClose={() => setTenderOpen(false)} onPaid={handlePaid} />
      )}

      {discountOpen && snapshot && <DiscountDialog onClose={() => setDiscountOpen(false)} />}

      {receiptOpen && snapshot && <ReceiptDialog snapshot={snapshot} onClose={handleReceiptClose} />}
    </div>
  );
}
