import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { CostingTargetsView, SetCostingTargetsRequest } from '@cheeseoclock/shared-types';
import { CheckCircle2, Lock } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { COSTING_KEY, useCostingTargets } from './costingQueries';
import { formatBps, parsePercent, parseRupees } from './costingFormat';

/**
 * Food-cost targets per menu category. Until the owner confirms them they
 * are the till's suggestions (Pizza 30%, Burgers 35%, …) and the chips stay
 * uncoloured. Managers see them; only the owner (settings.manage) changes
 * them — the main process refuses anyone else.
 */
export function TargetsTab() {
  const q = useCostingTargets();
  const canEdit = useSessionStore((s) => s.can('settings.manage'));
  if (!q.data) {
    return <Card className="py-8 text-center text-stone-500">{q.isError ? 'Could not load the targets.' : 'Loading…'}</Card>;
  }
  // A fresh form whenever the saved targets change (saved here, or on the other till).
  return <TargetsForm key={q.data.savedAt ?? 'suggested'} view={q.data} canEdit={canEdit} />;
}

/** 3000 → "30", 3250 → "32.5". */
const pctText = (bps: number) => String(bps / 100);

function TargetsForm({ view, canEdit }: { view: CostingTargetsView; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pct, setPct] = useState<Record<string, string>>(() => Object.fromEntries(view.categories.map((c) => [c.categoryId, pctText(c.bps)])));
  const [nonFood, setNonFood] = useState<Record<string, boolean>>(() => Object.fromEntries(view.categories.map((c) => [c.categoryId, c.nonFood])));
  const [amber, setAmber] = useState(pctText(view.amberBps));
  const [step, setStep] = useState(String(view.priceStepCents / 100));

  const dirty =
    view.categories.some((c) => pct[c.categoryId] !== pctText(c.bps) || nonFood[c.categoryId] !== c.nonFood) ||
    amber !== pctText(view.amberBps) ||
    step !== String(view.priceStepCents / 100);

  const bad = new Set(
    view.categories
      .filter((c) => !nonFood[c.categoryId])
      .filter((c) => {
        const b = parsePercent(pct[c.categoryId] ?? '');
        return b === null || b <= 0;
      })
      .map((c) => c.categoryId),
  );
  const amberBps = parsePercent(amber);
  const amberBad = amberBps === null || amberBps > 5000;
  const stepCents = parseRupees(step);
  const stepBad = stepCents === null || stepCents < 100 || stepCents > 100_000;
  const problem =
    bad.size > 0
      ? 'Every food category needs a target above 0%.'
      : amberBad
        ? '"Close" is 0 to 50 points over the target.'
        : stepBad
          ? 'The price step is Rs 1 to Rs 1,000.'
          : null;

  const mut = useMutation({
    mutationFn: (req: SetCostingTargetsRequest) => ipc.costing.setTargets(req),
    onSuccess: () => {
      toast({ title: 'Targets saved', description: 'Menu costs now colour each dish against them.', variant: 'success' });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
    },
    onError: (e) => toast({ title: 'Could not save the targets', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const save = () => {
    if (problem || amberBps === null || stepCents === null) return;
    const perCategory: SetCostingTargetsRequest['perCategory'] = {};
    for (const c of view.categories) {
      // A non-food category keeps a target (unused) so it has one if it turns back into food.
      const b = parsePercent(pct[c.categoryId] ?? '');
      perCategory[c.categoryId] = { bps: b !== null && b > 0 ? b : c.bps, confirmed: true };
    }
    mut.mutate({
      defaultBps: view.defaultBps,
      amberBps,
      perCategory,
      nonFoodCategoryIds: view.categories.filter((c) => nonFood[c.categoryId]).map((c) => c.categoryId),
      priceStepCents: stepCents,
    });
  };

  const inputCls =
    'w-20 rounded-lg border border-stone-300 px-2 py-1.5 text-right font-mono disabled:bg-stone-100 disabled:text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:disabled:bg-stone-900';

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="font-semibold">Food-cost targets</h2>
          <p className="mt-0.5 text-sm text-stone-500">
            How much of a dish&apos;s price its ingredients may cost, per menu category. A dish at or under its target is
            green, up to the &quot;close&quot; width over it amber, further over red.
          </p>
          {view.anyUnconfirmed ? (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              These are the till&apos;s suggestions. Until they are confirmed, Menu costs shows each food cost % without a colour.
            </p>
          ) : (
            <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Confirmed{view.savedAt ? ` on ${new Date(view.savedAt).toLocaleDateString('en-PK')}` : ''}.
            </p>
          )}
        </div>
        {!canEdit && (
          <p className="inline-flex items-center gap-1.5 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600 dark:bg-stone-800 dark:text-stone-300">
            <Lock className="h-4 w-4" /> Only the owner can change the targets.
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              <th className="pb-2">Menu category</th>
              <th className="pb-2 text-right">Items</th>
              <th className="pb-2 text-right">Target</th>
              <th className="pb-2 pl-4">Suggested</th>
              <th className="pb-2">Not food</th>
            </tr>
          </thead>
          <tbody>
            {view.categories.map((c) => {
              const nf = !!nonFood[c.categoryId];
              return (
                <tr key={c.categoryId} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="py-2 font-medium">
                    {c.name}
                    {!c.confirmed && !c.nonFood && <span className="ml-2 text-xs font-normal text-stone-500">suggested</span>}
                  </td>
                  <td className="py-2 text-right text-stone-500">{c.itemCount}</td>
                  <td className="py-2 text-right">
                    <label className="inline-flex items-center gap-1">
                      <span className="sr-only">Target for {c.name}, per cent</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={nf ? '' : (pct[c.categoryId] ?? '')}
                        placeholder={nf ? '—' : undefined}
                        disabled={!canEdit || nf}
                        onChange={(e) => setPct((p) => ({ ...p, [c.categoryId]: e.target.value }))}
                        className={cn(inputCls, bad.has(c.categoryId) && 'border-red-500')}
                      />
                      %
                    </label>
                  </td>
                  <td className="py-2 pl-4 text-stone-500">{nf ? '—' : formatBps(c.suggestedBps)}</td>
                  <td className="py-2">
                    <label className="inline-flex items-center gap-1.5 text-stone-600 dark:text-stone-300">
                      <input
                        type="checkbox"
                        checked={nf}
                        disabled={!canEdit}
                        onChange={(e) => setNonFood((m) => ({ ...m, [c.categoryId]: e.target.checked }))}
                      />
                      <span className="text-xs">{nf ? 'left out of food cost' : ''}</span>
                      <span className="sr-only">{c.name} is not food</span>
                    </label>
                  </td>
                </tr>
              );
            })}
            {view.categories.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-stone-500">
                  No menu categories yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-wrap items-center gap-2 text-sm">
          &quot;Close&quot; is up to
          <input type="text" inputMode="decimal" value={amber} disabled={!canEdit} onChange={(e) => setAmber(e.target.value)} className={cn(inputCls, amberBad && 'border-red-500')} />
          points over the target
        </label>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          Suggest prices in steps of Rs
          <input type="text" inputMode="decimal" value={step} disabled={!canEdit} onChange={(e) => setStep(e.target.value)} className={cn(inputCls, stepBad && 'border-red-500')} />
          {stepCents !== null && !stepBad && <span className="text-stone-500">({formatCents(stepCents)})</span>}
        </label>
      </div>

      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4 dark:border-stone-800">
          {problem && <span className="mr-auto text-sm text-red-700 dark:text-red-400">{problem}</span>}
          {!problem && <span className="mr-auto text-xs text-stone-500">Saving confirms every target shown, on both tills.</span>}
          {view.anyUnconfirmed && !dirty ? (
            <Button variant="primary" disabled={mut.isPending || problem !== null} onClick={save}>
              {mut.isPending ? 'Saving…' : 'Use these'}
            </Button>
          ) : (
            <Button variant="primary" disabled={mut.isPending || problem !== null || !dirty} onClick={save}>
              {mut.isPending ? 'Saving…' : 'Save targets'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
