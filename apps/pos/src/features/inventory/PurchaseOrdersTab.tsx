import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { PurchaseOrder, PurchaseOrderStatus } from '@cheeseoclock/shared-types';
import { Plus, X, Trash2, PackageCheck, Send } from 'lucide-react';

const STATUS_COLOR: Record<PurchaseOrderStatus, string> = {
  draft: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-300',
  ordered: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  partial: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  received: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

export function PurchaseOrdersTab() {
  const q = useQuery({
    queryKey: ['inventory', 'pos'],
    queryFn: () => ipc.inventory.listPurchaseOrders(),
  });
  const supQ = useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: () => ipc.inventory.listSuppliers(),
  });
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const supName = (id: string) => supQ.data?.find((s) => s.id === id)?.name ?? '?';

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Purchase orders</h2>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New PO
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-2">Reference</th>
            <th className="pb-2">Supplier</th>
            <th className="pb-2">Status</th>
            <th className="pb-2">Expected</th>
            <th className="pb-2 text-right">Total</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((po) => (
            <tr key={po.id} className="border-t border-stone-100 dark:border-stone-800">
              <td className="py-2 font-mono text-xs">
                {po.referenceNo ?? po.id.slice(0, 8)}
              </td>
              <td className="py-2">{supName(po.supplierId)}</td>
              <td className="py-2">
                <span className={cn('rounded px-2 py-0.5 text-xs capitalize', STATUS_COLOR[po.status])}>
                  {po.status}
                </span>
              </td>
              <td className="py-2 text-stone-500">
                {po.expectedAt ? new Date(po.expectedAt).toLocaleDateString() : '—'}
              </td>
              <td className="py-2 text-right font-mono">{formatCents(po.totalCents)}</td>
              <td className="py-2 text-right">
                <Button variant="secondary" size="sm" onClick={() => setOpening(po.id)}>
                  Open
                </Button>
              </td>
            </tr>
          ))}
          {(!q.data || q.data.length === 0) && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-stone-500">
                No purchase orders yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {creating && <CreatePoDialog onClose={() => setCreating(false)} />}
      {opening && <OpenPoDialog poId={opening} onClose={() => setOpening(null)} />}
    </Card>
  );
}

function CreatePoDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const supQ = useQuery({ queryKey: ['inventory', 'suppliers'], queryFn: () => ipc.inventory.listSuppliers({ activeOnly: true }) });
  const ingQ = useQuery({ queryKey: ['inventory', 'ingredients', 'all'], queryFn: () => ipc.inventory.listIngredients() });

  const [supplierId, setSupplierId] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [lines, setLines] = useState<Array<{ ingredientId: string; qtyOrdered: string; unitCostRupees: string }>>([
    { ingredientId: '', qtyOrdered: '', unitCostRupees: '' },
  ]);

  useEffect(() => {
    if (!supplierId && supQ.data && supQ.data[0]) setSupplierId(supQ.data[0].id);
  }, [supQ.data, supplierId]);

  function addLine() {
    setLines((prev) => [...prev, { ingredientId: '', qtyOrdered: '', unitCostRupees: '' }]);
  }
  function updateLine(i: number, patch: Partial<typeof lines[number]>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Auto-fill cost from ingredient default
  function onPickIngredient(i: number, ingId: string) {
    const ing = ingQ.data?.find((x) => x.id === ingId);
    updateLine(i, {
      ingredientId: ingId,
      ...(ing && (lines[i]?.unitCostRupees ?? '') === ''
        ? { unitCostRupees: (ing.costPerUnitCents / 100).toFixed(2) }
        : {}),
    });
  }

  const total = lines.reduce((sum, l) => {
    const qty = parseFloat(l.qtyOrdered || '0');
    const cost = parseFloat(l.unitCostRupees || '0');
    return sum + qty * cost;
  }, 0);

  const valid =
    supplierId &&
    lines.every(
      (l) => l.ingredientId && parseFloat(l.qtyOrdered) > 0 && parseFloat(l.unitCostRupees) >= 0,
    );

  const mut = useMutation({
    mutationFn: () =>
      ipc.inventory.createPurchaseOrder({
        supplierId,
        referenceNo: referenceNo || null,
        expectedAt: expectedAt || null,
        items: lines.map((l) => ({
          ingredientId: l.ingredientId,
          qtyOrdered: parseFloat(l.qtyOrdered),
          unitCostCents: Math.round(parseFloat(l.unitCostRupees) * 100),
        })),
      }),
    onSuccess: () => {
      toast({ title: 'Purchase order created', variant: 'success' });
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <Dialog.Title className="text-lg font-bold">New purchase order</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="flex-1 space-y-3 overflow-auto p-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Supplier">
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  <option value="">— Pick supplier —</option>
                  {supQ.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Reference / PO #">
                <input
                  type="text"
                  value={referenceNo}
                  onChange={(e) => setReferenceNo(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
            </div>
            <Field label="Expected by">
              <input
                type="date"
                value={expectedAt}
                onChange={(e) => setExpectedAt(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <div className="mt-4">
              <div className="mb-2 text-xs uppercase tracking-wider text-stone-500">Line items</div>
              {lines.map((line, i) => {
                const ing = ingQ.data?.find((x) => x.id === line.ingredientId);
                return (
                  <div key={i} className="mb-2 flex items-center gap-2">
                    <select
                      value={line.ingredientId}
                      onChange={(e) => onPickIngredient(i, e.target.value)}
                      className="flex-1 rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                    >
                      <option value="">— Ingredient —</option>
                      {ingQ.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      value={line.qtyOrdered}
                      onChange={(e) => updateLine(i, { qtyOrdered: e.target.value })}
                      placeholder="qty"
                      className="w-24 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                    />
                    <span className="w-10 text-sm text-stone-500">{ing?.unit ?? ''}</span>
                    <input
                      type="number"
                      step="0.01"
                      value={line.unitCostRupees}
                      onChange={(e) => updateLine(i, { unitCostRupees: e.target.value })}
                      placeholder="unit cost"
                      className="w-28 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                    />
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      className="rounded p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
              <Button variant="secondary" size="sm" onClick={addLine}>
                <Plus className="h-3 w-3" /> Add line
              </Button>
            </div>
            <div className="rounded-lg bg-stone-100 p-3 text-right text-sm font-mono dark:bg-stone-800">
              Total: Rs {total.toFixed(2)}
            </div>
          </div>
          <footer className="flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Create draft PO'}
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
    onSuccess: () => {
      toast({ title: 'Status updated', variant: 'success' });
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
          .map(([id, v]) => ({ purchaseOrderItemId: id, qtyReceivedNow: parseFloat(v) || 0 }))
          .filter((r) => r.qtyReceivedNow > 0),
      }),
    onSuccess: () => {
      toast({ title: 'Delivery received', variant: 'success' });
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
            <Dialog.Title className="text-lg font-bold">Loading…</Dialog.Title>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  const supplierName = supQ.data?.find((s) => s.id === po.supplierId)?.name ?? '?';

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">
                PO {po.referenceNo ?? po.id.slice(0, 8)}
              </Dialog.Title>
              <Dialog.Description className="text-xs text-stone-500">
                {supplierName} · <span className={cn('rounded px-2 py-0.5 text-xs', STATUS_COLOR[po.status])}>{po.status}</span>
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-auto p-5">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
                <tr>
                  <th className="pb-2">Ingredient</th>
                  <th className="pb-2 text-right">Ordered</th>
                  <th className="pb-2 text-right">Received</th>
                  <th className="pb-2 text-right">Unit cost</th>
                  {po.status !== 'received' && po.status !== 'cancelled' && (
                    <th className="pb-2 text-right">Receive now</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {po.items.map((item) => {
                  const ing = ingQ.data?.find((x) => x.id === item.ingredientId);
                  const remaining = item.qtyOrdered - item.qtyReceived;
                  return (
                    <tr key={item.id} className="border-t border-stone-100 dark:border-stone-800">
                      <td className="py-2 font-medium">{ing?.name ?? '?'}</td>
                      <td className="py-2 text-right font-mono">
                        {item.qtyOrdered} {ing?.unit ?? ''}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {item.qtyReceived} {ing?.unit ?? ''}
                      </td>
                      <td className="py-2 text-right font-mono">{formatCents(item.unitCostCents)}</td>
                      {po.status !== 'received' && po.status !== 'cancelled' && (
                        <td className="py-2 text-right">
                          {remaining > 0 ? (
                            <input
                              type="number"
                              step="0.01"
                              max={remaining}
                              min={0}
                              value={receipts[item.id] ?? ''}
                              onChange={(e) => setReceipts({ ...receipts, [item.id]: e.target.value })}
                              placeholder={`max ${remaining}`}
                              className="w-24 rounded border border-stone-300 px-2 py-1 text-right font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                            />
                          ) : (
                            <span className="text-xs text-emerald-600">complete</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-stone-300 dark:border-stone-700">
                  <td className="pt-2 font-semibold">Total</td>
                  <td colSpan={3} className="pt-2 text-right font-mono font-semibold">
                    {formatCents(po.totalCents)}
                  </td>
                </tr>
              </tfoot>
            </table>

            {po.status !== 'received' && po.status !== 'cancelled' && (
              <div className="mt-4 flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={updateCosts}
                    onChange={(e) => setUpdateCosts(e.target.checked)}
                  />
                  Update ingredient unit-cost to delivery cost
                </label>
              </div>
            )}
          </div>
          <footer className="flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            {po.status === 'draft' && (
              <Button variant="primary" onClick={() => setStatusMut.mutate('ordered')}>
                <Send className="h-4 w-4" /> Mark as ordered
              </Button>
            )}
            {(po.status === 'ordered' || po.status === 'partial' || po.status === 'draft') && (
              <Button
                variant="success"
                disabled={
                  receiveMut.isPending ||
                  Object.values(receipts).every((v) => !v || parseFloat(v) <= 0)
                }
                onClick={() => receiveMut.mutate()}
              >
                <PackageCheck className="h-4 w-4" /> Receive
              </Button>
            )}
            {po.status !== 'received' && po.status !== 'cancelled' && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (confirm('Cancel this PO?')) setStatusMut.mutate('cancelled');
                }}
              >
                Cancel PO
              </Button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">{label}</label>
      {children}
    </div>
  );
}
