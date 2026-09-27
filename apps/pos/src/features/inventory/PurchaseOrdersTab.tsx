import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents, formatQty, orderedValueCents, stockStatus, thousandWord, typedPricePack, valueCents, type Pack } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { DrawerPayout, Ingredient, PurchaseOrder, PurchaseOrderStatus } from '@cheeseoclock/shared-types';
import { Plus, X, Trash2, PackageCheck, Send, AlertTriangle, ListPlus, ShoppingBasket, Wallet } from 'lucide-react';
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
import { COSTING_KEY, useCostAlertSettings } from '../costing/costingQueries';
import { formatBps, parseRupees } from '../costing/costingFormat';
import { IngredientSelect } from './IngredientSelect';
import { suggestReorderQty } from './ingredient-list';
import { useStockRules } from '../settings/shop-rules/useShopSetting';
import { initialPriceEntry, perChoices, type PricePer } from './price-view';
import { billUnitText, lineCheck, lineWords, orderedPriceText, purchaseTotalText, readBill, readBoughtQty, readQty } from './purchase-view';
import { PriceQuestion, RecordPurchaseDialog, type PayoutToConvert } from './RecordPurchaseDialog';
import { PO_LIST_KEY, PO_RECENT_LIMIT, fetchPurchaseList } from './purchaseListQuery';

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
const whenFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

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

/**
 * What names a purchase in the list: its order or bill number; for a
 * purchase bought on the spot with neither, its note (a converted payout's
 * "Veg market") rather than an id the owner never saw.
 */
function purchaseRef(po: PurchaseOrder): { text: string; isNumber: boolean } {
  const no = po.referenceNo ?? po.invoiceNo;
  if (no) return { text: no, isNumber: true };
  if (po.kind === 'quick') return { text: po.notes?.trim() || 'No bill number', isNumber: false };
  return { text: po.id.slice(0, 8), isNumber: true };
}

/** The list's Total: what the bills came to once something came in (with what was ordered), else what was ordered. */
function PurchaseTotal({ po }: { po: PurchaseOrder }) {
  const t = purchaseTotalText(po);
  return (
    <>
      <span className="font-mono">{t.main}</span>
      {t.note && <span className="block whitespace-nowrap text-[11px] text-stone-500">{t.note}</span>}
    </>
  );
}

/** "No supplier named" for a market run; the supplier's name otherwise. */
function useSupplierName() {
  const supQ = useQuery({ queryKey: ['inventory', 'suppliers'], queryFn: () => ipc.inventory.listSuppliers() });
  return {
    supQ,
    supName: useCallback(
      (id: string | null) => (id === null ? 'No supplier named' : (supQ.data?.find((s) => s.id === id)?.name ?? 'Unknown supplier')),
      [supQ.data],
    ),
  };
}

/**
 * Inventory → Purchases (costing spec Phase 5): purchase orders placed with
 * suppliers and received at the real bill, purchases recorded on the spot
 * ("Record a purchase"), and cash paid from the drawer that is not yet a
 * purchase. Managers and the owner only (the main process refuses the rest).
 */
