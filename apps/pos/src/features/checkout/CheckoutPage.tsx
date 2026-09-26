import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CategoryRail } from './CategoryRail';
import { ItemGrid } from './ItemGrid';
import { PizzaSizeDialog } from './PizzaSizeDialog';
import { menuChoices, type MenuChoice } from './pizzaChoices';
import { searchMenu } from './menuSearch';
import { isTypingField, ownsEnter } from './keys';
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
  const qc = useQueryClient();
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
  const lastTouch = useCheckoutStore((s) => s.lastTouch);
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
  // The whole menu, loaded once. Tapping a category or typing a search filters
  // it right here — no trip to the database, no "Loading…" between tabs.
  const itemsQ = useQuery({
    queryKey: ['menu', 'items', { categoryId: null, activeOnly: true }],
    queryFn: () => ipc.menu.listItems({ activeOnly: true }),
  });
  const categories = useMemo(() => categoriesQ.data ?? [], [categoriesQ.data]);
  const allItems = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);
  const query = search.trim();

  const visibleItems = useMemo(() => {
    // A search looks through the whole menu, whichever tab is open.
    if (query) return searchMenu(allItems, categories, query);
    if (selectedCategoryId) return allItems.filter((i) => i.categoryId === selectedCategoryId);
    return allItems;
  }, [allItems, categories, query, selectedCategoryId]);

  const customizeLine = customizeLineId ? snapshot?.items.find((i) => i.id === customizeLineId) ?? null : null;
  // The line's menu item (name, description, price) from the whole menu, not
  // just the open tab; a line whose item has since left the menu cannot be
  // customised.
  const customizeItem = customizeLine ? allItems.find((m) => m.id === customizeLine.menuItemId) ?? null : null;
  useEffect(() => {
    if (customizeLineId && (!customizeLine || (itemsQ.isSuccess && !customizeItem))) {
      if (customizeLine && !customizeItem) {
        toast({ title: 'This item is no longer on the menu', description: 'Its choices cannot be changed. Remove it and add another.', variant: 'warning' });
      }
      setCustomizeLineId(null);
    }
  }, [customizeLineId, customizeLine, customizeItem, itemsQ.isSuccess, toast]);

  // One send per order: a double tap (or Enter + click) must not send twice.
  const sendingRef = useRef(false);
  async function handleSendToKitchen() {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      const next = await useCheckoutStore.getState().sendToKitchen();
      toast({
        title: `Sent to kitchen · #${next.order.orderNumber.split('-').pop()}`,
        variant: 'success',
      });
      reset();
    } catch (e) {
      toast({
        title: 'Could not send',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    } finally {
      sendingRef.current = false;
    }
  }

  /**
   * The ticket's big button, from the keyboard: Confirm order → customer
   * details → Send to kitchen (takeaway / delivery), or Pay (Foodpanda).
   */
  function primaryAction() {
    if (!hasItems) return;
    if (needsCustomer && checkoutStep === 'items') {
      setCheckoutStep('details');
      return;
    }
    if (!gate.ok) {
      nudgeMissing(needsCustomer ? 'Cannot send yet' : 'Cannot pay yet');
      return;
    }
    if (needsCustomer) void handleSendToKitchen();
    else setTenderOpen(true);
  }

  /**
   * Something is still needed before Send / Pay. On the details step the
   * ticket already says what ("Still needed: …"), so put the cursor in the
   * first empty box instead of a pop-up saying it again.
   */
  function nudgeMissing(title: string) {
    if (checkoutStep === 'details') {
      const empty = Array.from(
        document.querySelectorAll<HTMLInputElement>('#checkout-order .ticket-details input'),
      ).find((i) => i.type !== 'hidden' && !i.disabled && !i.readOnly && i.value.trim() === '');
      if (empty) {
        empty.focus();
        return;
      }
    }
    toast({ title, description: gate.missing.join(' · '), variant: 'warning' });
  }

  /** The ticket line + and − keys act on: the one last added or changed, else the last line. */
  function keyTargetLine() {
    const items = snapshot?.items ?? [];
    return items.find((i) => i.id === lastTouch?.lineId) ?? items[items.length - 1] ?? null;
  }

  function bumpFromKeyboard(delta: number) {
    const line = keyTargetLine();
    if (!line) return;
    // The keyboard never removes a line — that takes the ✕ on the ticket.
    if (delta < 0 && line.quantity <= 1) return;
    useCheckoutStore
      .getState()
      .bumpItemQty(line.id, delta)
      .catch((e: unknown) => {
        toast({ title: 'Could not change the quantity', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });
      });
  }

  // Keys a cashier can hit without looking:
  //   Enter — the ticket's big button · F1 pay · F2 send · F3 discount
  //   + / − — one more / one less of the last line · "/" or any letter — search
  //   Esc — closes whatever is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (pizzaChoice || modifierForItem || customizeLineId || tenderOpen || receiptOpen || discountOpen) {
        if (e.key === 'Escape') {
          if (pizzaChoice) setPizzaChoice(null);
          else if (receiptOpen) {
            setReceiptOpen(false);
            reset();
          } else if (tenderOpen) setTenderOpen(false);
          else if (discountOpen) setDiscountOpen(false);
          else if (modifierForItem) setModifierForItem(null);
          else if (customizeLineId) setCustomizeLineId(null);
        }
        return;
      }
      // Another dialog (a confirm, the customer picker, the lock screen) owns the keys.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const active = document.activeElement;
      const typing = isTypingField(active);
      const inEmptySearch = active === searchRef.current && search === '';

      if (e.key === 'Escape') {
        if (checkoutStep === 'details' && !busy && !typing) setCheckoutStep('items');
        return;
      }
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if ((e.key === '+' || e.key === '=' || e.key === '-') && (!typing || inEmptySearch)) {
        e.preventDefault();
        bumpFromKeyboard(e.key === '-' ? -1 : 1);
        return;
      }
      if (e.key === 'Enter') {
        // A button reached with Tab answers Enter itself. One that only has
        // focus because it was tapped (the + on a line, say) does not: Enter
        // there must not add another item — it is the ticket's big button.
        if (typing || ownsEnter(active)) return;
        e.preventDefault();
        primaryAction();
        return;
      }
      // Type-to-search: a letter typed with nothing focused starts a search.
      if (!typing && checkoutStep === 'items' && e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
        e.preventDefault();
        setSearch((s) => s + e.key);
        searchRef.current?.focus();
        return;
      }
      if (!hasItems) return;
      if (e.key === 'F1' || e.key === 'F2') {
        e.preventDefault();
        if (needsCustomer && checkoutStep === 'items') {
          setCheckoutStep('details');
          return;
        }
        if (!gate.ok) {
          nudgeMissing(e.key === 'F1' ? 'Cannot pay yet' : 'Cannot send yet');
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
  }, [pizzaChoice, modifierForItem, customizeLineId, tenderOpen, receiptOpen, discountOpen, snapshot, reset, gate, toast, checkoutStep, needsCustomer, hasItems, busy, mode, search, lastTouch]);

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
      // The item's choice lists are cached, so the second tap on an item does
      // not wait on the database at all.
      const groups = await qc.fetchQuery({
        queryKey: ['menu', 'modifierGroupsForItem', item.id],
        queryFn: () => ipc.menu.listModifierGroupsForItem(item.id),
        staleTime: 5 * 60_000,
      });
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

  function addChoice(choice: MenuChoice) {
    if (choice.sizedPizza) handleChooseSize(choice);
    else void handleAddItem(choice.variants[0]!);
  }

  // Search box keys: Enter adds the best match and clears the box for the next
  // name; Enter on an empty box is the ticket's big button; Esc clears, then leaves.
  function onSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!query) {
        primaryAction();
        return;
      }
      const best = menuChoices(visibleItems, categories)[0];
      if (!best) return;
      setSearch('');
      addChoice(best);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (search) setSearch('');
      else searchRef.current?.blur();
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
  const bestMatch = query ? menuChoices(visibleItems, categories)[0] ?? null : null;

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
              placeholder="Search the menu — just start typing"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            {bestMatch && (
              <span className="hidden max-w-[50%] shrink-0 truncate whitespace-nowrap text-xs text-stone-400 sm:inline">
                <kbd className="rounded bg-stone-100 px-1 font-mono dark:bg-stone-800">Enter</kbd> adds {bestMatch.name}
              </span>
            )}
            {search && (
              <button type="button" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => setSearch('')}>
                <X className="h-4 w-4" />
              </button>
            )}
          </label>
          <CategoryRail
            categories={categories}
            selectedId={selectedCategoryId}
            onSelect={(id) => {
              setSelectedCategoryId(id);
              setSearch('');
            }}
          />
        </div>
        <div className="menu-body">
          {itemsQ.isLoading ? (
            <p role="status" className="menu-empty">Loading the menu…</p>
          ) : itemsQ.isError || categoriesQ.isError ? (
            <div role="alert" className="menu-empty">
              <p>Could not load the menu.</p>
              <button type="button" className="ticket-link" onClick={() => { void itemsQ.refetch(); void categoriesQ.refetch(); }}>Try again</button>
            </div>
          ) : query && visibleItems.length === 0 ? (
            <div role="status" className="menu-empty">
              <p>Nothing called “{query}”.</p>
              <p>Try another name, or clear the search.</p>
            </div>
          ) : !selectedCategoryId && !query ? (
            // "All" reads as the printed menu does: section by section, in
            // the shop's own category order, not one alphabetical heap.
            <div className="menu-sections">
              {categories.map((c) => {
                const inCat = visibleItems.filter((i) => i.categoryId === c.id);
                if (inCat.length === 0) return null;
                return (
                  <section key={c.id} className="menu-section" aria-label={c.name}>
                    <h2 className="menu-section-title">
                      <span className="menu-tab-dot" style={{ background: c.colorHex }} aria-hidden="true" />
                      {c.name}
                    </h2>
                    <ItemGrid items={inCat} categories={categories} onAdd={handleAddItem} onChooseSize={handleChooseSize} />
                  </section>
                );
              })}
            </div>
          ) : (
            <ItemGrid items={visibleItems} categories={categories} onAdd={handleAddItem} onChooseSize={handleChooseSize} />
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
          lineQuantity={customizeLine.quantity}
          confirmLabel="Save"
          onCancel={() => setCustomizeLineId(null)}
          onConfirm={async (modifierIds, notes, opts) => {
            setCustomizeLineId(null);
            try {
              const store = useCheckoutStore.getState();
              if (opts?.onlyOne) await store.customizeOneOf(customizeLine.id, modifierIds, notes);
              else await store.updateItemOptions(customizeLine.id, modifierIds, notes);
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
