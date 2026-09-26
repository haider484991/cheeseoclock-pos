import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BellRing,
  Hourglass,
  MonitorUp,
  PackageMinus,
  Play,
  Printer,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  ALERT_SOUND_EVENTS,
  DEFAULT_ALERT_SOUND_SETTINGS,
  NEW_ORDER_TONES,
  newOrderSoundIsOff,
  type AlertSoundEvent,
  type AlertSoundSettings,
} from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { repeatRuleText } from './alertState';
import { getSoundPlayer } from './audioEngine';
import { NEW_ORDER_TONE_LABELS, soundForEvent, type SoundId } from './tones';
import { ALERT_SOUNDS_QUERY_KEY } from './useAlertSoundSettings';

function sameSettings(a: AlertSoundSettings, b: AlertSoundSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.volume === b.volume &&
    a.newOrderTone === b.newOrderTone &&
    a.repeatUntilSeen === b.repeatUntilSeen &&
    a.waitingIncludesCounter === b.waitingIncludesCounter &&
    ALERT_SOUND_EVENTS.every((e) => a.events[e] === b.events[e])
  );
}

/**
 * Settings → Sounds: what this till rings and beeps for, and how loud.
 * Each till keeps its own (the kitchen till can be louder). Managers and the
 * owner change it; every change is in the audit trail, and every screen
 * says so while the new-order sound is off. Test buttons play at the loudness
 * on the slider, even before saving and even with sounds switched off.
 */
