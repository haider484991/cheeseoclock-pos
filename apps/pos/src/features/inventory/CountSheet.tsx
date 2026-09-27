/**
 * The count sheet (costing spec Phase 8): a stock take filled in shelf by
 * shelf on the touch till, each line in the easiest way to see it — kilos
 * or litres, whole packs plus what is loose, or plain grams / pieces. The
 * sheet shows a blank box per line and nothing else about it. Counts are
 * saved as the cook goes (a shelf at a time), so the till can take orders
 * in between; "Finish" works out the differences in one go.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  INGREDIENT_CATEGORIES,
  bigUnitOf,
  countEntryModes,
  countEntryOf,
  countEntryQty,
  countReadBack,
  formatQty,
  type CountEntry,
  type CountEntryMode,
} from '@cheeseoclock/pos-domain';
import { STOCK_COUNT_SCOPE_LABEL, type StockCountDetail, type StockCountFinish, type StockCountLine } from '@cheeseoclock/shared-types';
import { ArrowLeft, CheckCircle2, Loader2, Save, XCircle } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { fmtMoment } from '../reports/dateRange';

export const STOCK_COUNTS_KEY = ['inventory', 'stockCounts'] as const;

/** The label of a way of typing a count. */
export function modeLabel(mode: CountEntryMode, unit: string): string {
  if (mode === 'big') return bigUnitOf(unit)?.label ?? unit;
  if (mode === 'packs') return 'packs';
  return unit;
}

/** One count box (or packs + loose), with its way of typing. Shared by the sheet and the Stock button's one-line stock take. */
export function CountEntryInput({
  id,
  unit,
  packSize,
  entry,
  onChange,
  autoFocus,
}: {
  id: string;
  unit: string;
  packSize: number | null;
  entry: CountEntry;
  onChange: (e: CountEntry) => void;
  autoFocus?: boolean;
}) {
  const modes = countEntryModes(unit, packSize);
  const box =
    'h-14 w-32 rounded-xl border border-stone-300 px-3 text-right font-mono text-xl tabular-nums dark:border-stone-700 dark:bg-stone-800';
  // What the box was read as, exactly: a slip ("2500" in a kilo box) shows before anything is saved.
  const read = countEntryQty(entry, unit, packSize);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={entry.amount}
        autoFocus={autoFocus}
        onChange={(e) => onChange({ ...entry, amount: e.target.value })}
        className={box}
        aria-label={`Count in ${modeLabel(entry.mode, unit)}`}
      />
      {/* The unit the box is in, beside it: kilos, litres, or the ingredient's own unit. */}
      {entry.mode !== 'packs' && <span className="text-base font-semibold text-stone-600 dark:text-stone-300">{modeLabel(entry.mode, unit)}</span>}
      {entry.mode === 'packs' && (
        <>
          <span className="text-sm text-stone-500">packs of {formatQty(packSize ?? 0, unit)} +</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={entry.loose ?? ''}
            onChange={(e) => onChange({ ...entry, loose: e.target.value })}
            className={box}
            aria-label={`Loose ${unit}`}
          />
          <span className="text-sm text-stone-500">{unit} loose</span>
        </>
      )}
      {modes.length > 1 && (
        <div className="flex gap-1" role="group" aria-label="Count in">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={entry.mode === m}
              onClick={() => {
                // Switching keeps what was typed when it reads the same in the new way.
                const read = countEntryQty(entry, unit, packSize);
                onChange(read.ok ? countEntryOf(read.qty, m, unit, packSize) : { mode: m, amount: '', loose: '' });
              }}
              className={cn(
                'h-11 min-w-[3.5rem] rounded-lg border-2 px-2 text-sm font-semibold',
                entry.mode === m ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-stone-200 dark:border-stone-700',
              )}
            >
              {modeLabel(m, unit)}
            </button>
          ))}
        </div>
      )}
      {read.ok && read.qty !== null && (
        <span className="w-full text-sm tabular-nums text-stone-500" data-testid="count-read-back">
          {countReadBack(read.qty, unit)}
        </span>
      )}
    </div>
  );
}

