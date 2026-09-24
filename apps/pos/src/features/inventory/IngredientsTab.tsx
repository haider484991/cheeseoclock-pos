import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  INGREDIENT_UNITS,
  baseUnitConversion,
  costPerUnitFromPack,
  formatPack,
  formatUnitCost,
} from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Ingredient, StockMovementReason } from '@cheeseoclock/shared-types';
import { Plus, Edit, Trash2, X, AlertTriangle, BarChart2, Scale } from 'lucide-react';
import { askConfirm } from '../../components/confirm/ConfirmHost';

/** 25000 → "25,000" */
const qty = (n: number) => new Intl.NumberFormat('en-PK').format(n);

export function IngredientsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showLowOnly, setShowLowOnly] = useState(false);
  const [editing, setEditing] = useState<Ingredient | null | 'new'>(null);
  const [movementFor, setMovementFor] = useState<Ingredient | null>(null);

  const q = useQuery({
    queryKey: ['inventory', 'ingredients', { lowOnly: showLowOnly }],
    queryFn: () => ipc.inventory.listIngredients({ lowStockOnly: showLowOnly }),
  });
  const sup = useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: () => ipc.inventory.listSuppliers(),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => ipc.inventory.deleteIngredient(id),
    onSuccess: () => {
      toast({ title: 'Ingredient removed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) =>
      toast({
        title: 'Cannot delete',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const convertMut = useMutation({
    mutationFn: (id: string) => ipc.inventory.convertIngredientUnit(id),
    onSuccess: (i) => {
      toast({ title: `${i.name} is now counted in ${i.unit}`, variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) =>
      toast({
        title: 'Cannot convert',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Ingredients</h2>
        <div className="flex gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showLowOnly}
              onChange={(e) => setShowLowOnly(e.target.checked)}
            />
            Low stock only
          </label>
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" /> Add ingredient
          </Button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-2">Name</th>
            <th className="pb-2 text-right">On hand</th>
            <th className="pb-2 text-right">Low at</th>
            <th className="pb-2 text-right">Unit cost</th>
            <th className="pb-2 pl-6">Supplier</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((i) => {
            const isLow = i.currentQty <= i.lowThreshold;
            return (
              <tr key={i.id} className="border-t border-stone-100 dark:border-stone-800">
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{i.name}</span>
                    {isLow && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                        <AlertTriangle className="h-3 w-3" /> low
                      </span>
                    )}
                  </div>
                  {i.sku && <div className="text-xs text-stone-500">SKU {i.sku}</div>}
                </td>
                <td className={cn('py-2 text-right font-mono', isLow && 'font-bold text-amber-700')}>
                  {qty(i.currentQty)} {i.unit}
                </td>
                <td className="py-2 text-right font-mono text-stone-500">
                  {qty(i.lowThreshold)} {i.unit}
                </td>
                <td className="py-2 text-right">
                  <div className="font-mono">{formatUnitCost(i)}</div>
                  {(i.packSize ?? 0) > 1 && <div className="text-xs text-stone-500">{formatPack(i)}</div>}
                  {baseUnitConversion(i.unit) && (
                    <button
                      type="button"
                      disabled={convertMut.isPending}
                      onClick={() => {
                        const to = baseUnitConversion(i.unit)!;
                        void askConfirm(`Count "${i.name}" in ${to.unit} instead of ${i.unit}?\n\nStock, low level and every recipe that uses it are multiplied by ${to.factor} — the same amounts, in ${to.unit}. Recipes can then say 300 ${to.unit}.`).then((ok) => {
                          if (ok) convertMut.mutate(i.id);
                        });
                      }}
                      className="mt-1 inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-200"
                    >
                      <Scale className="h-3 w-3" /> Convert to {baseUnitConversion(i.unit)!.unit}
                    </button>
                  )}
                </td>
                <td className="py-2 pl-6 text-stone-500">
                  {sup.data?.find((s) => s.id === i.defaultSupplierId)?.name ?? '—'}
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => setMovementFor(i)}
                    className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                    title="Record movement"
                  >
                    <BarChart2 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setEditing(i)}
                    className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                    aria-label="Edit"
                  >
                    <Edit className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => {
                      void askConfirm(`Delete "${i.name}"?`).then((ok) => {
                        if (ok) deleteMut.mutate(i.id);
                      });
                    }}
                    className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            );
          })}
          {(!q.data || q.data.length === 0) && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-stone-500">
                {showLowOnly ? 'No low-stock ingredients.' : 'No ingredients yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <IngredientDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {movementFor && (
        <MovementDialog key={movementFor.id} ingredient={movementFor} onClose={() => setMovementFor(null)} />
      )}
    </Card>
  );
}

function IngredientDialog({
  existing,
  onClose,
}: {
  existing: Ingredient | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [unit, setUnit] = useState(existing?.unit ?? 'g');
  const [currentQty, setCurrentQty] = useState((existing?.currentQty ?? 0).toString());
  const [lowThreshold, setLowThreshold] = useState((existing?.lowThreshold ?? 0).toString());
  const [costPerUnit, setCostPerUnit] = useState(((existing?.costPerUnitCents ?? 0) / 100).toString());
  const [packSize, setPackSize] = useState(existing?.packSize ? existing.packSize.toString() : '');
  const [packPrice, setPackPrice] = useState(
    existing?.packPriceCents !== null && existing?.packPriceCents !== undefined
      ? (existing.packPriceCents / 100).toString()
      : '',
  );
  const pack = {
    size: parseInt(packSize, 10),
    priceCents: Math.round(parseFloat(packPrice) * 100),
  };
  const hasPack = pack.size > 0 && Number.isFinite(pack.priceCents) && pack.priceCents >= 0 && packPrice.trim() !== '';
  const unitChoices = [...new Set([...INGREDIENT_UNITS, ...(existing ? [existing.unit] : [])])];
  const [supplierId, setSupplierId] = useState(existing?.defaultSupplierId ?? '');
  const [sku, setSku] = useState(existing?.sku ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');

  const sup = useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: () => ipc.inventory.listSuppliers(),
  });

  const mut = useMutation({
    mutationFn: () => {
      const costPerUnitCents = hasPack
        ? costPerUnitFromPack(pack.priceCents, pack.size)
        : Math.round(parseFloat(costPerUnit || '0') * 100);
      const packFields = hasPack
        ? { packSize: pack.size, packPriceCents: pack.priceCents }
        : { packSize: null, packPriceCents: null };
      const low = parseInt(lowThreshold, 10) || 0;
      if (existing) {
        return ipc.inventory.updateIngredient({
          id: existing.id,
          name,
          unit,
          lowThreshold: low,
          costPerUnitCents,
          ...packFields,
          defaultSupplierId: supplierId || null,
          sku: sku || null,
          notes: notes || null,
        });
      }
      return ipc.inventory.createIngredient({
        name,
        unit,
        currentQty: parseInt(currentQty, 10) || 0,
        lowThreshold: low,
        costPerUnitCents,
        ...packFields,
        defaultSupplierId: supplierId || null,
        sku: sku || null,
        notes: notes || null,
      });
    },
    onSuccess: () => {
      toast({ title: existing ? 'Updated' : 'Created', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">
              {existing ? `Edit ${existing.name}` : 'Add ingredient'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Name</label>
                <input
                  type="text"
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Unit</label>
                <select
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                >
                  {unitChoices.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {!existing && (
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Opening qty</label>
                  <input
                    type="number"
                    step="1"
                    min={0}
                    inputMode="numeric"
                    value={currentQty}
                    onChange={(e) => setCurrentQty(e.target.value)}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Low at</label>
                <input
                  type="number"
                  step="1"
                  min={0}
                  inputMode="numeric"
                  value={lowThreshold}
                  onChange={(e) => setLowThreshold(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Cost per {unit}</label>
                <input
                  type="number"
                  step="0.001"
                  value={hasPack ? (pack.priceCents / pack.size / 100).toFixed(3) : costPerUnit}
                  disabled={hasPack}
                  onChange={(e) => setCostPerUnit(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono disabled:bg-stone-100 disabled:text-stone-500 dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
            </div>
            <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-800/50">
              <div className="mb-2 text-xs uppercase tracking-wider text-stone-500">Bought as (optional)</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-stone-500">Pack holds ({unit})</label>
                  <input
                    type="number"
                    step="1"
                    min={1}
                    inputMode="numeric"
                    value={packSize}
                    placeholder="e.g. 6000"
                    onChange={(e) => setPackSize(e.target.value)}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-900"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-stone-500">Pack price (Rs)</label>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={packPrice}
                    placeholder="e.g. 2250"
                    onChange={(e) => setPackPrice(e.target.value)}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-900"
                  />
                </div>
              </div>
              <p className="mt-2 text-xs text-stone-500">
                {hasPack
                  ? `= ${formatUnitCost({ unit, costPerUnitCents: 0, packSize: pack.size, packPriceCents: pack.priceCents })}`
                  : 'Type the pack from the supplier bill and the cost per ' + unit + ' is worked out for you.'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Default supplier</label>
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  <option value="">— None —</option>
                  {sup.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">SKU</label>
                <input
                  type="text"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Notes</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
          </div>
          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={mut.isPending || !name.trim() || !unit.trim()} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MovementDialog({
  ingredient,
  onClose,
}: {
  ingredient: Ingredient;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState<Extract<StockMovementReason, 'delivery' | 'waste' | 'count' | 'adjustment'>>('delivery');
  const [delta, setDelta] = useState('');
  const [notes, setNotes] = useState('');

  const isCount = reason === 'count';
  // Every reason needs an explicit integer — an empty "count" must never be
  // read as 0 (that would silently zero the ingredient).
  const deltaValid = /^-?\d+$/.test(delta.trim());
  const numericDelta = deltaValid ? parseInt(delta.trim(), 10) : 0;
  const computedDelta = isCount ? numericDelta - ingredient.currentQty : numericDelta;

  const mut = useMutation({
    mutationFn: () =>
      ipc.inventory.recordMovement({
        ingredientId: ingredient.id,
        deltaQty: computedDelta,
        reason,
        notes: notes || null,
      }),
    onSuccess: () => {
      toast({
        title: 'Stock updated',
        description: `${ingredient.name}: new qty recorded`,
        variant: 'success',
      });
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">Stock movement</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="mb-3 rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-800">
            <div className="font-semibold">{ingredient.name}</div>
            <div className="text-stone-500">
              Currently {ingredient.currentQty} {ingredient.unit}
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Reason</label>
              <div className="grid grid-cols-4 gap-2">
                {(['delivery', 'waste', 'count', 'adjustment'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={cn(
                      'rounded-lg border-2 px-2 py-2 text-xs font-semibold capitalize transition-colors',
                      reason === r
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                        : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                {isCount
                  ? `New on-hand quantity in ${ingredient.unit}`
                  : reason === 'delivery'
                  ? `Qty added in ${ingredient.unit}`
                  : reason === 'waste'
                  ? `Qty wasted in ${ingredient.unit}`
                  : `Qty change in ${ingredient.unit} (negative to subtract)`}
              </label>
              <input
                type="number"
                step="1"
                inputMode="numeric"
                value={delta}
                autoFocus
                onChange={(e) => setDelta(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-lg dark:border-stone-700 dark:bg-stone-800"
              />
              {deltaValid && (
                <div className="mt-1 text-xs text-stone-500">
                  Net change: {computedDelta > 0 ? '+' : ''}
                  {computedDelta} {ingredient.unit} →{' '}
                  <strong>{ingredient.currentQty + computedDelta} {ingredient.unit}</strong>
                </div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Note</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={reason === 'waste' ? 'Spoiled / dropped / etc.' : ''}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
          </div>
          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={mut.isPending || !deltaValid}
              onClick={() => {
                let normalizedDelta = computedDelta;
                if (reason === 'waste') normalizedDelta = -Math.abs(normalizedDelta);
                if (reason === 'delivery') normalizedDelta = Math.abs(normalizedDelta);
                // Re-run with normalized delta
                if (normalizedDelta !== computedDelta) {
                  void ipc.inventory
                    .recordMovement({
                      ingredientId: ingredient.id,
                      deltaQty: normalizedDelta,
                      reason,
                      notes: notes || null,
                    })
                    .then(() => {
                      toast({ title: 'Stock updated', variant: 'success' });
                      void qc.invalidateQueries({ queryKey: ['inventory'] });
                      onClose();
                    })
                    .catch((e) =>
                      toast({
                        title: 'Failed',
                        description: e instanceof Error ? e.message : String(e),
                        variant: 'error',
                      }),
                    );
                } else {
                  mut.mutate();
                }
              }}
            >
              {mut.isPending ? 'Saving…' : 'Record'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
