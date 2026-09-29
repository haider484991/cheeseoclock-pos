/**
 * Settings → Kitchen & stock, below "What a menu file may change": the menu
 * files from the costing PC (v0.7.32; the owner, 29 Sep 2026: "this import
 * file is irritating me it should be automatic deploy for any machinse").
 *
 *  - "Menu updates from the costing file" ('menu.autoUpdate', both tills):
 *    put in by themselves (the default), or wait for the owner's OK in
 *    Menu → Import.
 *  - "Menu file from the costing PC": the upload key's status, "Make a new
 *    upload key" (the owner: the key is shown ONCE, kept only in this
 *    dialog's state and gone when it closes — never stored on the till),
 *    where this till stands, "Check now" and the last lines of the history.
 *
 * Each loads on its own, so the cards above never wait for them.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { Copy, KeyRound, RefreshCw, Send, X } from 'lucide-react';
import type { MenuAutoUpdate, MenuDeployKeyMade, ShopSettingCard } from '@cheeseoclock/shared-types';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { useSessionStore } from '../../stores/sessionStore';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useShopSetting } from './shop-rules/useShopSetting';
import {
  KEY_DIALOG_STAYS_OPEN,
  KEY_ONCE_WORDS,
  KEY_SAFETY_WORDS,
  MENU_AUTO_UPDATE_OPTIONS,
  NEW_KEY_QUESTION,
  dayTime,
  keyStatusText,
  menuAutoUpdateSummary,
  phaseTone,
} from './shop-rules/menuDeployWords';
import { MENU_DEPLOY_KEY, useMenuDeployView } from '../menu-mgmt/useMenuDeploy';

const TONE_CLASS = {
  good: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100',
  warn: 'bg-amber-50 text-amber-950 dark:bg-amber-950/60 dark:text-amber-100',
  bad: 'bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-100',
  plain: 'bg-stone-50 text-stone-800 dark:bg-stone-800/60 dark:text-stone-100',
} as const;

const LINE_TONE = {
  ok: 'text-stone-700 dark:text-stone-200',
  warn: 'text-amber-800 dark:text-amber-300',
  error: 'text-red-700 dark:text-red-400',
} as const;

export function MenuFromCostingPc() {
  return (
    <>
      <MenuAutoUpdateCard />
      <MenuFileCard />
    </>
  );
}

/** 'menu.autoUpdate': put in by themselves, or wait for the owner's OK. */
function MenuAutoUpdateCard() {
  const s = useShopSetting('menu.autoUpdate');
  if (s.q.isError) return <p className="text-sm text-stone-500">Could not load “Menu updates from the costing file”.</p>;
  if (!s.q.data) return <p className="text-sm text-stone-500">Loading…</p>;
  return <MenuAutoUpdateFields s={s} />;
}

function MenuAutoUpdateFields({ s }: { s: ReturnType<typeof useShopSetting<'menu.autoUpdate'>> }) {
  const card = s.q.data as ShopSettingCard<'menu.autoUpdate'>;
  const d = useDraft<MenuAutoUpdate, MenuAutoUpdate>(card.value, (v) => ({ ...v }));
  const dirty = d.touched && d.form.mode !== card.value.mode;
  return (
    <SettingCard
      card={card}
      title="Menu updates from the costing file"
      icon={<Send className="h-5 w-5" />}
      intro="What happens when the costing PC sends a new menu file. Either way it is the safe update of Menu → Import — never Start fresh — with the rules above, and a backup copy is made first."
      describe={menuAutoUpdateSummary}
      dirty={dirty}
      problem={null}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => s.save.mutate(d.form, { onSuccess: d.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: d.reset })}
    >
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Menu updates from the costing file">
        {MENU_AUTO_UPDATE_OPTIONS.map((o) => (
          <button
            key={o.mode}
            type="button"
            role="radio"
            aria-checked={d.form.mode === o.mode}
            onClick={() => d.set({ ...d.form, mode: o.mode })}
            className={cn(
              'rounded-lg border-2 p-3 text-left text-sm transition-colors',
              d.form.mode === o.mode ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40' : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
            )}
          >
            <span className="block font-semibold">{o.label}</span>
            <span className="text-xs text-stone-600 dark:text-stone-400">{o.help}</span>
          </button>
        ))}
      </div>
    </SettingCard>
  );
}