/** How a line is typed when the sheet opens: kilos / litres for weighed things, else its own unit. */
export function defaultMode(unit: string, packSize: number | null): CountEntryMode {
  return countEntryModes(unit, packSize)[0] ?? 'base';
}

function shelfOrder(shelf: string): number {
  const i = INGREDIENT_CATEGORIES.findIndex((c) => c.id === shelf);
  return i < 0 ? INGREDIENT_CATEGORIES.length : i;
}

/** A shelf of the sheet: its lines, as the cook counts them. */
export interface SheetShelf {
  shelf: string;
  label: string;
  lines: ReadonlyArray<Pick<StockCountLine, 'ingredientId' | 'unit' | 'packSize'>>;
}

/**
 * Where the sheet stands, from what is typed and what the till has saved:
 *  - `changed`: every line that reads right and differs from what is saved —
 *    what the next save sends, WHATEVER other boxes say (one box that can't
 *    be read never holds back the rest; it is simply not sent);
 *  - `problems` / `problemShelves`: the boxes that can't be read, and the
 *    shelves they are on (marked in the shelf bar, named when not saved);
 *  - `countedNow`: lines with a figure.
 */
export function countSheetState(
  shelves: readonly SheetShelf[],
  entries: Readonly<Record<string, CountEntry>>,
  saved: ReadonlyMap<string, number | null>,
): {
  changed: Array<{ ingredientId: string; countedQty: number | null }>;
  problems: string[];
  problemShelves: Array<{ shelf: string; label: string; n: number }>;
  countedNow: number;
} {
  const changed: Array<{ ingredientId: string; countedQty: number | null }> = [];
  const problems: string[] = [];
  const problemShelves: Array<{ shelf: string; label: string; n: number }> = [];
  let countedNow = 0;
  for (const s of shelves) {
    let n = 0;
    for (const l of s.lines) {
      const r = countEntryQty(entries[l.ingredientId] ?? { mode: 'base', amount: '' }, l.unit, l.packSize);
      if (!r.ok) {
        n += 1;
        problems.push(l.ingredientId);
        continue;
      }
      if (r.qty !== null) countedNow += 1;
      if (r.qty !== (saved.get(l.ingredientId) ?? null)) changed.push({ ingredientId: l.ingredientId, countedQty: r.qty });
    }
    if (n > 0) problemShelves.push({ shelf: s.shelf, label: s.label, n });
  }
  return { changed, problems, problemShelves, countedNow };
}

/** The sheet of an open stock take. `onDone` gets the finish's answer (or null when it was cancelled). */
export function CountSheet({ countId, onClose, onDone }: { countId: string; onClose: () => void; onDone: (r: StockCountFinish | null) => void }) {
  const q = useQuery({ queryKey: [...STOCK_COUNTS_KEY, 'one', countId], queryFn: () => ipc.inventory.stockCountGet(countId) });
  if (!q.data) {
    return (
      <Card className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
        {q.isError ? 'The stock take could not be loaded.' : <><Loader2 className="h-4 w-4 animate-spin" /> Loading the sheet…</>}
      </Card>
    );
  }
  return <SheetBody count={q.data} onClose={onClose} onDone={onDone} />;
}