export function PurchaseOrdersTab() {
  const q = useQuery({
    queryKey: PO_LIST_KEY,
    // The newest purchases, and every order still open whatever its age (fetchPurchaseList).
    queryFn: fetchPurchaseList,
  });
  const { supQ, supName } = useSupplierName();
  const [creating, setCreating] = useState(false);
  const [recording, setRecording] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [status, setStatus] = useSessionState<StatusFilter>('inv.po.status', 'open');
  const [supplierId, setSupplierId] = useSessionState('inv.po.supplier', '');

  const filter = useCallback(
    (po: PurchaseOrder) =>
      (!supplierId || po.supplierId === supplierId) &&
      (status === 'all' || (status === 'open' ? isOpen(po.status) : po.status === status)),
    [status, supplierId],
  );
  const searchText = useCallback(
    (po: PurchaseOrder) =>
      `${po.referenceNo ?? ''} ${po.invoiceNo ?? ''} ${po.id.slice(0, 8)} ${supName(po.supplierId)} ${STATUS_LABEL[po.status]} ${po.kind === 'quick' ? 'purchase bought market' : ''} ${po.notes ?? ''}`,
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
  /**
   * The newest purchases filled the list: older ones (received or closed —
   * every open order is always fetched) are left out. The merged list is
   * shorter than the cap whenever nothing was left out.
   */
  const capped = (q.data ?? []).length >= PO_RECENT_LIMIT;

  /**
   * A purchase recorded here is received at once, so "Still open" would not
   * show it: switch to Received, where it is the newest, so it is seen saved
   * (and not recorded twice).
   */
  const resetQuery = list.setQuery;
  const showSaved = useCallback(() => {
    setStatus('received');
    setSupplierId('');
    resetQuery('');
  }, [setStatus, setSupplierId, resetQuery]);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Purchases</h2>
          <p className="mt-0.5 text-sm text-stone-500">
            What you order from suppliers and book in at the bill, and what you buy on the spot.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRecording(true)}>
              <ShoppingBasket className="h-4 w-4" /> Record a purchase
            </Button>
            <Button variant="primary" size="sm" disabled={activeSuppliers.length === 0} onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New purchase order
            </Button>
          </div>
          {supQ.data && activeSuppliers.length === 0 && (
            <span className="text-xs text-stone-500">Add a supplier first to place an order (Suppliers tab).</span>
          )}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={list.query} onChange={list.setQuery} placeholder="Search reference, bill or supplier…" label="Search purchases" />
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
                <td className={cn('py-2 text-xs', purchaseRef(po).isNumber ? 'font-mono' : 'text-stone-600 dark:text-stone-400')}>{purchaseRef(po).text}</td>
                <td className="py-2">
                  {supName(po.supplierId)}
                  {po.kind === 'quick' && (
                    <span className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                      bought on the spot
                    </span>
                  )}
                </td>
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
                <td className="py-2 text-right">
                  <PurchaseTotal po={po} />
                </td>
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
                      ? 'No purchases yet.'
                      : status === 'open' && !list.query && !supplierId
                        ? 'Nothing on order right now. Purchases bought on the spot are under Received.'
                        : 'No purchases match.'}
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
        noun={list.total === 1 ? 'purchase' : 'purchases'}
      />
      {capped && (
        <p className="mt-2 text-xs text-stone-500">
          Showing the newest {PO_RECENT_LIMIT.toLocaleString('en-PK')} purchases and every order still open. Reports has the spend for any
          period.
        </p>
      )}

      <DrawerPayoutsPanel onConverted={showSaved} />

      {creating && <CreatePoDialog onClose={() => setCreating(false)} />}
      {recording && <RecordPurchaseDialog onSaved={showSaved} onClose={() => setRecording(false)} />}
      {opening && <OpenPoDialog poId={opening} onClose={() => setOpening(null)} />}
    </Card>
  );
}

/**
 * Cash taken out of this till's drawer in the last 30 days that is not a
 * purchase (a market run a cashier paid with a manager's PIN): "Turn into a
 * purchase" books the stock in at what was paid. The drawer's figures never
 * change. Most payouts are not stock (gas, bills, an advance), so this is not
 * a to-do list: it stays folded to one line until opened (remembered for the
 * session), in plain colours, and says nothing needs doing for the rest.
 */