/** The upload key, where this till stands, "Check now" and the history. */
function MenuFileCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isOwner = useSessionStore((st) => st.user?.role === 'admin');
  const q = useMenuDeployView({ withHistory: true });
  const [made, setMade] = useState<MenuDeployKeyMade | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: MENU_DEPLOY_KEY });
  const check = useMutation({
    mutationFn: () => ipc.menuDeploy.checkNow(),
    onSuccess: () => refresh(),
    onError: (e) => toast({ title: 'Could not look now', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });
  // The key lives only in this component's state (never a cache, never storage).
  const makeKey = useMutation({
    mutationFn: () => ipc.menuDeploy.createKey(),
    gcTime: 0,
    onSuccess: (k) => {
      setMade(k);
      refresh();
    },
    onError: (e) => toast({ title: 'No new key', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const view = q.data;
  const tone = view ? phaseTone(view.phase) : 'plain';
  return (
    <Card>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <KeyRound className="h-5 w-5" /> Menu file from the costing PC
      </h2>
      <p className="mt-0.5 text-sm text-stone-500">
        The costing PC sends each new menu file to the website with its upload key (py -3 deploy_menu.py). The file never goes on the
        public website; one till puts it in and the other gets it through the link.
      </p>

      {q.isError && <p className="mt-3 text-sm text-stone-500">Could not read where this till stands.</p>}
      {!view && !q.isError && <p className="mt-3 text-sm text-stone-500">Loading…</p>}
      {view && (
        <div className="mt-3 space-y-3">
          <p className="text-sm font-medium">{keyStatusText(view.key, view.websiteLinked)}</p>
          <p className={cn('rounded-lg p-3 text-sm', TONE_CLASS[tone])} aria-live="polite">
            {view.message}
          </p>
          {view.appliedHere && (
            <p className="text-xs text-stone-500">
              Last file in: #{view.appliedHere.seq} {view.appliedHere.fileName}, {dayTime(view.appliedHere.at)} —{' '}
              {view.appliedHere.byThisTill ? 'put in on this till' : 'put in on the other till'}
              {view.appliedHere.automatic ? ' by itself' : ''}.
            </p>
          )}
          {view.lastError && view.lastError !== view.message && <p className="text-xs text-amber-800 dark:text-amber-300">{view.lastError}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 pt-3 dark:border-stone-700">
            <Button variant="secondary" onClick={() => check.mutate()} disabled={check.isPending || !view.websiteLinked}>
              <RefreshCw className={cn('mr-1 h-4 w-4', check.isPending && 'animate-spin')} /> {check.isPending ? 'Looking…' : 'Check now'}
            </Button>
            {isOwner && (
              <Button
                variant="secondary"
                disabled={makeKey.isPending || !view.websiteLinked}
                onClick={() => {
                  void askConfirm(NEW_KEY_QUESTION, { yesLabel: 'Make a new key', noLabel: 'Go back', safeDefault: true }).then((yes) => {
                    if (yes) makeKey.mutate();
                  });
                }}
              >
                <KeyRound className="mr-1 h-4 w-4" /> {makeKey.isPending ? 'Making…' : 'Make a new upload key'}
              </Button>
            )}
            {view.lastCheckedAt && <span className="text-xs text-stone-500">Last looked {dayTime(view.lastCheckedAt)}</span>}
          </div>
          <p className="text-xs text-stone-500">{KEY_SAFETY_WORDS}</p>
          {view.history && view.history.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-stone-600 dark:text-stone-300">History (the last {view.history.length})</summary>
              <ol className="mt-2 space-y-1 rounded-lg bg-stone-50 p-3 text-xs dark:bg-stone-800/60">
                {view.history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="flex flex-wrap gap-x-2">
                    <span className="font-mono text-stone-500">{dayTime(h.at)}</span>
                    <span className={LINE_TONE[h.tone]}>
                      {h.text}
                      {h.fileMadeAt ? ` — made ${dayTime(h.fileMadeAt)}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
      {made && (
        <KeyOnceDialog
          made={made}
          onClose={() => {
            setMade(null);
            makeKey.reset();
          }}
        />
      )}
    </Card>
  );
}

/**
 * The new key, shown once, with Copy. Closing forgets it — so it closes only with its own buttons,
 * never with a tap beside it or Esc (the website already holds the new key; the old one stopped).
 */
function KeyOnceDialog({ made, onClose }: { made: MenuDeployKeyMade; onClose: () => void }) {
  const { toast } = useToast();
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          {...KEY_DIALOG_STAYS_OPEN}
          className="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900"
        >
          <header className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">New upload key</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-stone-600 dark:text-stone-300">{KEY_ONCE_WORDS}</Dialog.Description>
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </header>
          <input
            readOnly
            aria-label="The new upload key"
            value={made.key}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
          />
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(made.key)
                  .then(() => toast({ title: 'Copied', description: 'Paste it on the costing PC now.', variant: 'success' }))
                  .catch(() => toast({ title: 'Could not copy', description: 'Select the key and copy it by hand.', variant: 'warning' }));
              }}
            >
              <Copy className="mr-1 h-4 w-4" /> Copy
            </Button>
            <Button onClick={onClose}>Done — it is on the costing PC</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