function SheetBody({ count, onClose, onDone }: { count: StockCountDetail; onClose: () => void; onDone: (r: StockCountFinish | null) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const shelves = useMemo(() => {
    const by = new Map<string, StockCountLine[]>();
    for (const l of count.lines) {
      let list = by.get(l.shelf);
      if (!list) by.set(l.shelf, (list = []));
      list.push(l);
    }
    return [...by.entries()].sort((a, b) => shelfOrder(a[0]) - shelfOrder(b[0])).map(([shelf, lines]) => ({
      shelf,
      label: INGREDIENT_CATEGORIES.find((c) => c.id === shelf)?.label ?? 'Other',
      lines: [...lines].sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [count.lines]);
  const [shelf, setShelf] = useState(shelves[0]?.shelf ?? 'other');
  const [entries, setEntries] = useState<Record<string, CountEntry>>(() =>
    Object.fromEntries(count.lines.map((l) => [l.ingredientId, countEntryOf(l.countedQty, defaultMode(l.unit, l.packSize), l.unit, l.packSize)])),
  );
  /** What the till has saved, per line (base units; null = blank). */
  const saved = useRef(new Map(count.lines.map((l) => [l.ingredientId, l.countedQty])));

  const byId = useMemo(() => new Map(count.lines.map((l) => [l.ingredientId, l])), [count.lines]);
  const read = (id: string) => {
    const l = byId.get(id)!;
    return countEntryQty(entries[id] ?? { mode: 'base', amount: '' }, l.unit, l.packSize);
  };
  const { problems, problemShelves, changed, countedNow } = countSheetState(shelves, entries, saved.current);
  const problemText = problemShelves.map((s) => `${s.label} (${s.n})`).join(', ');

  const save = useMutation({
    mutationFn: async () => {
      if (changed.length === 0) return null;
      const lines = changed;
      const out = await ipc.inventory.stockCountSave({ countId: count.id, lines });
      for (const line of lines) saved.current.set(line.ingredientId, line.countedQty);
      return out;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: STOCK_COUNTS_KEY }),
    onError: (e) => toast({ title: 'Could not save the counts', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
  });
  /** Set while it is being finished or cancelled, and after: nothing more is saved into it. */
  const closed = useRef(false);
  // Saved as the cook moves on (a new shelf, leaving the sheet): every box that reads right. A failure is its
  // toast; what was typed stays on screen.
  const saveNow = (): Promise<unknown> => (!closed.current && changed.length > 0 ? save.mutateAsync().catch(() => null) : Promise.resolve(null));
  /** The boxes that can't be read were not saved: say which shelves, so they are not lost without a word. */
  const warnUnsaved = (shelvesToName: typeof problemShelves) => {
    if (closed.current || shelvesToName.length === 0) return;
    const n = shelvesToName.reduce((s, x) => s + x.n, 0);
    toast({
      title: n === 1 ? '1 count was not saved' : `${n} counts were not saved`,
      description: `${n === 1 ? 'A box' : 'Boxes'} on ${shelvesToName.map((s) => `${s.label} (${s.n})`).join(', ')} can't be read. Fix ${n === 1 ? 'it' : 'them'} (marked in red); the rest is saved.`,
      variant: 'error',
    });
  };
  /** Leaving the sheet (once: the button, or the sidebar): save what reads right, and say what could not be saved. */
  const left = useRef(false);
  const leave = (): Promise<unknown> => {
    if (left.current) return Promise.resolve(null);
    left.current = true;
    warnUnsaved(problemShelves);
    return saveNow();
  };
  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  });
  // Leaving the sheet any other way (the sidebar) saves what was typed too.
  useEffect(() => () => void leaveRef.current(), []);

  const finish = useMutation({
    mutationFn: async () => {
      // What is on screen first: if it can't be saved, the stock take is not finished without it.
      if (changed.length > 0) await save.mutateAsync();
      closed.current = true;
      return ipc.inventory.stockCountFinish(count.id);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: STOCK_COUNTS_KEY });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onDone(r);
    },
    onError: (e) => {
      closed.current = false;
      toast({ title: 'Could not finish the stock take', description: e instanceof Error ? e.message : String(e), variant: 'error' });
    },
  });
  const cancel = useMutation({
    mutationFn: () => {
      closed.current = true;
      return ipc.inventory.stockCountCancel(count.id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STOCK_COUNTS_KEY });
      toast({ title: 'Stock take cancelled', description: 'Nothing was changed.', variant: 'success' });
      onDone(null);
    },
    onError: (e) => {
      closed.current = false;
      toast({ title: 'Could not cancel', description: e instanceof Error ? e.message : String(e), variant: 'error' });
    },
  });

  const blanks = count.lines.length - countedNow;
  const askFinish = async () => {
    if (problems.length > 0) return;
    const blankText =
      blanks === 0
        ? 'Every line is counted.'
        : `${blanks} of ${count.lines.length} ${blanks === 1 ? 'line is' : 'lines are'} blank: ${blanks === 1 ? 'it is' : 'they are'} left out.` +
          (count.scope === 'full' ? ' With lines left out, this counts as a part stock take, not a full one.' : '');
    const ok = await askConfirm(
      `Finish this stock take? ${blankText} The till's count of each counted item is set to what you counted (anything sold, wasted or made since you counted its shelf is taken into account).`,
    );
    if (ok) finish.mutate();
  };
  const askCancel = async () => {
    const ok = await askConfirm('Cancel this stock take? What was typed is dropped. Nothing in stock changes.');
    if (ok) cancel.mutate();
  };

  const current = shelves.find((s) => s.shelf === shelf) ?? shelves[0];
  const busy = save.isPending || finish.isPending || cancel.isPending;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            type="button"
            onClick={() => void leave().finally(onClose)}
            className="mb-1 inline-flex items-center gap-1 text-sm font-semibold text-amber-700 dark:text-amber-300"
          >
            <ArrowLeft className="h-4 w-4" /> All stock takes
          </button>
          <h2 className="text-xl font-bold">{STOCK_COUNT_SCOPE_LABEL[count.scope]}</h2>
          <p className="text-sm text-stone-500">
            Started {fmtMoment(count.startedAt)}
            {count.countedByName ? ` by ${count.countedByName}` : ''} · {countedNow} of {count.lines.length} counted
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => void askCancel()}>
            <XCircle className="h-4 w-4" /> Cancel stock take
          </Button>
          <Button variant="secondary" disabled={busy || changed.length === 0} onClick={() => void saveNow()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
          </Button>
          <Button variant="primary" disabled={busy || countedNow === 0 || problems.length > 0} onClick={() => void askFinish()}>
            {finish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Finish
          </Button>
        </div>
        {problems.length > 0 && (
          <p role="alert" className="w-full text-sm font-medium text-red-700 dark:text-red-400">
            {problems.length === 1 ? 'A box' : `${problems.length} boxes`} can&apos;t be read ({problemText}): fix {problems.length === 1 ? 'it' : 'them'} to
            finish. The other counts still save.
          </p>
        )}
      </Card>

      <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Shelves">
        {shelves.map((s) => {
          const done = s.lines.filter((l) => {
            const r = read(l.ingredientId);
            return r.ok && r.qty !== null;
          }).length;
          const bad = problemShelves.find((p) => p.shelf === s.shelf)?.n ?? 0;
          return (
            <button
              key={s.shelf}
              type="button"
              aria-pressed={s.shelf === current?.shelf}
              onClick={() => {
                if (s.shelf === current?.shelf) return;
                void saveNow();
                // Moving on from a shelf with a box that can't be read: it was not saved — said, and marked.
                warnUnsaved(problemShelves.filter((p) => p.shelf === current?.shelf));
                setShelf(s.shelf);
              }}
              className={cn(
                'h-12 whitespace-nowrap rounded-xl px-4 text-sm font-semibold',
                s.shelf === current?.shelf ? 'bg-amber-500 text-stone-900' : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
                bad > 0 && 'ring-2 ring-red-500',
              )}
            >
              {s.label} <span className="tabular-nums opacity-70">{done}/{s.lines.length}</span>
              {bad > 0 && (
                <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white" aria-label={`${bad} to fix`}>
                  {bad} to fix
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {current && (
        <Card className="divide-y divide-stone-100 dark:divide-stone-800">
          {current.lines.map((l, i) => {
            const r = read(l.ingredientId);
            return (
              <div key={l.ingredientId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <label htmlFor={`count-${l.ingredientId}`} className="min-w-[10rem] flex-1 text-base font-semibold">
                  {l.name}
                  {!r.ok && <span className="block text-sm font-normal text-red-700 dark:text-red-400">{r.message}</span>}
                </label>
                <CountEntryInput
                  id={`count-${l.ingredientId}`}
                  unit={l.unit}
                  packSize={l.packSize}
                  entry={entries[l.ingredientId] ?? { mode: defaultMode(l.unit, l.packSize), amount: '' }}
                  onChange={(e) => setEntries((all) => ({ ...all, [l.ingredientId]: e }))}
                  autoFocus={i === 0}
                />
              </div>
            );
          })}
        </Card>
      )}
      <p className="text-xs text-stone-500">
        A blank box is not counted (it is not a zero): type 0 for none on the shelf. Under each box is what it was read as. Counts are saved when you
        change shelf.
      </p>
    </div>
  );
}
