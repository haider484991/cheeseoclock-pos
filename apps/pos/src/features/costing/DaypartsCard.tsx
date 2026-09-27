import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { DEFAULT_DAYPARTS, daypartHours, type Daypart, type DaypartsView } from '@cheeseoclock/shared-types';
import { Clock, Lock, Plus, Trash2 } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { daypartHoursText } from '../reports/ownerWeekFormat';
import { hourLabel } from '../reports/reportFormat';

/**
 * Costing → Targets: the parts of the day Reports → When splits the sales
 * into (costing spec 4.10, Phase 7): Lunch, Afternoon, Dinner and Late by
 * default. Everyone who sees Reports reads them; only the owner changes them
 * (settings.manage — the main process refuses anyone else). Saved for both
 * tills.
 */
export function DaypartsCard({ canEdit }: { canEdit: boolean }) {
  const q = useQuery({ queryKey: ['reports', 'dayparts'], queryFn: () => ipc.reports.getDayparts(), staleTime: 0 });
  if (!q.data) {
    return <Card className="py-6 text-center text-stone-500">{q.isError ? 'Could not load the parts of the day.' : 'Loading…'}</Card>;
  }
  return <DaypartsForm key={q.data.savedAt ?? 'usual'} view={q.data} canEdit={canEdit} />;
}

/** Why these parts will not do, in plain words, or null (the same rules as the till's). */
export function daypartsProblem(parts: readonly Daypart[]): string | null {
  if (parts.length === 0) return 'Keep at least one part of the day.';
  if (parts.length > 6) return 'At most six parts of the day.';
  const names = new Set<string>();
  const taken = new Map<number, string>();
  for (const p of parts) {
    const name = p.name.trim();
    if (!name) return 'Give each part of the day a name.';
    if (name.length > 24) return 'Keep a name to 24 letters.';
    if (names.has(name.toLowerCase())) return `Two parts of the day are called "${name}".`;
    names.add(name.toLowerCase());
    for (const h of daypartHours(p)) {
      const other = taken.get(h);
      if (other !== undefined) return `"${other}" and "${name}" both take ${hourLabel(h)}.`;
      taken.set(h, name);
    }
  }
  return null;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function DaypartsForm({ view, canEdit }: { view: DaypartsView; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [parts, setParts] = useState<Daypart[]>(() => view.dayparts.map((d) => ({ ...d })));
  const problem = daypartsProblem(parts);
  const dirty = JSON.stringify(parts) !== JSON.stringify(view.dayparts);
  const mut = useMutation({
    mutationFn: (dayparts: Daypart[]) => ipc.reports.setDayparts({ dayparts }),
    onSuccess: () => {
      toast({ title: 'Parts of the day saved', description: 'Reports use them on both tills.', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => toast({ title: 'Could not save the parts of the day', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });
  const set = (i: number, patch: Partial<Daypart>) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const selectCls =
    'h-9 rounded-lg border border-stone-300 bg-white px-2 text-sm disabled:bg-stone-100 disabled:text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:disabled:bg-stone-900';

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 font-semibold">
            <Clock className="h-4 w-4" /> Parts of the day
          </h2>
          <p className="mt-0.5 text-sm text-stone-500">
            How Reports → When splits the sales. Pakistan time; a part can run past midnight (Late: 11 pm to 4:59 am, the same
            night). Hours in no part show as &quot;Other hours&quot;.
            {view.isDefault ? ' These are the till’s usual parts.' : ''}
          </p>
        </div>
        {!canEdit && (
          <p className="inline-flex items-center gap-1.5 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600 dark:bg-stone-800 dark:text-stone-300">
            <Lock className="h-4 w-4" /> Only the owner can change the parts of the day.
          </p>
        )}
      </div>

      <ul className="space-y-2">
        {parts.map((p, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="text"
              value={p.name}
              maxLength={24}
              disabled={!canEdit}
              onChange={(e) => set(i, { name: e.target.value })}
              aria-label="Name of the part of the day"
              className={cn(selectCls, 'w-36')}
            />
            from
            <select value={p.fromHour} disabled={!canEdit} onChange={(e) => set(i, { fromHour: Number(e.target.value) })} aria-label="From" className={selectCls}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
            to the end of
            <select value={p.toHour} disabled={!canEdit} onChange={(e) => set(i, { toHour: Number(e.target.value) })} aria-label="To" className={selectCls}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
            <span className="text-xs text-stone-500">({daypartHoursText(p.fromHour, p.toHour)})</span>
            {canEdit && parts.length > 1 && (
              <button
                type="button"
                onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
                className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-red-600 dark:hover:bg-stone-800"
                aria-label={`Take off ${p.name || 'this part'}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4 dark:border-stone-800">
          {problem ? (
            <span className="mr-auto text-sm text-red-700 dark:text-red-400">{problem}</span>
          ) : (
            <span className="mr-auto text-xs text-stone-500">Saved for both tills.</span>
          )}
          {parts.length < 6 && (
            <Button variant="ghost" onClick={() => setParts((ps) => [...ps, { name: '', fromHour: 5, toHour: 11 }])}>
              <Plus className="h-4 w-4" /> Add a part
            </Button>
          )}
          <Button variant="secondary" onClick={() => setParts(DEFAULT_DAYPARTS.map((d) => ({ ...d })))}>
            Use the usual parts
          </Button>
          <Button variant="primary" disabled={mut.isPending || problem !== null || !dirty} onClick={() => mut.mutate(parts.map((p) => ({ ...p, name: p.name.trim() })))}>
            {mut.isPending ? 'Saving…' : 'Save parts of the day'}
          </Button>
        </div>
      )}
    </Card>
  );
}
