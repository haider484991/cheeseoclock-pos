/**
 * Settings → Online orders → This computer ('pc.power', this till only: it
 * is about the computer the till runs on). Keep the computer awake while
 * this till takes website orders, and start the till with Windows; both on
 * by default (the owner, 2026-10-01). Under the choices: what the till is
 * doing now (power:getStatus), with "Turn it back on" when Windows has the
 * start-up entry switched off or missing. The owner alone (the main process
 * refuses anyone else).
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, MinusCircle, Power } from 'lucide-react';
import { Button, cn } from '@cheeseoclock/ui';
import type { PcPowerSetting, TillSettingCard } from '@cheeseoclock/shared-types';
import { ipc, IpcError, onAlertWatchChanged } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useTillSetting } from './shop-rules/useTillSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  KEEP_AWAKE_HELP,
  KEEP_AWAKE_LABEL,
  PC_POWER_LID_TIP,
  PC_POWER_NEVER_CHANGED,
  pcPowerStatusLines,
  pcPowerSummary,
} from './shop-rules/tillSettingsForm';

/** The card's live status (power:getStatus). */
export const POWER_STATUS_KEY = ['power', 'status'] as const;

export function ThisComputerCard() {
  const s = useTillSetting('pc.power');
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load “This computer”.</p>;
  if (!s.q.data) return null;
  return <PowerForm s={s} card={s.q.data} />;
}

function PowerForm({ s, card }: { s: ReturnType<typeof useTillSetting<'pc.power'>>; card: TillSettingCard<'pc.power'> }) {
  const d = useDraft<PcPowerSetting, PcPowerSetting>(card.value, (v) => ({ ...v }));
  const dirty = d.touched && !sameValue(d.form, card.value);
  const choices = (
    field: keyof PcPowerSetting,
    heading: string,
    help: string | null,
    options: Array<{ on: boolean; label: string; hint: string }>,
  ) => (
    <div>
      <h3 className="text-sm font-semibold">{heading}</h3>
      {help && <p className="mb-2 text-xs text-stone-500">{help}</p>}
      <div role="radiogroup" aria-label={heading} className={cn('grid grid-cols-1 gap-2 md:grid-cols-2', !help && 'mt-2')}>
        {options.map((o) => (
          <button
            key={String(o.on)}
            type="button"
            role="radio"
            aria-checked={d.form[field] === o.on}
            onClick={() => d.set({ ...d.form, [field]: o.on })}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-lg border-2 p-3 text-left transition-colors disabled:opacity-60',
              d.form[field] === o.on ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
            )}
          >
            <span className="text-sm font-semibold">{o.label}</span>
            <span className="text-xs text-stone-500">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <SettingCard
      card={card}
      scope="till"
      title="This computer"
      icon={<Power className="h-5 w-5" />}
      intro="A till that is asleep or closed takes no website orders: the website closes by itself within 3 minutes."
      describe={pcPowerSummary}
      neverChangedText={PC_POWER_NEVER_CHANGED}
      dirty={dirty}
      problem={null}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => s.save.mutate({ ...d.form }, { onSuccess: d.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: d.reset })}
      footer={<PowerStatus />}
    >
      {choices('keepAwake', KEEP_AWAKE_LABEL, KEEP_AWAKE_HELP, [
        {
          on: true,
          label: 'Yes — while it takes website orders',
          hint: 'Orders keep coming in, printing and ringing. With no shift open, Windows’ own power settings apply.',
        },
        {
          on: false,
          label: 'No — Windows decides',
          hint: 'Windows’ own power settings apply. A sleeping computer takes no website orders until someone wakes it.',
        },
      ])}
      {choices('startWithWindows', 'Start the till with Windows', null, [
        { on: true, label: 'Yes — by itself', hint: 'The till opens each time this computer starts, once someone is signed in to Windows.' },
        { on: false, label: 'No — someone opens it', hint: 'Someone opens CheeseOclock POS from the desktop each time the computer is switched on.' },
      ])}
    </SettingCard>
  );
}

/** What the till is doing with this computer now, and "Turn it back on". */
function PowerStatus() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const statusQ = useQuery({ queryKey: POWER_STATUS_KEY, queryFn: () => ipc.power.getStatus(), refetchInterval: 30_000 });
  // A shift opened or closed, or the website switch saved: "Awake now" follows at once.
  useEffect(() => onAlertWatchChanged(() => void qc.invalidateQueries({ queryKey: ['power'] })), [qc]);
  const backOn = useMutation({
    mutationFn: () => ipc.power.turnBackOn(),
    onSuccess: (st) => {
      qc.setQueryData(POWER_STATUS_KEY, st);
      toast({ title: 'Turned back on', description: 'On this till.', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Not turned on', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });
  const lines = statusQ.data ? pcPowerStatusLines(statusQ.data) : [];
  return (
    <div className="mt-4 space-y-2" aria-live="polite">
      {lines.map((l) => (
        <div
          key={l.text}
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs',
            l.tone === 'good' && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
            l.tone === 'warn' && 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
            l.tone === 'off' && 'bg-stone-50 text-stone-600 dark:bg-stone-900 dark:text-stone-300',
          )}
        >
          {l.tone === 'good' ? (
            <CheckCircle2 className="h-3 w-3 shrink-0" />
          ) : l.tone === 'warn' ? (
            <AlertTriangle className="h-3 w-3 shrink-0" />
          ) : (
            <MinusCircle className="h-3 w-3 shrink-0" />
          )}
          <span className="flex-1">{l.text}</span>
          {l.action === 'turnBackOn' && (
            <Button variant="secondary" size="sm" onClick={() => backOn.mutate()} disabled={backOn.isPending}>
              {backOn.isPending ? 'Turning it on…' : 'Turn it back on'}
            </Button>
          )}
        </div>
      ))}
      <p className="text-xs text-stone-500">{PC_POWER_LID_TIP}</p>
    </div>
  );
}