function DrawerPayoutsPanel({ onConverted }: { onConverted: () => void }) {
  const q = useQuery({ queryKey: ['inventory', 'drawerPayouts'], queryFn: () => ipc.inventory.listDrawerPayouts() });
  const [converting, setConverting] = useState<PayoutToConvert | null>(null);
  const [shown, setShown] = useSessionState('inv.po.payoutsOpen', false);
  const open = (q.data ?? []).filter((p: DrawerPayout) => p.refPurchaseOrderId === null);
  if (open.length === 0) return null;
  const totalCents = open.reduce((sum, p) => sum + p.amountCents, 0);
  return (
    <section className="mt-6 rounded-lg border border-stone-200 p-3 dark:border-stone-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Wallet className="h-4 w-4 text-stone-500" /> Cash paid from the drawer, not a purchase
          <span className="font-normal text-stone-500">
            · {open.length} in the last 30 days, {formatCents(totalCents)}
          </span>
        </h3>
        <Button variant="ghost" size="sm" aria-expanded={shown} onClick={() => setShown(!shown)}>
          {shown ? 'Hide' : 'Show'}
        </Button>
      </div>
      {shown && (
        <>
          <p className="mt-1 text-xs text-stone-500">
            If one of them bought stock, turn it into a purchase: the stock goes up and the bill is kept. The rest (gas, bills,
            an advance) can stay as they are. The drawer&apos;s figures never change.
          </p>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {open.map((p) => (
                <tr key={p.id} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="whitespace-nowrap py-2 text-stone-500">{whenFmt.format(new Date(p.createdAt))}</td>
                  <td className="py-2">
                    {p.reason}
                    <span className="text-xs text-stone-500">
                      {p.userName ? ` · ${p.userName}` : ''}
                      {p.approvedByName ? ` (approved by ${p.approvedByName})` : ''}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono">{formatCents(p.amountCents)}</td>
                  <td className="py-2 text-right">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setConverting({ id: p.id, amountCents: p.amountCents, reason: p.reason, createdAt: p.createdAt, userName: p.userName })}
                    >
                      Turn into a purchase
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {converting && <RecordPurchaseDialog payout={converting} onSaved={onConverted} onClose={() => setConverting(null)} />}
    </section>
  );
}

/** A purchase order line as typed: the amount, and the price as it is bought. */
type Line = { ingredientId: string; qty: string; per: PricePer; rupees: string; packSize: string };

const emptyLine = (): Line => ({ ingredientId: '', qty: '', per: 'thousand', rupees: '', packSize: '' });

/** The price boxes, filled with the way the ingredient is priced now ("Rs 375 per kg", "Rs 2,250 for 6,000 g"). */
function priceBoxesFor(i: Ingredient | undefined): Pick<Line, 'per' | 'rupees' | 'packSize'> {
  if (!i) return { per: 'thousand', rupees: '', packSize: '' };
  const e = initialPriceEntry(i);
  const per = perChoices(i.unit).includes(e.per) ? e.per : (perChoices(i.unit)[0] ?? 'piece');
  return { per, rupees: e.free ? '' : e.rupees, packSize: e.packSize };
}

/** The exact pack a line's price boxes say; null when they can't be read. Rs 0 is allowed on an order. */
function linePack(l: Line, unit: string): Pack | null {
  const cents = parseRupees(l.rupees);
  if (cents === null) return null;
  let packSize: number | null = null;
  if (l.per === 'pack') {
    const t = l.packSize.trim().replace(/,/g, '');
    if (!/^\d{1,9}$/.test(t) || Number(t) < 1) return null;
    packSize = Number(t);
  }
  try {
    return typedPricePack({ per: l.per, priceCents: cents, packSize }, unit);
  } catch {
    return null;
  }
}

function perText(per: PricePer, unit: string): string {
  if (per === 'thousand') return `per ${thousandWord(unit) ?? 'kg'}`;
  if (per === 'pack') return 'per pack';
  return 'each';
}

function CreatePoDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const supQ = useQuery({ queryKey: ['inventory', 'suppliers'], queryFn: () => ipc.inventory.listSuppliers() });
  const ingQ = useQuery({ queryKey: ['inventory', 'ingredients', 'all'], queryFn: () => ipc.inventory.listIngredients() });
  // "Add low stock" fills up to the owner's multiple of the low level (Settings → Kitchen & stock; 3 by default).
  const { reorderMultiple } = useStockRules();
  const suppliers = useMemo(
    () => (supQ.data ?? []).filter((s) => s.isActive).sort((a, b) => compareText(a.name, b.name)),
    [supQ.data],
  );

  const [supplierId, setSupplierId] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);

  // With a single supplier there is nothing to choose.
  useEffect(() => {
    if (!supplierId && suppliers.length === 1 && suppliers[0]) setSupplierId(suppliers[0].id);
  }, [suppliers, supplierId]);

  const ingOf = (id: string) => ingQ.data?.find((x) => x.id === id);
  function updateLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Fill the price from what the ingredient costs now, unless one was typed
  // that fits it (per kg only fits something weighed).
  function onPickIngredient(i: number, ingId: string) {
    const ing = ingOf(ingId);
    const cur = lines[i];
    const keep = !!ing && !!cur && cur.rupees !== '' && perChoices(ing.unit).includes(cur.per);
    updateLine(i, { ingredientId: ingId, ...(keep ? {} : priceBoxesFor(ing)) });
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
      ...prev.filter((l) => l.ingredientId || l.qty || l.rupees),
      ...lowForSupplier.map((i) => ({ ingredientId: i.id, qty: String(suggestReorderQty(i, reorderMultiple)), ...priceBoxesFor(i) })),
    ]);
  }

  const parsed = lines.map((l) => {
    const ing = ingOf(l.ingredientId);
    const qty = ing ? readQty(l.qty, ing.unit) : null;
    const pack = ing ? linePack(l, ing.unit) : null;
    return { line: l, ing, qty, pack, totalCents: qty !== null && pack ? valueCents(qty, pack) : null };
  });
  const lineOk = (p: (typeof parsed)[number]) => !!p.ing && p.qty !== null && p.pack !== null;
  const totalCents = parsed.reduce((sum, p) => sum + (p.totalCents ?? 0), 0);
  const problem = !supplierId
    ? 'Pick the supplier.'
    : lines.length === 0
      ? 'Add at least one line.'
      : parsed.some((p) => !p.ing)
        ? 'Pick an ingredient on every line.'
        : parsed.some((p) => !lineOk(p))
          ? 'Every line needs an amount (e.g. 5 kg) and a price.'
          : null;

  const mut = useMutation({
    mutationFn: () =>
      ipc.inventory.createPurchaseOrder({
        supplierId,
        referenceNo: referenceNo.trim() || null,
        expectedAt: expectedAt || null,
        items: parsed.map((p) => ({
          ingredientId: p.line.ingredientId,
          // Whole base units (g / ml / pcs) — INTEGER in SQLite.
          qtyOrdered: p.qty!,
          // The price as it is bought, kept exactly (costing spec Phase 5).
          price: {
            per: p.line.per,
            priceCents: parseRupees(p.line.rupees)!,
            packSize: p.line.per === 'pack' ? p.pack!.size : null,
          },
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[820px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
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
              <Field label="Order reference" htmlFor="po-ref">
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
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={addLowStock}
                    title={`Each up to ${reorderMultiple} times its low level, in whole packs (Settings → Kitchen & stock)`}
                  >
                    <ListPlus className="h-4 w-4" /> Add {lowForSupplier.length} low-stock item{lowForSupplier.length === 1 ? '' : 's'}
                  </Button>
                )}
              </div>
              <div className="mb-1 grid grid-cols-[1fr_7rem_6.5rem_7rem_6.5rem_2.5rem] gap-2 px-0.5 text-[11px] uppercase tracking-wider text-stone-500">
                <span>Ingredient</span>
                <span className="text-right">How much</span>
                <span className="text-right">Price (Rs)</span>
                <span>Per</span>
                <span className="text-right">Line total</span>
                <span />
              </div>
              {parsed.map((p, i) => {
                const { line, ing } = p;
                return (
                  <div key={i} className="mb-2 grid grid-cols-[1fr_7rem_6.5rem_7rem_6.5rem_2.5rem] items-center gap-2">
                    <IngredientSelect
                      ingredients={ingQ.data}
                      value={line.ingredientId}
                      onChange={(id) => onPickIngredient(i, id)}
                      className="min-w-0"
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      value={line.qty}
                      onChange={(e) => updateLine(i, { qty: e.target.value })}
                      placeholder={ing?.unit === 'g' ? 'e.g. 5 kg' : ing?.unit === 'ml' ? 'e.g. 2 litre' : 'qty'}
                      aria-label="How much"
                      className="w-full rounded-lg border border-stone-300 px-2 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      value={line.rupees}
                      onChange={(e) => updateLine(i, { rupees: e.target.value })}
                      placeholder="Rs"
                      aria-label="Price in rupees"
                      className="w-full rounded-lg border border-stone-300 px-2 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                    />
                    <select
                      value={line.per}
                      onChange={(e) => updateLine(i, { per: e.target.value as PricePer })}
                      aria-label="The price is"
                      disabled={!ing}
                      className="w-full rounded-lg border border-stone-300 px-2 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
                    >
                      {(ing ? perChoices(ing.unit) : (['thousand', 'pack', 'piece'] as PricePer[])).map((per) => (
                        <option key={per} value={per}>
                          {perText(per, ing?.unit ?? 'g')}
                        </option>
                      ))}
                    </select>
                    <span className="text-right font-mono text-xs text-stone-600 dark:text-stone-300">
                      {p.totalCents !== null ? formatCents(p.totalCents) : '—'}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      className="rounded p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    {line.per === 'pack' && ing && (
                      <label className="col-span-6 -mt-1 flex items-center gap-2 px-0.5 text-xs text-stone-600 dark:text-stone-300">
                        One pack holds
                        <input
                          type="text"
                          inputMode="numeric"
                          value={line.packSize}
                          onChange={(e) => updateLine(i, { packSize: e.target.value })}
                          placeholder="e.g. 6000"
                          aria-label={`One pack holds (${ing.unit})`}
                          className="w-24 rounded border border-stone-300 px-2 py-1 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                        />
                        {ing.unit}
                      </label>
                    )}
                    {ing && lineOk(p) && (
                      <span className="col-span-6 -mt-1 px-0.5 text-[11px] text-stone-500">
                        {formatQty(p.qty!, ing.unit)} · in stock now {formatQty(ing.currentQty, ing.unit)}
                      </span>
                    )}
                  </div>
                );
              })}
              <Button variant="secondary" size="sm" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
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
  const { supName } = useSupplierName();

  /** What came in now, per line, as typed. */
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  /** The bill for it, per line, as typed ('' = the ordered price for that amount). */
  const [bills, setBills] = useState<Record<string, string>>({});
  /** "Use it as the new price?" per line, when asked (absent = the default: yes). */
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [invoiceNo, setInvoiceNo] = useState('');

  const po = q.data;
  const ingOf = (id: string) => ingQ.data?.find((x) => x.id === id);
  // D1's band is the owner's price alert threshold (costing Phase 6), as the main process reads it.
  const guardBps = useCostAlertSettings().data?.jumpBps;

  const lines = (po?.items ?? []).map((item) => {
    const ing = ingOf(item.ingredientId);
    const qtyText = (receipts[item.id] ?? '').trim();
    // A number alone under 1,000 of something weighed asks for the unit ("5" under a "5 kg" hint is not 5 g).
    const read = ing ? readBoughtQty(qtyText, ing.unit) : { qty: null, shows: null, problem: null };
    const qty = read.qty;
    const billText = (bills[item.id] ?? '').trim();
    const bill = billText !== '' ? readBill(billText) : qty !== null ? orderedValueCents(qty, item) : null;
    const check = ing && qty !== null && bill !== null ? lineCheck(ing, qty, bill, 'order', guardBps) : null;
    const words = check && ing && qty !== null && bill !== null ? lineWords(check, qty, bill, ing.unit) : null;
    const uses = check ? (check.ask ? (answers[item.id] ?? check.adoptByDefault) : check.adoptByDefault) : false;
    return { item, ing, qtyText, read, qty, billText, bill, check, words, uses };
  });

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
        invoiceNo: invoiceNo.trim() || null,
        receipts: lines
          .filter((l) => l.qty !== null && l.qty > 0 && l.bill !== null)
          .map((l) => ({
            purchaseOrderItemId: l.item.id,
            qtyReceivedNow: l.qty!,
            billCents: l.bill!,
            // Only the answers the screen asked for: the rest follow the till's rule (D1).
            ...(l.check?.ask ? { usePrice: l.uses } : {}),
          })),
      }),
    onSuccess: (r) => {
      toast({
        title: r.status === 'received' ? 'Delivery booked in — order complete' : 'Delivery booked in',
        description: 'The stock has been added at the bill.',
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      setReceipts({});
      setBills({});
      setAnswers({});
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

  const quick = po.kind === 'quick';
  const canReceive = isOpen(po.status);
  const typed = lines.some((l) => l.qty !== null && l.qty > 0);
  const badReceipt = lines.some((l) => (l.qtyText !== '' && l.qty === null) || (l.billText !== '' && l.bill === null));
  const billedCents = po.items.reduce((s, it) => s + it.receivedValueCents, 0);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[860px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">
                {quick ? 'Bought from ' : ''}
                {supName(po.supplierId)} · {purchaseRef(po).text}
              </Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                  <StatusPill status={po.status} />
                  {!quick && po.orderedAt && <span>Ordered {formatDate(po.orderedAt)}</span>}
                  {!quick && po.expectedAt && <span>· Expected {formatDate(po.expectedAt)}</span>}
                  {po.receivedAt && <span>{quick ? 'Bought' : '· Received'} {formatDate(po.receivedAt)}</span>}
                  {po.invoiceNo && <span>· Bill {po.invoiceNo}</span>}
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
            {po.payout && (
              <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <Wallet className="h-4 w-4" /> Paid from the drawer: {formatCents(po.payout.amountCents)} ({whenFmt.format(new Date(po.payout.createdAt))})
              </div>
            )}
            {canReceive && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                <span>Delivery arrived? Type what came in and what the bill says for it, then press Receive.</span>
                <div className="flex items-center gap-2">
                  <label htmlFor="po-invoice" className="text-xs">
                    Bill number
                  </label>
                  <input
                    id="po-invoice"
                    type="text"
                    value={invoiceNo}
                    onChange={(e) => setInvoiceNo(e.target.value)}
                    className="w-28 rounded border border-emerald-300 bg-white px-2 py-1 font-mono text-sm dark:border-emerald-800 dark:bg-stone-900"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      // With the unit ("500 g"), so what is filled in is read exactly as it says.
                      setReceipts(
                        Object.fromEntries(
                          po.items
                            .filter((it) => it.qtyOrdered > it.qtyReceived)
                            .map((it) => {
                              const unit = ingOf(it.ingredientId)?.unit;
                              const rest = it.qtyOrdered - it.qtyReceived;
                              return [it.id, unit ? `${rest} ${unit}` : String(rest)];
                            }),
                        ),
                      );
                      setBills({});
                      setAnswers({});
                    }}
                  >
                    Everything came
                  </Button>
                </div>
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
                <tr>
                  <th className="pb-2">Ingredient</th>
                  <th className="pb-2 text-right">{quick ? 'Bought' : 'Ordered'}</th>
                  {!quick && <th className="pb-2 text-right">Received</th>}
                  <th className="pb-2 text-right">Price</th>
                  <th className="pb-2 text-right">{quick ? 'Paid' : 'Billed'}</th>
                  {canReceive && <th className="pb-2 text-right">Came in now</th>}
                  {canReceive && <th className="pb-2 text-right">Bill (Rs)</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const { item, ing } = l;
                  const unit = ing?.unit ?? '';
                  const remaining = item.qtyOrdered - item.qtyReceived;
                  return (
                    <tr key={item.id} className="border-t border-stone-100 align-top dark:border-stone-800">
                      <td className="py-2 font-medium">
                        {ing?.name ?? 'Deleted ingredient'}
                        {canReceive && l.words && l.check && (
                          <PriceQuestion
                            words={l.words}
                            check={l.check}
                            uses={l.uses}
                            onAnswer={(a) => setAnswers({ ...answers, [item.id]: a })}
                          />
                        )}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right font-mono">{formatQty(item.qtyOrdered, unit)}</td>
                      {!quick && <td className="whitespace-nowrap py-2 text-right font-mono">{formatQty(item.qtyReceived, unit)}</td>}
                      <td className="whitespace-nowrap py-2 text-right font-mono text-xs">
                        {quick && item.qtyReceived > 0 ? billUnitText(item.qtyReceived, item.receivedValueCents, unit) : orderedPriceText(item, unit)}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right font-mono">
                        {item.qtyReceived > 0 ? formatCents(item.receivedValueCents) : '—'}
                      </td>
                      {canReceive && (
                        <td className="py-2 text-right">
                          {remaining > 0 ? (
                            <>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={receipts[item.id] ?? ''}
                                onChange={(e) => {
                                  setReceipts({ ...receipts, [item.id]: e.target.value });
                                  const { [item.id]: _drop, ...rest } = answers;
                                  setAnswers(rest);
                                }}
                                placeholder={formatQty(remaining, unit)}
                                aria-label={`How much ${ing?.name ?? 'of it'} came in`}
                                className="w-28 rounded border border-stone-300 px-2 py-1 text-right font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                              />
                              {l.read.shows && (
                                <div className="mt-0.5 text-[11px] text-stone-500">
                                  {l.read.shows}
                                  {l.qty !== null && l.qty > remaining && (
                                    <span className="text-amber-700 dark:text-amber-300"> · more than ordered</span>
                                  )}
                                </div>
                              )}
                              {l.read.problem && (
                                <div className="mt-0.5 max-w-[9rem] text-[11px] text-red-700 dark:text-red-400">{l.read.problem}</div>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-emerald-600">all in</span>
                          )}
                        </td>
                      )}
                      {canReceive && (
                        <td className="py-2 text-right">
                          {remaining > 0 && (
                            <input
                              type="text"
                              inputMode="decimal"
                              value={bills[item.id] ?? ''}
                              onChange={(e) => {
                                setBills({ ...bills, [item.id]: e.target.value });
                                const { [item.id]: _drop, ...rest } = answers;
                                setAnswers(rest);
                              }}
                              placeholder={l.qty !== null ? String(orderedValueCents(l.qty, item) / 100) : 'Rs'}
                              aria-label={`What the bill says for ${ing?.name ?? 'it'}, in rupees`}
                              className="w-28 rounded border border-stone-300 px-2 py-1 text-right font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-stone-300 dark:border-stone-700">
                  <td className="pt-2 font-semibold" colSpan={quick ? 3 : 4}>
                    {quick ? 'Total paid' : `Ordered ${formatCents(po.totalCents)}`}
                  </td>
                  <td className="pt-2 text-right font-mono font-semibold">{billedCents > 0 ? formatCents(billedCents) : '—'}</td>
                  {canReceive && <td colSpan={2} />}
                </tr>
              </tfoot>
            </table>
            {canReceive && (
              <p className="mt-3 text-xs text-stone-500">
                The bill box starts at the ordered price for what came. A price more than {formatBps(guardBps ?? 1_000)} away
                from the usual one asks before it is used.
              </p>
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
