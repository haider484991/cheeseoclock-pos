/**
 * Inventory → Stock takes (costing spec Phase 8): the list of stock takes
 * (when, what, who, what went missing in rupees), starting one — the key
 * items (weekly), the whole store room (monthly), or a few picked — the count
 * sheet, and a finished one's differences against SHOP stock (the last stock
 * take plus every till's stock rows since), with a link to "Used vs should
 * have used". Managers and the owner only (the till refuses anyone else).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents, formatQty } from '@cheeseoclock/pos-domain';
import {
  STOCK_COUNT_SCOPE_LABEL,
  type StockCountDetail,
  type StockCountFinish,
  type StockCountScope,
  type StockCountSummary,
} from '@cheeseoclock/shared-types';
import { ClipboardCheck, KeyRound, ListChecks, Loader2, Scale, Warehouse, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SearchBox, useSessionState } from '../../components/list';
import { fmtMoment } from '../reports/dateRange';
import { countLineDifferenceText, signedCents, stockCountDifferenceText } from '../reports/varianceFormat';
import { openStockVariance } from '../costing/deepLinks';
import { CountSheet, STOCK_COUNTS_KEY } from './CountSheet';

type View = { kind: 'list' } | { kind: 'sheet'; countId: string } | { kind: 'done'; countId: string; finish: StockCountFinish | null };

export function StockTakesTab() {
  const [view, setView] = useSessionState<View>('inv.stock.view', { kind: 'list' });
  if (view.kind === 'sheet') {
    return (
      <CountSheet
        countId={view.countId}
        onClose={() => setView({ kind: 'list' })}
        onDone={(r) => setView(r ? { kind: 'done', countId: r.count.id, finish: r } : { kind: 'list' })}
      />
    );
  }
  if (view.kind === 'done') {
    return <FinishedCount countId={view.countId} finish={view.finish} onBack={() => setView({ kind: 'list' })} />;
  }
  return <StockTakeList onOpen={(c) => setView(c.status === 'open' ? { kind: 'sheet', countId: c.id } : { kind: 'done', countId: c.id, finish: null })} />;
}

function StockTakeList({ onOpen }: { onOpen: (c: Pick<StockCountSummary, 'id' | 'status'>) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [picking, setPicking] = useState(false);
  const list = useQuery({ queryKey: [...STOCK_COUNTS_KEY, 'list'], queryFn: () => ipc.inventory.stockCountList({ limit: 200 }) });
  const start = useMutation({
    mutationFn: (req: { scope: StockCountScope; ingredientIds?: string[] }) => ipc.inventory.stockCountStart(req),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: STOCK_COUNTS_KEY });
      onOpen(c);
    },
    onError: (e) => toast({ title: 'Could not start the stock take', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
  });
  const open = (list.data ?? []).filter((c) => c.status === 'open');
  const rest = (list.data ?? []).filter((c) => c.status !== 'open');

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <ClipboardCheck className="h-5 w-5 text-amber-600 dark:text-amber-400" /> Stock takes
          </h2>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            Count what is on the shelves, shelf by shelf. When you finish, the till shows what is missing against what it
            expected and what that is worth, and Reports sets what was used against what should have been. Count the key items
            every week and everything once a month.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={start.isPending} onClick={() => start.mutate({ scope: 'key_items' })}>
            <KeyRound className="h-4 w-4" /> Count the key items
          </Button>
          <Button variant="secondary" disabled={start.isPending} onClick={() => start.mutate({ scope: 'full' })}>
            <Warehouse className="h-4 w-4" /> Full stock take
          </Button>
          <Button variant="secondary" disabled={start.isPending} onClick={() => setPicking(true)}>
            <ListChecks className="h-4 w-4" /> Pick what to count
          </Button>
          {start.isPending && <Loader2 className="h-5 w-5 animate-spin self-center text-stone-400" />}
        </div>
        <p className="text-xs text-stone-500">Key items are ticked on each ingredient (Edit → Key item), or on Costing → Targets.</p>
      </Card>

      {open.map((c) => (
        <Card key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40">
          <div>
            <div className="font-semibold">Being counted: {STOCK_COUNT_SCOPE_LABEL[c.scope]}</div>
            <div className="text-sm text-stone-600 dark:text-stone-300">
              Started {fmtMoment(c.startedAt)}
              {c.countedByName ? ` by ${c.countedByName}` : ''} · {c.countedCount} of {c.lineCount} counted
              {c.thisTill ? '' : ' · on the other till'}
            </div>
          </div>
          <Button variant="primary" onClick={() => onOpen(c)}>
            Carry on counting
          </Button>
        </Card>
      ))}

      <Card>
        {list.isLoading ? (
          <p className="flex items-center justify-center gap-2 py-6 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : rest.length === 0 ? (
          <p className="py-6 text-center text-sm text-stone-500">No stock takes yet.</p>
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-stone-500">
                  <th className="px-1 pb-2">When</th>
                  <th className="px-1 pb-2">What</th>
                  <th className="px-1 pb-2">Who</th>
                  <th className="px-1 pb-2 text-right">Counted</th>
                  <th className="px-1 pb-2 text-right">Against expected</th>
                  <th className="px-1 pb-2" />
                </tr>
              </thead>
              <tbody>
                {rest.map((c) => (
                  <tr key={c.id} className="border-t border-stone-100 dark:border-stone-800">
                    <td className="px-1 py-2">{fmtMoment(c.finishedAt ?? c.startedAt)}</td>
                    <td className="px-1 py-2">{STOCK_COUNT_SCOPE_LABEL[c.scope]}</td>
                    <td className="px-1 py-2">{c.countedByName ?? '—'}</td>
                    <td className="px-1 py-2 text-right tabular-nums">
                      {c.countedCount} of {c.lineCount}
                    </td>
                    <td
                      className={cn(
                        'px-1 py-2 text-right tabular-nums',
                        (c.shortCents ?? 0) > 0 && 'font-semibold text-red-700 dark:text-red-400',
                        c.status === 'cancelled' && 'text-stone-400',
                      )}
                    >
                      {stockCountDifferenceText(c)}
                    </td>
                    <td className="px-1 py-2 text-right">
                      {c.status === 'done' && (
                        <button type="button" onClick={() => onOpen(c)} className="rounded-lg px-2 py-1 font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40">
                          Open
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {picking && (
        <PickIngredients
          onClose={() => setPicking(false)}
          onStart={(ids) => {
            setPicking(false);
            start.mutate({ scope: 'custom', ingredientIds: ids });
          }}
        />
      )}
    </div>
  );
}

/** Pick the ingredients for a custom stock take. */
function PickIngredients({ onClose, onStart }: { onClose: () => void; onStart: (ids: string[]) => void }) {
  const q = useQuery({ queryKey: ['inventory', 'ingredients', 'all'], queryFn: () => ipc.inventory.listIngredients() });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [find, setFind] = useState('');
  const shown = useMemo(() => {
    const f = find.trim().toLowerCase();
    return (q.data ?? []).filter((i) => i.isActive && (f === '' || i.name.toLowerCase().includes(f)));
  }, [q.data, find]);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">Pick what to count</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Description className="mb-2 text-sm text-stone-500">Tick the ingredients; the sheet lists them by shelf.</Dialog.Description>
          <SearchBox value={find} onChange={setFind} placeholder="Find an ingredient…" />
          <div className="mt-2 flex-1 overflow-y-auto rounded-lg border border-stone-200 p-2 dark:border-stone-800">
            {shown.map((i) => (
              <label key={i.id} className="flex items-center gap-3 rounded px-2 py-2 hover:bg-stone-50 dark:hover:bg-stone-800">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={picked.has(i.id)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const next = new Set(p);
                      if (e.target.checked) next.add(i.id);
                      else next.delete(i.id);
                      return next;
                    })
                  }
                />
                <span className="flex-1">{i.name}</span>
                {i.countWeekly && <span className="text-xs text-stone-500">key item</span>}
              </label>
            ))}
            {shown.length === 0 && <p className="p-2 text-sm text-stone-500">No ingredient matches.</p>}
          </div>
          <footer className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={picked.size === 0} onClick={() => onStart([...picked])}>
              Count {picked.size === 0 ? '' : picked.size} {picked.size === 1 ? 'item' : 'items'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A finished stock take: each line against what the till expected, and what the difference is worth. */
function FinishedCount({ countId, finish, onBack }: { countId: string; finish: StockCountFinish | null; onBack: () => void }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: [...STOCK_COUNTS_KEY, 'one', countId], queryFn: () => ipc.inventory.stockCountGet(countId) });
  const count: StockCountDetail | null | undefined = q.data ?? finish?.count;
  const list = useQuery({ queryKey: [...STOCK_COUNTS_KEY, 'list'], queryFn: () => ipc.inventory.stockCountList({ limit: 200 }) });
  // "Used vs should have used" needs an earlier finished stock take.
  const hasEarlier = (list.data ?? []).some((c) => c.status === 'done' && c.finishedAt !== null && count?.finishedAt && c.finishedAt < count.finishedAt);
  if (!count) {
    return (
      <Card className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </Card>
    );
  }
  const lines = count.lines
    .filter((l) => l.countedQty !== null)
    .sort((a, b) => Math.abs(b.differenceCents ?? 0) - Math.abs(a.differenceCents ?? 0) || a.name.localeCompare(b.name));
  const blank = count.lines.length - lines.length;
  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <button type="button" onClick={onBack} className="text-sm font-semibold text-amber-700 dark:text-amber-300">
          ← All stock takes
        </button>
        <h2 className="text-xl font-bold">
          {STOCK_COUNT_SCOPE_LABEL[count.scope]}, {count.finishedAt ? fmtMoment(count.finishedAt) : ''}
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          {count.countedByName ? `Counted by ${count.countedByName}. ` : ''}
          {lines.length} counted{blank > 0 ? `, ${blank} left out` : ''}. Against what the till expected:{' '}
          <strong className={cn((count.shortCents ?? 0) > 0 && 'text-red-700 dark:text-red-400')}>{stockCountDifferenceText(count)}</strong>.
        </p>
        {finish?.alreadyFinished && <p className="text-sm text-stone-500">It had already been finished: nothing was written again.</p>}
        {finish?.expectedNote && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">{finish.expectedNote}</p>}
        <p className="text-xs text-stone-500">
          Expected is the last stock take plus every till&apos;s sales, deliveries, batches and waste since. Both are as at the finish: what
          was sold, wasted or made after a shelf was counted is taken off (or added to) what was counted there. The till&apos;s count of each
          item is now what was counted.
        </p>
        {hasEarlier && (
          <div>
            <Button variant="secondary" onClick={() => openStockVariance(navigate, { fromCountId: '', toCountId: count.id })}>
              <Scale className="h-4 w-4" /> Used vs should have used
            </Button>
          </div>
        )}
      </Card>
      <Card>
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-stone-500">
                <th className="px-1 pb-2">Ingredient</th>
                <th className="px-1 pb-2 text-right">Counted</th>
                <th className="px-1 pb-2 text-right">Expected</th>
                <th className="px-1 pb-2">Difference</th>
                <th className="px-1 pb-2 text-right">Worth</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.ingredientId} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="px-1 py-2 font-medium">{l.name}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{formatQty(l.countedQty ?? 0, l.unit)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">
                    {l.expectedQty === null ? '—' : formatQty(l.expectedQty, l.unit)}
                    {l.expectedFrom === 'till' && <span className="block text-xs text-stone-500">till count, no stock take yet</span>}
                  </td>
                  <td className={cn('px-1 py-2', (l.differenceQty ?? 0) < 0 && 'text-red-700 dark:text-red-400')}>{countLineDifferenceText(l)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{l.differenceCents === null ? '—' : signedCents(l.differenceCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-stone-200 font-semibold dark:border-stone-700">
                <td className="px-1 py-2" colSpan={4}>
                  Stock counted is worth
                </td>
                <td className="px-1 py-2 text-right tabular-nums">{formatCents(lines.reduce((s, l) => s + (l.valueCents ?? 0), 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}
