import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents, formatQty, stockStatus } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { PurchaseOrder, PurchaseOrderStatus } from '@cheeseoclock/shared-types';
import { Plus, X, Trash2, PackageCheck, Send, AlertTriangle, ListPlus } from 'lucide-react';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import {
  FilterChips,
  Pagination,
  SearchBox,
  compareText,
  countBy,
  useListQuery,
  useSessionState,
  type ChipOption,
} from '../../components/list';
import { IngredientSelect } from './IngredientSelect';
import { suggestReorderQty } from './ingredient-list';

const PO_LIST_KEY = ['inventory', 'pos', 'list'] as const;

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  ordered: 'Ordered',
  partial: 'Part received',
  received: 'Received',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Record<PurchaseOrderStatus, string> = {
  draft: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-300',
  ordered: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  partial: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  received: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

type StatusFilter = 'open' | PurchaseOrderStatus | 'all';

const isOpen = (s: PurchaseOrderStatus) => s === 'draft' || s === 'ordered' || s === 'partial';

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

/** Expected before today and still not (fully) in. */
function isLate(po: PurchaseOrder): boolean {
  if (!po.expectedAt || !isOpen(po.status) || po.status === 'draft') return false;
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return new Date(po.expectedAt) < startOfToday;
}

function StatusPill({ status }: { status: PurchaseOrderStatus }) {
  return (
    <span className={cn('whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium', STATUS_COLOR[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PurchaseOrdersTab() {
  const q = useQuery({
    queryKey: PO_LIST_KEY,
    // Every order, newest first; a shop writes a few a week, so this stays small.
    queryFn: () => ipc.inventory.listPurchaseOrders({ limit: 2000 }),
  });
  const supQ = useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: () => ipc.inventory.listSuppliers(),
  });
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [status, setStatus] = useSessionState<StatusFilter>('inv.po.status', 'open');
  const [supplierId, setSupplierId] = useSessionState('inv.po.supplier', '');

  const supName = useCallback((id: string) => supQ.data?.find((s) => s.id === id)?.name ?? 'Unknown supplier', [supQ.data]);
  const filter = useCallback(
    (po: PurchaseOrder) =>
      (!supplierId || po.supplierId === supplierId) &&
      (status === 'all' || (status === 'open' ? isOpen(po.status) : po.status === status)),
    [status, supplierId],
  );
  const searchText = useCallback(
    (po: PurchaseOrder) =>
      `${po.referenceNo ?? ''} ${po.id.slice(0, 8)} ${supName(po.supplierId)} ${STATUS_LABEL[po.status]} ${po.notes ?? ''}`,
    [supName],
  );
  const list = useListQuery({
    items: q.data,
    searchText,
    filter,
    persistKey: 'inv.po',
    resetPageOn: [status, supplierId],
  });

  const bySupplier = list.searched.filter((po) => !supplierId || po.supplierId === supplierId);
  const statusCounts = countBy(bySupplier, (po) => po.status);
  const statusOptions: ChipOption<StatusFilter>[] = [
    {
      id: 'open',
      label: 'Still open',
      count: bySupplier.filter((po) => isOpen(po.status)).length,
      tone: 'blue',
    },
    ...(['draft', 'ordered', 'partial', 'received', 'cancelled'] as const).map((s) => ({
      id: s as StatusFilter,
      label: STATUS_LABEL[s],
      count: statusCounts[s] ?? 0,
    })),
    { id: 'all', label: 'All', count: bySupplier.length },
  ];
  const activeSuppliers = (supQ.data ?? []).filter((s) => s.isActive);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Purchase orders</h2>
          <p className="mt-0.5 text-sm text-stone-500">What you have ordered from suppliers, and booking deliveries in.</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button variant="primary" size="sm" disabled={activeSuppliers.length === 0} onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New purchase order
          </Button>
          {supQ.data && activeSuppliers.length === 0 && (
            <span className="text-xs text-stone-500">Add a supplier first (Suppliers tab).</span>
          )}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={list.query} onChange={list.setQuery} placeholder="Search reference or supplier…" label="Search purchase orders" />
        <select
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          aria-label="Supplier"
          className="h-10 rounded-lg border border-stone-300 bg-white px-2 text-sm dark:border-stone-700 dark:bg-stone-800"
        >
          <option value="">All suppliers</option>
          {[...(supQ.data ?? [])]
            .sort((a, b) => compareText(a.name, b.name))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </div>
      <FilterChips label="Status" className="mb-3" options={statusOptions} value={status} onChange={setStatus} />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              <th className="pb-2">Reference</th>
              <th className="pb-2">Supplier</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Ordered</th>
              <th className="pb-2">Expected</th>
              <th className="pb-2 text-right">Total</th>
              <th className="pb-2">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((po) => (
              <tr key={po.id} className="border-t border-stone-100 dark:border-stone-800">
                <td className="py-2 font-mono text-xs">{po.referenceNo ?? po.id.slice(0, 8)}</td>
                <td className="py-2">{supName(po.supplierId)}</td>
                <td className="py-2">
                  <StatusPill status={po.status} />
                </td>
                <td className="whitespace-nowrap py-2 text-stone-500">{formatDate(po.orderedAt)}</td>
                <td className="whitespace-nowrap py-2 text-stone-500">
                  {formatDate(po.expectedAt)}
                  {isLate(po) && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-800 dark:bg-red-950 dark:text-red-200">
                      <AlertTriangle className="h-3 w-3" /> late
                    </span>
                  )}
                </td>
                <td className="py-2 text-right font-mono">{formatCents(po.totalCents)}</td>
                <td className="py-2 text-right">
                  <Button variant="secondary" size="sm" onClick={() => setOpening(po.id)}>
                    {isOpen(po.status) && po.status !== 'draft' ? 'Receive' : 'Open'}
                  </Button>
                </td>
              </tr>
            ))}
            {list.total === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-stone-500">
                  {q.isLoading
                    ? 'Loading…'
                    : (q.data ?? []).length === 0
                      ? 'No purchase orders yet.'
                      : status === 'open' && !list.query && !supplierId
                        ? 'Nothing on order right now.'
                        : 'No purchase orders match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        from={list.from}
        to={list.to}
        onPage={list.setPage}
        pageSize={list.pageSize}
        onPageSize={list.setPageSize}
        noun={list.total === 1 ? 'purchase order' : 'purchase orders'}
      />

      {creating && <CreatePoDialog onClose={() => setCreating(false)} />}
      {opening && <OpenPoDialog poId={opening} onClose={() => setOpening(null)} />}
    </Card>
  );
}

type Line = { ingredientId: string; qtyOrdered: string; unitCostRupees: string };

/** Rupees typed → paisa; NaN for anything that is not a price. */
function rupeesToCents(v: string): number {
  if (v.trim() === '') return Number.NaN;
  return Math.round(parseFloat(v) * 100);
}

function CreatePoDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const supQ = useQuery({ queryKey: ['inventory', 'suppliers'], queryFn: () => ipc.inventory.listSuppliers() });
  const ingQ = useQuery({ queryKey: ['inventory', 'ingredients', 'all'], queryFn: () => ipc.inventory.listIngredients() });
  const suppliers = useMemo(
    () => (supQ.data ?? []).filter((s) => s.isActive).sort((a, b) => compareText(a.name, b.name)),
    [supQ.data],
  );

  const [supplierId, setSupplierId] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [lines, setLines] = useState<Line[]>([{ ingredientId: '', qtyOrdered: '', unitCostRupees: '' }]);

  // With a single supplier there is nothing to choose.
  useEffect(() => {
    if (!supplierId && suppliers.length === 1 && suppliers[0]) setSupplierId(suppliers[0].id);
  }, [suppliers, supplierId]);

  function updateLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }
  const costText = (ingId: string) => {
    const ing = ingQ.data?.find((x) => x.id === ingId);
    return ing ? (ing.costPerUnitCents / 100).toFixed(2) : '';
  };

  // Fill the cost from what the ingredient costs now, unless one was typed.
  function onPickIngredient(i: number, ingId: string) {
    updateLine(i, {
      ingredientId: ingId,
      ...((lines[i]?.unitCostRupees ?? '') === '' ? { unitCostRupees: costText(ingId) } : {}),
    });
  }

  // Low and out-of-stock ingredients this supplier usually brings, not on the order yet.
  const lowForSupplier = (ingQ.data ?? []).filter(
    (i) =>
      supplierId &&
      i.defaultSupplierId === supplierId &&
      stockStatus(i) !== 'ok' &&
      !lines.some((l) => l.ingredientId === i.id),
  );
  function addLowStock() {
    setLines((prev) => [
      ...prev.filter((l) => l.ingredientId || l.qtyOrdered || l.unitCostRupees),
      ...lowForSupplier.map((i) => ({
        ingredientId: i.id,
        qtyOrdered: String(suggestReorderQty(i)),
        unitCostRupees: costText(i.id),
      })),
    ]);
  }

  const parsed = lines.map((l) => ({
    ingredientId: l.ingredientId,
    qty: /^\d+$/.test(l.qtyOrdered.trim()) ? parseInt(l.qtyOrdered, 10) : Number.NaN,
    costCents: rupeesToCents(l.unitCostRupees),
  }));
  const lineOk = (p: (typeof parsed)[number]) =>
    !!p.ingredientId && p.qty > 0 && Number.isFinite(p.costCents) && p.costCents >= 0;
  const totalCents = parsed.reduce((sum, p) => sum + (lineOk(p) ? p.qty * p.costCents : 0), 0);
  const problem = !supplierId
    ? 'Pick the supplier.'
    : lines.length === 0
      ? 'Add at least one line.'
      : parsed.some((p) => !p.ingredientId)
        ? 'Pick an ingredient on every line.'
        : parsed.some((p) => !lineOk(p))
          ? 'Every line needs a whole quantity and a price.'
          : null;

  const mut = useMutation({
    mutationFn: () =>
      ipc.inventory.createPurchaseOrder({
        supplierId,
        referenceNo: referenceNo.trim() || null,
        expectedAt: expectedAt || null,
        items: parsed.map((p) => ({
          ingredientId: p.ingredientId,
          // Quantities are whole base units (g / ml / pcs) — INTEGER in SQLite.
          qtyOrdered: p.qty,
          unitCostCents: p.costCents,
        })),
      }),
    onSuccess: () => {
      toast({ title: 'Purchase order saved as a draft', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[760px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <Dialog.Title className="text-lg font-bold">New purchase order</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">Pick a supplier and what to order from them.</Dialog.Description>
          <div className="flex-1 space-y-3 overflow-auto p-5">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Supplier" htmlFor="po-supplier">
                <select
                  id="po-supplier"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  <option value="">— Pick supplier —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Their bill / PO number" htmlFor="po-ref">
                <input
                  id="po-ref"
                  type="text"
                  value={referenceNo}
                  onChange={(e) => setReferenceNo(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
              <Field label="Expected by" htmlFor="po-expected">
                <input
                  id="po-expected"
                  type="date"
                  value={expectedAt}
                  onChange={(e) => setExpectedAt(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
            </div>
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-stone-500">What to order</div>
                {lowForSupplier.length > 0 && (
                  <Button variant="secondary" size="sm" onClick={addLowStock}>
                    <ListPlus className="h-4 w-4" /> Add {lowForSupplier.length} low-stock item{lowForSupplier.length === 1 ? '' : 's'}
                  </Button>
                )}
              </div>
              <div className="mb-1 grid grid-cols-[1fr_7rem_7.5rem_6.5rem_2.5rem] gap-2 px-0.5 text-[11px] uppercase tracking-wider text-stone-500">
                <span>Ingredient</span>
                <span className="text-right">Quantity</span>
                <span className="text-right">Rs per unit</span>
                <span className="text-right">Line total</span>
                <span />
              </div>
              {lines.map((line, i) => {
                const ing = ingQ.data?.find((x) => x.id === line.ingredientId);
                const p = parsed[i]!;
                return (
                  <div key={i} className="mb-2 grid grid-cols-[1fr_7rem_7.5rem_6.5rem_2.5rem] items-center gap-2">
                    <IngredientSelect
                      ingredients={ingQ.data}
                      value={line.ingredientId}
                      onChange={(id) => onPickIngredient(i, id)}
                      className="min-w-0"
                    />
                    <div className="relative">
                      <input
                        type="number"
                        step="1"
                        min={1}
                        inputMode="numeric"
                        value={line.qtyOrdered}
                        onChange={(e) => updateLine(i, { qtyOrdered: e.target.value })}
                        placeholder="qty"
                        aria-label="Quantity"
                        className="w-full rounded-lg border border-stone-300 py-2 pl-2 pr-9 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-stone-500">
                        {ing?.unit ?? ''}
                      </span>
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      value={line.unitCostRupees}
                      onChange={(e) => updateLine(i, { unitCostRupees: e.target.value })}
                      placeholder={ing ? `Rs / ${ing.unit}` : 'Rs'}
                      aria-label="Price per unit in rupees"
                      className="w-full rounded-lg border border-stone-300 px-2 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                    />
                    <span className="text-right font-mono text-xs text-stone-600 dark:text-stone-300">
                      {lineOk(p) ? formatCents(p.qty * p.costCents) : '—'}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      className="rounded p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    {ing && lineOk(p) && (
                      <span className="col-span-5 -mt-1 px-0.5 text-[11px] text-stone-500">
                        {formatQty(p.qty, ing.unit)} · in stock now {formatQty(ing.currentQty, ing.unit)}
                      </span>
                    )}
                  </div>
                );
              })}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setLines((prev) => [...prev, { ingredientId: '', qtyOrdered: '', unitCostRupees: '' }])}
              >
                <Plus className="h-3 w-3" /> Add line
              </Button>
            </div>
            <div className="rounded-lg bg-stone-100 p-3 text-right text-sm dark:bg-stone-800">
              Total <span className="ml-2 font-mono text-base font-semibold">{formatCents(totalCents)}</span>
            </div>
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            {problem && <span className="mr-auto text-xs text-stone-500">{problem}</span>}
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={problem !== null || mut.isPending} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save as draft'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OpenPoDialog({ poId, onClose }: { poId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['inventory', 'po', poId], queryFn: () => ipc.inventory.getPurchaseOrder(poId) });
  const ingQ = useQuery({ queryKey: ['inventory', 'ingredients', 'all'], queryFn: () => ipc.inventory.listIngredients() });
  const supQ = useQuery({ queryKey: ['inventory', 'suppliers'], queryFn: () => ipc.inventory.listSuppliers() });

  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [updateCosts, setUpdateCosts] = useState(true);

  const po = q.data;

  const setStatusMut = useMutation({
    mutationFn: (status: PurchaseOrderStatus) =>
      ipc.inventory.setPurchaseOrderStatus({ id: poId, status }),
    onSuccess: (_r, status) => {
      toast({ title: status === 'ordered' ? 'Marked as ordered' : 'Purchase order closed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const receiveMut = useMutation({
    mutationFn: () =>
      ipc.inventory.receiveDelivery({
        purchaseOrderId: poId,
        updateCosts,
        receipts: Object.entries(receipts)
          .map(([id, v]) => ({ purchaseOrderItemId: id, qtyReceivedNow: /^\d+$/.test(v.trim()) ? parseInt(v, 10) : 0 }))
          .filter((r) => r.qtyReceivedNow > 0),
      }),
    onSuccess: (r) => {
      toast({
        title: r.status === 'received' ? 'Delivery booked in — order complete' : 'Delivery booked in',
        description: 'The stock has been added.',
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      setReceipts({});
    },
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  if (!po) {
    return (
      <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
            <Dialog.Title className="text-lg font-bold">{q.isLoading ? 'Loading…' : 'Purchase order not found'}</Dialog.Title>
            <Dialog.Description className="sr-only">Purchase order</Dialog.Description>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  const supplierName = supQ.data?.find((s) => s.id === po.supplierId)?.name ?? 'Unknown supplier';
  const canReceive = isOpen(po.status);
  const typed = Object.values(receipts).some((v) => /^\d+$/.test(v.trim()) && parseInt(v, 10) > 0);
  const badReceipt = Object.values(receipts).some((v) => v.trim() !== '' && !/^\d+$/.test(v.trim()));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[760px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">
                {supplierName} · {po.referenceNo ?? po.id.slice(0, 8)}
              </Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                  <StatusPill status={po.status} />
                  {po.orderedAt && <span>Ordered {formatDate(po.orderedAt)}</span>}
                  {po.expectedAt && <span>· Expected {formatDate(po.expectedAt)}</span>}
                  {po.receivedAt && <span>· Received {formatDate(po.receivedAt)}</span>}
                </div>
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-auto p-5">
            {canReceive && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                <span>Delivery arrived? Type what came in, then press Receive.</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setReceipts(
                      Object.fromEntries(
                        po.items
                          .filter((it) => it.qtyOrdered > it.qtyReceived)
                          .map((it) => [it.id, String(it.qtyOrdered - it.qtyReceived)]),
                      ),
                    )
                  }
                >
                  Everything came
                </Button>
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
                <tr>
                  <th className="pb-2">Ingredient</th>
                  <th className="pb-2 text-right">Ordered</th>
                  <th className="pb-2 text-right">Received</th>
                  <th className="pb-2 text-right">Rs per unit</th>
                  <th className="pb-2 text-right">Line total</th>
                  {canReceive && <th className="pb-2 text-right">Came in now</th>}
                </tr>
              </thead>
              <tbody>
                {po.items.map((item) => {
                  const ing = ingQ.data?.find((x) => x.id === item.ingredientId);
                  const unit = ing?.unit ?? '';
                  const remaining = item.qtyOrdered - item.qtyReceived;
                  const typedNow = parseInt(receipts[item.id] ?? '', 10);
                  return (
                    <tr key={item.id} className="border-t border-stone-100 align-top dark:border-stone-800">
                      <td className="py-2 font-medium">{ing?.name ?? 'Deleted ingredient'}</td>
                      <td className="whitespace-nowrap py-2 text-right font-mono">{formatQty(item.qtyOrdered, unit)}</td>
                      <td className="whitespace-nowrap py-2 text-right font-mono">{formatQty(item.qtyReceived, unit)}</td>
                      <td className="whitespace-nowrap py-2 text-right font-mono">{formatCents(item.unitCostCents)}</td>
                      <td className="whitespace-nowrap py-2 text-right font-mono">{formatCents(item.lineTotalCents)}</td>
                      {canReceive && (
                        <td className="py-2 text-right">
                          {remaining > 0 ? (
                            <>
                              <input
                                type="number"
                                step="1"
                                inputMode="numeric"
                                min={0}
                                value={receipts[item.id] ?? ''}
                                onChange={(e) => setReceipts({ ...receipts, [item.id]: e.target.value })}
                                placeholder={`${remaining} ${unit}`}
                                aria-label={`Quantity of ${ing?.name ?? 'item'} that came in`}
                                className="w-28 rounded border border-stone-300 px-2 py-1 text-right font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                              />
                              {typedNow > remaining && (
                                <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">more than ordered</div>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-emerald-600">all in</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-stone-300 dark:border-stone-700">
                  <td className="pt-2 font-semibold" colSpan={4}>
                    Total
                  </td>
                  <td className="pt-2 text-right font-mono font-semibold">{formatCents(po.totalCents)}</td>
                  {canReceive && <td />}
                </tr>
              </tfoot>
            </table>

            {canReceive && (
              <label className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={updateCosts}
                  onChange={(e) => setUpdateCosts(e.target.checked)}
                />
                If a price changed, save it as the ingredient's new cost
              </label>
            )}
          </div>
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            {canReceive && (
              <Button
                variant="ghost"
                className="mr-auto"
                disabled={setStatusMut.isPending}
                onClick={() => {
                  const question =
                    po.status === 'partial'
                      ? 'Close this order?\nThe rest is not coming. What already arrived stays in stock.'
                      : 'Cancel this purchase order?\nNothing has arrived on it; no stock changes.';
                  void askConfirm(question).then((ok) => {
                    if (ok) setStatusMut.mutate('cancelled');
                  });
                }}
              >
                {po.status === 'partial' ? 'Close — rest not coming' : 'Cancel order'}
              </Button>
            )}
            {po.status === 'draft' && (
              <Button variant="secondary" disabled={setStatusMut.isPending} onClick={() => setStatusMut.mutate('ordered')}>
                <Send className="h-4 w-4" /> Mark as ordered
              </Button>
            )}
            {canReceive && (
              <Button
                variant="success"
                disabled={receiveMut.isPending || !typed || badReceipt}
                onClick={() => receiveMut.mutate()}
              >
                <PackageCheck className="h-4 w-4" /> {receiveMut.isPending ? 'Saving…' : 'Receive'}
              </Button>
            )}
            {!canReceive && (
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
        {label}
      </label>
      {children}
    </div>
  );
}
