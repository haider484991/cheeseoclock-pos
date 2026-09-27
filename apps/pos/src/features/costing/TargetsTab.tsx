import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { CostAlertSettingsView, CostingTargetsView, SetCostAlertSettingsRequest, SetCostingTargetsRequest } from '@cheeseoclock/shared-types';
import { BellRing, CheckCircle2, Lock } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { COSTING_KEY, useCostAlertSettings, useCostingTargets } from './costingQueries';
import { formatBps, parsePercent, parseRupees } from './costingFormat';
import { DaypartsCard } from './DaypartsCard';
import { TillsCard } from './TillsCard';

/**
 * Food-cost targets per menu category, and the price alerts' thresholds
 * (costing spec Phase 6). Until the owner confirms the targets they are the
 * till's suggestions (Pizza 30%, Burgers 35%, …) and the chips stay
 * uncoloured. Managers see them; only the owner (settings.manage) changes
 * them — the main process refuses anyone else.
 */
export function TargetsTab() {
  const q = useCostingTargets();
  const canEdit = useSessionStore((s) => s.can('settings.manage'));
  // The parts of the day belong to Reports, which managers don't see.
  const canSeeReports = useSessionStore((s) => s.can('report.view'));
  return (
    <div className="space-y-3">
      {q.data ? (
        // A fresh form whenever the saved targets change (saved here, or on the other till).
        <TargetsForm key={q.data.savedAt ?? 'suggested'} view={q.data} canEdit={canEdit} />
      ) : (
        <Card className="py-8 text-center text-stone-500">{q.isError ? 'Could not load the targets.' : 'Loading…'}</Card>
      )}
      <AlertSettings canEdit={canEdit} />
      {/* The parts of the day Reports → When uses (costing spec Phase 7). */}
      {canSeeReports && <DaypartsCard canEdit={canEdit} />}
      {/* How many tills take orders (costing spec Phase 8). */}
      <TillsCard canEdit={canEdit} />
    </div>
  );
}

/**
 * The price alerts' thresholds (costing spec Phase 6) and the key items — ONE
 * list, kept on the ingredients (Phase 8): what the weekly stock take
 * counts, what the price alerts watch, what the Dashboard pins when low.
 */
function AlertSettings({ canEdit }: { canEdit: boolean }) {
  const q = useCostAlertSettings();
  if (!q.data) {
    return <Card className="py-6 text-center text-stone-500">{q.isError ? 'Could not load the price alerts.' : 'Loading…'}</Card>;
  }
  return <AlertSettingsForm key={q.data.savedAt ?? 'suggested'} view={q.data} canEdit={canEdit} />;
}

