import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { Ingredient, RecordPurchaseResult } from '@cheeseoclock/shared-types';
import { Plus, ShoppingBasket, Trash2, Wallet, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { compareText } from '../../components/list';
import { COSTING_KEY, useCostAlertSettings } from '../costing/costingQueries';
import { IngredientSelect } from './IngredientSelect';
import { lineCheck, lineWords, payoutMatchText, readBill, readBoughtQty, type BoughtQty } from './purchase-view';

/** A drawer payout being turned into a purchase ("Turn this payout into a purchase"). */
export interface PayoutToConvert {
  id: string;
  amountCents: number;
  reason: string;
  createdAt: string;
  userName?: string | null;
}

interface Line {
  key: number;
  ingredientId: string;
  qty: string;
  bill: string;
  /** The answer to "Use it as the new price?"; null = not answered (the guard's default). */
  answer: boolean | null;
}

const whenText = (iso: string) =>
  new Date(iso).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * "Record a purchase" (costing spec Phase 5): what was bought and what was
 * paid for it, as the bill says — the Rs total for the amount — for a market
 * run or a bill paid at the door. Supplier optional. "Paid from the drawer"
 * takes the total out of this till's open shift at the same time, so the
 * drawer count at close still matches. When a price is very different from
 * the usual one it asks before using it, with "keep the usual price" picked
 * (D1: a quick purchase does not reprice the menu unless you say so).
 *
 * With `payout` it turns a cash payout already taken from the drawer into
 * the purchase it paid for: the drawer's figures never change.
 */
export function RecordPurchaseDialog({
  onClose,
  onSaved,
  ingredientId,
  payout,
}: {
  onClose: () => void;
  /** Called once the purchase is saved (the Purchases list switches to where it shows). */
  onSaved?: (result: RecordPurchaseResult) => void;
  /** Start with this ingredient on the first line (the Ingredients list's stock dialog). */
  ingredientId?: string;
  payout?: PayoutToConvert | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const ingQ = useQuery({ queryKey: ['inventory', 'ingredients', 'all'], queryFn: () => ipc.inventory.listIngredients() });
  const supQ = useQuery({ queryKey: ['inventory', 'suppliers'], queryFn: () => ipc.inventory.listSuppliers() });
  const shiftQ = useQuery({ queryKey: ['shifts', 'current'], queryFn: () => ipc.shifts.current(), enabled: !payout });
  const suppliers = useMemo(
    () => (supQ.data ?? []).filter((s) => s.isActive).sort((a, b) => compareText(a.name, b.name)),
    [supQ.data],
  );
  const nextKey = useRef(1);
  const newLine = (id = ''): Line => ({ key: nextKey.current++, ingredientId: id, qty: '', bill: '', answer: null });

  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [fromDrawerTicked, setFromDrawer] = useState(false);
  const [lines, setLines] = useState<Line[]>(() => [newLine(ingredientId ?? '')]);

  const byId = useMemo(() => new Map<string, Ingredient>((ingQ.data ?? []).map((i) => [i.id, i])), [ingQ.data]);
  // D1's band is the owner's price alert threshold (costing Phase 6), as the main process reads it.
  const guardBps = useCostAlertSettings().data?.jumpBps;
  const read = lines.map((l) => {
    const ing = byId.get(l.ingredientId);
    // A number alone under 1,000 of something weighed asks for the unit; what is read is shown under the box.
    const amount: BoughtQty = ing ? readBoughtQty(l.qty, ing.unit) : { qty: null, shows: null, problem: null };
    const qty = amount.qty;
    const bill = readBill(l.bill);
    const check = ing ? lineCheck(ing, qty, bill, 'quick', guardBps) : null;
    const words = check && qty !== null && bill !== null && ing ? lineWords(check, qty, bill, ing.unit) : null;
    const uses = check ? (check.ask ? (l.answer ?? check.adoptByDefault) : check.adoptByDefault) : false;
    return { line: l, ing, amount, qty, bill, check, words, uses };
  });
  const totalCents = read.reduce((s, r) => s + (r.bill ?? 0), 0);
  const shiftOpen = !!shiftQ.data;
  // Only with a shift open on this till: there is no drawer to take it from otherwise.
  const fromDrawer = fromDrawerTicked && shiftOpen && !payout;
  const picked = lines.map((l) => l.ingredientId).filter((id) => id !== '');
  const hasDup = new Set(picked).size !== picked.length;
  const problem =
    lines.length === 0
      ? 'Add what was bought.'
      : read.some((r) => !r.ing)
        ? 'Pick an ingredient on every line.'
        : hasDup
          ? 'Each ingredient once: add the amounts together.'
          : read.some((r) => r.qty === null)
            ? 'Say how much was bought on every line (e.g. 5 kg or 12).'
            : read.some((r) => r.bill === null)
              ? 'Type what was paid on every line, in rupees.'
              : fromDrawer && totalCents <= 0
                ? 'Nothing to take from the drawer: the bill comes to Rs 0.'
                : null;

  function update(key: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const submitting = useRef(false);
  const mut = useMutation({
    mutationFn: async (): Promise<RecordPurchaseResult> => {
      const body = {
        supplierId: supplierId || null,
        invoiceNo: invoiceNo.trim() || null,
        lines: read.map((r) => ({
          ingredientId: r.line.ingredientId,
          qty: r.qty!,
          billCents: r.bill!,
          // Only the answers the screen asked for: the rest follow the till's rule (D1).
          ...(r.check?.ask ? { usePrice: r.line.answer ?? r.check.adoptByDefault } : {}),
        })),
      };
      return payout
        ? ipc.inventory.payoutToPurchase({ cashMovementId: payout.id, ...body })
        : ipc.inventory.recordPurchase({ ...body, paidFromDrawer: fromDrawer });
    },
    onSettled: () => {
      submitting.current = false;
    },
    onSuccess: (r) => {
      const name = (id: string) => byId.get(id)?.name ?? 'an ingredient';
      const bits: string[] = [];
      if (r.pricesUsed.length > 0) bits.push(`New price for ${r.pricesUsed.map(name).join(', ')}.`);
      if (r.pricesKept.length > 0) bits.push(`Usual price kept for ${r.pricesKept.map(name).join(', ')}.`);
      if (fromDrawer) bits.push(`${formatCents(r.purchase.totalCents)} taken from the drawer.`);
      toast({
        title: payout ? 'The payout is now a purchase' : 'Purchase recorded',
        description: bits.join(' ') || 'The stock has been added.',
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      onSaved?.(r);
      onClose();
    },
    onError: (e) =>
      toast({ title: 'Could not record the purchase', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
  });

  const matchNote = payout && problem === null ? payoutMatchText(payout.amountCents, totalCents) : null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[760px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div className="flex items-start gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
                <ShoppingBasket className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="text-lg font-bold">{payout ? 'Turn this payout into a purchase' : 'Record a purchase'}</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  Type what the bill says: how much, and the rupees paid for it. The stock goes up now.
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex-1 space-y-4 overflow-auto p-5">
            {payout && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <Wallet className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>{formatCents(payout.amountCents)}</strong> taken from the drawer {whenText(payout.createdAt)}
                  {payout.userName ? ` by ${payout.userName}` : ''} — “{payout.reason}”. The drawer's figures stay as they are.
                </span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="rp-supplier" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                  Bought from
                </label>
                <select
                  id="rp-supplier"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  <option value="">No supplier (market)</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rp-bill" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                  Bill number (if any)
                </label>
                <input
                  id="rp-bill"
                  type="text"
                  value={invoiceNo}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
            </div>

            <div>
              <div className="mb-1 grid grid-cols-[1fr_8rem_8rem_2.5rem] gap-2 px-0.5 text-[11px] uppercase tracking-wider text-stone-500">
                <span>What</span>
                <span className="text-right">How much</span>
                <span className="text-right">Paid (Rs)</span>
                <span />
              </div>
              {read.map((r) => (
                <PurchaseLineRow
                  key={r.line.key}
                  ingredients={ingQ.data}
                  row={r}
                  onChange={(patch) => update(r.line.key, patch)}
                  onRemove={() => setLines((prev) => prev.filter((l) => l.key !== r.line.key))}
                />
              ))}
              <Button variant="secondary" size="sm" onClick={() => setLines((prev) => [...prev, newLine()])}>
                <Plus className="h-3 w-3" /> Add line
              </Button>
            </div>

            <div className="rounded-lg bg-stone-100 p-3 text-right text-sm dark:bg-stone-800">
              Total paid <span className="ml-2 font-mono text-base font-semibold">{formatCents(totalCents)}</span>
            </div>
            {matchNote && <p className="text-xs text-amber-800 dark:text-amber-300">{matchNote}</p>}

            {!payout && (
              <label className={cn('flex items-start gap-2 rounded-lg border border-stone-200 p-3 text-sm dark:border-stone-700', !shiftOpen && 'opacity-60')}>
                <input type="checkbox" className="mt-0.5" checked={fromDrawer} disabled={!shiftOpen} onChange={(e) => setFromDrawer(e.target.checked)} />
                <span>
                  <span className="font-semibold">Paid from the drawer</span>
                  <span className="block text-xs text-stone-500">
                    {shiftOpen
                      ? 'The total is taken out of the drawer as cash out, so the count at close still matches. The drawer opens.'
                      : 'No shift is open on this till, so this cannot come out of the drawer.'}
                  </span>
                </span>
              </label>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            {problem && <span className="mr-auto text-xs text-stone-500">{problem}</span>}
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={problem !== null || mut.isPending}
              onClick={() => {
                if (submitting.current) return;
                submitting.current = true;
                mut.mutate();
              }}
            >
              {mut.isPending ? 'Saving…' : payout ? 'Save as a purchase' : 'Record purchase'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PurchaseLineRow({
  ingredients,
  row,
  onChange,
  onRemove,
}: {
  ingredients: Ingredient[] | undefined;
  row: {
    line: Line;
    ing: Ingredient | undefined;
    amount: BoughtQty;
    qty: number | null;
    bill: number | null;
    words: ReturnType<typeof lineWords> | null;
    uses: boolean;
    check: ReturnType<typeof lineCheck>;
  };
  onChange: (patch: Partial<Line>) => void;
  onRemove: () => void;
}) {
  const { line, ing, words, check, amount } = row;
  const unitHint = ing ? (ing.unit === 'g' ? 'kg or g' : ing.unit === 'ml' ? 'litre or ml' : ing.unit) : '';
  return (
    <div className="mb-3">
      <div className="grid grid-cols-[1fr_8rem_8rem_2.5rem] items-center gap-2">
        <IngredientSelect ingredients={ingredients} value={line.ingredientId} onChange={(id) => onChange({ ingredientId: id, answer: null })} className="min-w-0" />
        <input
          type="text"
          inputMode="decimal"
          value={line.qty}
          onChange={(e) => onChange({ qty: e.target.value, answer: null })}
          placeholder={ing ? (ing.unit === 'g' ? 'e.g. 5 kg' : ing.unit === 'ml' ? 'e.g. 2 litre' : `e.g. 12 ${ing.unit}`) : 'amount'}
          aria-label={`How much${ing ? ` (${unitHint})` : ''}`}
          className="w-full rounded-lg border border-stone-300 px-2 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
        />
        <input
          type="text"
          inputMode="decimal"
          value={line.bill}
          onChange={(e) => onChange({ bill: e.target.value, answer: null })}
          placeholder="Rs"
          aria-label="Paid in rupees"
          className="w-full rounded-lg border border-stone-300 px-2 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
        />
        <button type="button" onClick={onRemove} className="rounded p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950" aria-label="Remove line">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {(amount.shows || amount.problem) && (
        <div className="mt-0.5 grid grid-cols-[1fr_8rem_8rem_2.5rem] gap-2 text-[11px]">
          <span />
          <span className={cn('text-right', amount.problem ? 'text-red-700 dark:text-red-400' : 'text-stone-500')}>
            {amount.problem ?? amount.shows}
          </span>
        </div>
      )}
      {words && check && <PriceQuestion words={words} check={check} uses={row.uses} onAnswer={(answer) => onChange({ answer })} />}
    </div>
  );
}

/**
 * Under a line: the price the bill works out to, and what happens to the
 * ingredient's price — or D1's question, with the default answer picked.
 * Shared by "Record a purchase" and Receive.
 */
export function PriceQuestion({
  words,
  check,
  uses,
  onAnswer,
}: {
  words: ReturnType<typeof lineWords>;
  check: NonNullable<ReturnType<typeof lineCheck>>;
  uses: boolean;
  onAnswer: (answer: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'mt-1 rounded-lg px-2.5 py-1.5 text-xs',
        words.warn ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200' : 'text-stone-500',
      )}
      aria-live="polite"
    >
      <span className="font-mono font-semibold">{words.price}</span> · {words.note}
      {words.ask && check.adoptable && (
        <span className="ml-2 inline-flex overflow-hidden rounded-md border border-amber-300 align-middle dark:border-amber-700" role="group" aria-label="Use it as the new price?">
          <button
            type="button"
            aria-pressed={!uses}
            onClick={() => onAnswer(false)}
            className={cn('px-2 py-0.5 font-semibold', !uses ? 'bg-amber-500 text-stone-900' : 'bg-white dark:bg-stone-900')}
          >
            Keep the usual
          </button>
          <button
            type="button"
            aria-pressed={uses}
            onClick={() => onAnswer(true)}
            className={cn('px-2 py-0.5 font-semibold', uses ? 'bg-amber-500 text-stone-900' : 'bg-white dark:bg-stone-900')}
          >
            Use {words.price}
          </button>
        </span>
      )}
    </div>
  );
}