export function SoundSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: ALERT_SOUNDS_QUERY_KEY,
    queryFn: () => ipc.alerts.getSounds(),
    staleTime: Infinity,
  });
  const saved = q.data;
  const [draft, setDraft] = useState<AlertSoundSettings>(DEFAULT_ALERT_SOUND_SETTINGS);
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const saveMut = useMutation({
    mutationFn: (next: AlertSoundSettings) => ipc.alerts.setSounds(next),
    onSuccess: (next) => {
      qc.setQueryData(ALERT_SOUNDS_QUERY_KEY, next);
      toast({ title: 'Sounds saved', variant: 'success' });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const noticeMut = useMutation({
    mutationFn: () => ipc.alerts.testNotice(),
    onSuccess: (r) =>
      toast(
        r.shown
          ? {
              title: 'Windows notice sent',
              description:
                'Look at the bottom-right of the screen. Nothing there? Turn on notifications for CheeseOclock POS in Windows Settings → System → Notifications, and switch off Do not disturb.',
              variant: 'info',
              duration: 15_000,
            }
          : {
              title: 'Windows would not show a notice',
              description:
                'Turn on notifications for CheeseOclock POS in Windows Settings → System → Notifications, and switch off Do not disturb.',
              variant: 'warning',
              duration: 15_000,
            },
      ),
    onError: (e) =>
      toast({ title: 'Test failed', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
  });

  const dirty = saved ? !sameSettings(saved, draft) : false;
  const test = (id: SoundId) => getSoundPlayer().play(id, draft.volume);
  const testEvent = (e: AlertSoundEvent) => test(soundForEvent(e, draft));
  const setEvent = (e: AlertSoundEvent, on: boolean) => setDraft({ ...draft, events: { ...draft.events, [e]: on } });
  const muted = !draft.enabled;

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Volume2 className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Sounds on this till</h2>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        The till rings for new website orders and beeps when something needs a look. Each till has its own
        sounds. Turning a sound off never hides the message on screen.
      </p>

      {q.isError && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          Could not load the saved sounds. The till is using the standard ones (all on, 80%).
        </p>
      )}

      <ul className="divide-y divide-stone-200 dark:divide-stone-700">
        <Rule
          icon={draft.enabled ? Volume2 : VolumeX}
          title="Sounds"
          body="Every sound on this till. Off: the till stays silent, and every screen shows that sounds are off."
          control={<Toggle checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Sounds on this till" />}
        />
        <Rule
          icon={Volume2}
          title="Loudness"
          body={
            draft.volume === 0
              ? 'You will hear nothing.'
              : 'Loud enough to hear over the kitchen. Check the computer’s own volume too.'
          }
          control={
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={draft.volume}
                onChange={(e) => setDraft({ ...draft, volume: Number(e.target.value) })}
                aria-label="Loudness"
                className="h-2 w-40 cursor-pointer accent-amber-500"
              />
              <span className="w-10 text-right text-sm font-semibold tabular-nums">{draft.volume}%</span>
              <TestButton onClick={() => testEvent('newOnlineOrder')} label="Test the loudness" />
            </div>
          }
        />
        <Rule
          icon={BellRing}
          title="New online order"
          body={`A chime and a big green note on every screen — the PIN screen too. The note stays until someone taps Seen, opens Live Orders or starts the order. With "keep ringing" on, the chime repeats ${repeatRuleText()}.`}
          dimmed={muted}
          control={
            <div className="flex flex-col items-start gap-3 md:items-end">
              <Toggle checked={draft.events.newOnlineOrder} onChange={(v) => setEvent('newOnlineOrder', v)} label="Sound for a new online order" />
              <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="New order chime">
                {NEW_ORDER_TONES.map((t) => (
                  <span key={t} className="inline-flex items-center">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draft.newOrderTone === t}
                      onClick={() => {
                        setDraft({ ...draft, newOrderTone: t });
                        test(`newOrder:${t}`);
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-lg border-2 px-3 py-1.5 text-xs font-semibold transition-colors',
                        draft.newOrderTone === t
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                          : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                      )}
                    >
                      <Play className="h-3 w-3" aria-hidden="true" />
                      {NEW_ORDER_TONE_LABELS[t]}
                    </button>
                  </span>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs font-medium text-stone-600 dark:text-stone-300">
                <Toggle
                  checked={draft.repeatUntilSeen}
                  onChange={(v) => setDraft({ ...draft, repeatUntilSeen: v })}
                  label="Keep ringing until someone looks"
                />
                Keep ringing until someone looks (off: one chime per order)
              </label>
            </div>
          }
        />
        <Rule
          icon={AlertTriangle}
          title="Website order did not come in"
          body={`An alarm and a red note when a website order could not be put on the board after several tries. Someone has to call the customer — the note shows the number. The alarm repeats until someone taps Seen (${repeatRuleText()}), whatever "keep ringing" is set to.`}
          dimmed={muted}
          control={
            <EventControl
              checked={draft.events.importFailed}
              onChange={(v) => setEvent('importFailed', v)}
              onTest={() => testEvent('importFailed')}
              label="Sound when a website order did not come in"
            />
          }
        />
        <Rule
          icon={Hourglass}
          title="Order waiting too long"
          body="A soft beep and a note when a website order is still not started 10 minutes after it came in, or not done after 30. Once per order, at most one beep every 5 minutes."
          dimmed={muted}
          control={
            <div className="flex flex-col items-start gap-3 md:items-end">
              <EventControl
                checked={draft.events.waitingTooLong}
                onChange={(v) => setEvent('waitingTooLong', v)}
                onTest={() => testEvent('waitingTooLong')}
                label="Sound when an order waits too long"
              />
              <label className="flex max-w-xs items-center gap-2 text-xs font-medium text-stone-600 dark:text-stone-300">
                <Toggle
                  checked={draft.waitingIncludesCounter}
                  onChange={(v) => setDraft({ ...draft, waitingIncludesCounter: v })}
                  label="Counter orders too"
                />
                Counter orders too — only if staff tap “Start preparing” on Live Orders
              </label>
            </div>
          }
        />
        <Rule
          icon={Printer}
          title="Printer problem"
          body="A short falling beep when a ticket or receipt does not print. At most once every 2 minutes, so a printer that is off does not beep on every sale."
          dimmed={muted}
          control={
            <EventControl
              checked={draft.events.printerProblem}
              onChange={(v) => setEvent('printerProblem', v)}
              onTest={() => testEvent('printerProblem')}
              label="Sound for a printer problem"
            />
          }
        />
        <Rule
          icon={PackageMinus}
          title="Running low"
          body="A short rising beep when an order takes an ingredient below its low-stock level."
          dimmed={muted}
          control={
            <EventControl
              checked={draft.events.lowStock}
              onChange={(v) => setEvent('lowStock', v)}
              onTest={() => testEvent('lowStock')}
              label="Sound when running low"
            />
          }
        />
        <Rule
          icon={MonitorUp}
          title="When the till is behind another window"
          body="A new website order also flashes the till on the taskbar and shows a Windows notice at the bottom-right. Clicking it brings the till back (on Live Orders, when someone is logged in). This always happens, whatever the sounds are set to."
          control={
            <Button variant="secondary" size="sm" disabled={noticeMut.isPending} onClick={() => noticeMut.mutate()}>
              Test the Windows notice
            </Button>
          }
        />
      </ul>

      {newOrderSoundIsOff(draft) && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          The till will not ring for new website orders{draft.enabled && draft.events.newOnlineOrder ? ' loud enough to hear' : ''}.
          Every screen will say so until it is turned back on.
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-stone-200 pt-4 dark:border-stone-700">
        {dirty && (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Your changes are not saved yet</span>
        )}
        <Button variant="primary" disabled={saveMut.isPending || !dirty} onClick={() => saveMut.mutate(draft)}>
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

function Rule(props: { icon: typeof Volume2; title: string; body: string; control: ReactNode; dimmed?: boolean }) {
  const Icon = props.icon;
  return (
    <li className={cn('flex flex-col gap-3 py-4 md:flex-row md:items-start md:justify-between', props.dimmed && 'opacity-60')}>
      <div className="flex min-w-0 gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{props.title}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{props.body}</p>
        </div>
      </div>
      <div className="shrink-0 md:pl-4">{props.control}</div>
    </li>
  );
}

function EventControl(props: { checked: boolean; onChange: (v: boolean) => void; onTest: () => void; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <TestButton onClick={props.onTest} label={`Test: ${props.label}`} />
      <Toggle checked={props.checked} onChange={props.onChange} label={props.label} />
    </div>
  );
}

function TestButton(props: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-stone-600 ring-1 ring-stone-200 transition-colors hover:bg-stone-50 hover:text-stone-900 dark:text-stone-300 dark:ring-stone-700 dark:hover:bg-stone-800"
    >
      <Play className="h-3.5 w-3.5" aria-hidden="true" />
      Test
    </button>
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        props.checked ? 'bg-amber-500' : 'bg-stone-300 dark:bg-stone-600',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
          props.checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