function AlertSettingsForm({ view, canEdit }: { view: CostAlertSettingsView; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [jump, setJump] = useState(pctText(view.jumpBps));
  const [impact, setImpact] = useState(String(view.impactWeekCents / 100));
  const [keys, setKeys] = useState<Set<string>>(() => new Set(view.ingredients.filter((i) => i.key).map((i) => i.ingredientId)));
  const [find, setFind] = useState('');

  const jumpBps = parsePercent(jump);
  const jumpBad = jumpBps === null || jumpBps < 100;
  const impactCents = parseRupees(impact);
  const impactBad = impactCents === null || impactCents > 100_000_000;
  const problem = jumpBad ? 'A price jump is 1% to 100%.' : impactBad ? 'The weekly amount is Rs 0 to Rs 1,000,000.' : null;
  const savedKeys = view.ingredients.filter((i) => i.key).map((i) => i.ingredientId);
  const dirty =
    jump !== pctText(view.jumpBps) ||
    impact !== String(view.impactWeekCents / 100) ||
    keys.size !== savedKeys.length ||
    savedKeys.some((id) => !keys.has(id));

  // Key ones first, then by name; the box narrows the list.
  const shown = useMemo(() => {
    const f = find.trim().toLowerCase();
    return [...view.ingredients]
      .filter((i) => f === '' || i.name.toLowerCase().includes(f))
      .sort((a, b) => Number(keys.has(b.ingredientId)) - Number(keys.has(a.ingredientId)) || a.name.localeCompare(b.name));
    // Re-sorted on typing only, so a box ticked a moment ago does not jump away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, view.ingredients]);

  const mut = useMutation({
    mutationFn: (req: SetCostAlertSettingsRequest) => ipc.costing.setAlertSettings(req),
    onSuccess: () => {
      toast({ title: 'Price alerts saved', description: 'On both tills, from the next price change.', variant: 'success' });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      // The key items live on the ingredients: Inventory's lists show them too.
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) => toast({ title: 'Could not save the price alerts', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const save = () => {
    if (problem || jumpBps === null || impactCents === null) return;
    mut.mutate({ jumpBps, impactWeekCents: impactCents, keyIngredientIds: [...keys] });
  };

  const inputCls =
    'w-24 rounded-lg border border-stone-300 px-2 py-1.5 text-right font-mono disabled:bg-stone-100 disabled:text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:disabled:bg-stone-900';

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 font-semibold">
            <BellRing className="h-4 w-4" /> Price alerts
          </h2>
          <p className="mt-0.5 text-sm text-stone-500">
            When to tell you about a price change on Costing → Alerts. Every Monday you also get the dishes that price changes
            moved over (or back under) their target.
          </p>
          {view.keysSuggested && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              Nothing is saved yet: the thresholds are the till&apos;s, and the key items were picked by their names.
            </p>
          )}
        </div>
        {!canEdit && (
          <p className="inline-flex items-center gap-1.5 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600 dark:bg-stone-800 dark:text-stone-300">
            <Lock className="h-4 w-4" /> Only the owner can change the price alerts.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-wrap items-center gap-2 text-sm">
          A key ingredient&apos;s price moves more than
          <input type="text" inputMode="decimal" value={jump} disabled={!canEdit} onChange={(e) => setJump(e.target.value)} className={cn(inputCls, jumpBad && 'border-red-500')} />
          %
          <span className="w-full text-xs text-stone-500">
            A bill this far from the usual price also asks before it becomes the price.
          </span>
        </label>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          Any price change costs the menu more than Rs
          <input type="text" inputMode="decimal" value={impact} disabled={!canEdit} onChange={(e) => setImpact(e.target.value)} className={cn(inputCls, impactBad && 'border-red-500')} />
          a week
          {impactCents !== null && !impactBad && <span className="text-stone-500">({formatCents(impactCents)}, at this till&apos;s sales)</span>}
        </label>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Key items <span className="font-normal text-stone-500">({keys.size})</span>
            <span className="block text-xs font-normal text-stone-500">
              Counted every week (Inventory → Stock takes), watched for price jumps, pinned on the Dashboard when low.
            </span>
          </h3>
          <input
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Find an ingredient…"
            aria-label="Find an ingredient"
            className="h-9 rounded-lg border border-stone-300 bg-white px-2 text-sm dark:border-stone-700 dark:bg-stone-800"
          />
        </div>
        <div className="grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-stone-200 p-2 sm:grid-cols-2 lg:grid-cols-3 dark:border-stone-800">
          {shown.map((i) => (
            <label key={i.ingredientId} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-stone-50 dark:hover:bg-stone-800">
              <input
                type="checkbox"
                checked={keys.has(i.ingredientId)}
                disabled={!canEdit}
                onChange={(e) =>
                  setKeys((k) => {
                    const next = new Set(k);
                    if (e.target.checked) next.add(i.ingredientId);
                    else next.delete(i.ingredientId);
                    return next;
                  })
                }
              />
              <span className="truncate">{i.name}</span>
              {i.suggested && <span className="text-[11px] text-stone-500">suggested</span>}
            </label>
          ))}
          {shown.length === 0 && <p className="px-1.5 py-1 text-sm text-stone-500">No ingredient matches.</p>}
        </div>
      </div>

      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4 dark:border-stone-800">
          {problem && <span className="mr-auto text-sm text-red-700 dark:text-red-400">{problem}</span>}
          {!problem && <span className="mr-auto text-xs text-stone-500">Saved for both tills.</span>}
          <Button variant="primary" disabled={mut.isPending || problem !== null || (!dirty && !view.keysSuggested)} onClick={save}>
            {mut.isPending ? 'Saving…' : view.keysSuggested && !dirty ? 'Use these' : 'Save price alerts'}
          </Button>
        </div>
      )}
    </Card>
  );
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
