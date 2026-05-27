import { useEffect, useState } from 'react';
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

export function CheckoutPage() {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [modifierForItem, setModifierForItem] = useState<MenuItem | null>(null);
  const [tenderOpen, setTenderOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const snapshot = useCheckoutStore((s) => s.snapshot);
  const reset = useCheckoutStore((s) => s.reset);
  const gate = useTenderGate();
  const { toast } = useToast();

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

  // Pick first category once categories load
  useEffect(() => {
    if (!selectedCategoryId && categoriesQ.data?.[0]) {
      setSelectedCategoryId(categoriesQ.data[0].id);
    }
  }, [categoriesQ.data, selectedCategoryId]);

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

  return (
    // Escape the AppShell main padding so the checkout uses the full canvas.
    <div className="-m-8 flex h-[calc(100vh-4rem)] flex-col">
      <OrderModeBar />
      <div className="flex flex-1 overflow-hidden">
        <CategoryRail
          categories={categoriesQ.data ?? []}
          selectedId={selectedCategoryId}
          onSelect={setSelectedCategoryId}
        />
        <div className="flex-1 overflow-auto p-5">
          <ItemGrid items={itemsQ.data ?? []} onAdd={handleAddItem} />
        </div>
        <CartPane
          onPay={() => setTenderOpen(true)}
          onDiscount={() => setDiscountOpen(true)}
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
