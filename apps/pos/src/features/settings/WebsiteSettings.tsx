import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { Globe, Send, RefreshCw, CheckCircle2, AlertTriangle, XCircle, PauseCircle, UploadCloud } from 'lucide-react';
import type { ShopSettingCard } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useShopSetting } from './shop-rules/useShopSetting';
import { onlineOptionsSummary, settingsPublishWords } from './shop-rules/deliveryZonesForm';

/** The bridge status, with the till's shift pause (webOrdersBridge.status()). */
type BridgeStatusView = Awaited<ReturnType<typeof ipc.webBridge.getStatus>>;

/**
 * Settings → Online orders. Connects this POS to the website:
 *  - site URL + bridge secret (must match BRIDGE_SECRET on the website host)
 *  - enable/disable polling for online orders
 *  - "Publish menu" pushes the current menu to the site
 *  - live status: last poll, imported count, errors, and whether the
 *    website has the owner's delivery areas and pick-up offer (the settings
 *    block: sent alone after a Save, and with every menu publish)
 *  - "Publish the menu to the website by itself" ('online.options', off by
 *    default: the owner has not asked for it)
 * Cloud backups reuse this connection but are managed under Backups.
 */
export function WebsiteSettings() {
  return (
    <div className="space-y-6">
      <ConnectionCard />
      <AutoPublishCard />
    </div>
  );
}

function ConnectionCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [siteUrl, setSiteUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const cfgQ = useQuery({
    queryKey: ['webBridge', 'config'],
    queryFn: () => ipc.webBridge.getConfig(),
  });
  const statusQ = useQuery({
    queryKey: ['webBridge', 'status'],
    queryFn: () => ipc.webBridge.getStatus(),
    refetchInterval: 15_000,
  });

  // Hydrate the form once when config loads.
  useEffect(() => {
    if (cfgQ.data && !hydrated) {
      setSiteUrl(cfgQ.data.siteUrl ?? '');
      setSecret(cfgQ.data.bridgeSecret ?? '');
      setEnabled(cfgQ.data.enabled);
      setHydrated(true);
    }
  }, [cfgQ.data, hydrated]);

  const saveMut = useMutation({
    // The cloud backup schedule is not part of this form; the main process
    // keeps the stored value when it is omitted.
    mutationFn: () =>
      ipc.webBridge.setConfig({
        enabled,
        siteUrl: siteUrl.trim() || undefined,
        bridgeSecret: secret.trim() || undefined,
      }),
    onSuccess: () => {
      toast({ title: 'Online ordering settings saved' });
      void qc.invalidateQueries({ queryKey: ['webBridge'] });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const publishMut = useMutation({
    mutationFn: () => ipc.webBridge.publishMenu(),
    onSuccess: (r) =>
      toast({
        title: 'Menu published 🎉',
        description: `${r.items} items in ${r.categories} categories are now live on the website.`,
      }),
    onError: (e) =>
      toast({
        title: 'Publish failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const status: BridgeStatusView | undefined = statusQ.data;
  // Paused by the till because no shift is open. Only worth saying while the
  // owner's switch is on — with it off, "Off" already says it all.
  const shiftPause = status?.enabled ? status.shiftPause ?? null : null;
  // "ready" only means a URL and secret are filled in — not that the website
  // accepts them. A 401 means the secret here does not match BRIDGE_SECRET on
  // the site, so the badge must never claim "Connected" while calls are failing.
  const online = !!status?.enabled && !!status.ready;
  const lastError = status?.lastError ?? null;
  const authRejected = !!lastError && /\b401\b|unauthor/i.test(lastError);
  const settingsLine = settingsPublishWords(status?.settingsPublish);

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Globe className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Online orders</h2>
        {online &&
          (lastError ? (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-800">
              <XCircle className="h-3 w-3" />
              {authRejected ? 'Password not accepted' : 'Not connecting'}
            </span>
          ) : (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800">
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </span>
          ))}
      </div>

      <p className="mb-4 text-sm text-stone-500">
        Orders placed on your website land on the Live Orders board and print a
        kitchen ticket, and customers can follow their delivery live. Publish
        the menu whenever you change items or prices (or let it go by itself,
        below). Delivery areas and the pick-up offer reach the website by
        themselves when they are saved — only the areas and their delivery
        charge items, never menu changes you have not published. The same
        connection carries the online backup copies.
      </p>

      {cfgQ.data?.secretUnreadable && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          The connection password was saved on another computer and cannot be read here. Enter
          it again and save.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
            Website URL
          </span>
          <input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://www.cheeseoclock.net"
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
          />
          <span className="mt-1 block text-xs text-stone-500">
            The address customers use, starting with https://www.
          </span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
            Connection password
          </span>
          <input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Given to you when the website was set up"
            type="password"
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
          />
          <span className="mt-1 block text-xs text-stone-500">
            Lets this till talk to your website (it is the website&rsquo;s BRIDGE_SECRET).
            Only the last 4 characters show once saved.
          </span>
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-stone-300 text-amber-500 focus:ring-amber-400"
        />
        <span className="font-medium text-stone-700 dark:text-stone-200">
          Accept online orders
        </span>
        <span className="text-xs text-stone-500">(checks for new orders every few seconds)</span>
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => publishMut.mutate()}
          disabled={publishMut.isPending}
        >
          <Send className="h-3.5 w-3.5" />
          {publishMut.isPending ? 'Publishing…' : 'Publish menu to website'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void ipc.webBridge.pollNow().then(() => statusQ.refetch())}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Check for orders now
        </Button>
      </div>

      {status && (
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1 border-t border-stone-200 pt-3 text-xs dark:border-stone-700 sm:grid-cols-4">
          <div>
            <dt className="text-stone-500">Online orders</dt>
            <dd className="font-semibold">
              {status.enabled
                ? status.ready
                  ? shiftPause
                    ? 'Paused'
                    : 'On'
                  : 'Needs setup'
                : 'Off'}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Last check</dt>
            <dd className="font-mono">
              {status.lastPollAt ? new Date(status.lastPollAt).toLocaleTimeString() : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Orders received</dt>
            <dd className="font-mono">{status.importedTotal}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Problems</dt>
            <dd className={status.lastError ? 'text-red-600' : ''}>
              {status.lastError ? (
                <span className="inline-flex items-center gap-1" title={status.lastError}>
                  <AlertTriangle className="h-3 w-3" />
                  {status.consecutiveFails} fail{status.consecutiveFails === 1 ? '' : 's'}
                </span>
              ) : (
                'None'
              )}
            </dd>
          </div>
        </dl>
      )}

      {shiftPause && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <PauseCircle className="mr-1 inline h-3 w-3" />
          {shiftPause.message}
        </p>
      )}

      {status?.lastError && (
        <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
          <p>
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            Last check failed: {status.lastError}
          </p>
          {authRejected && (
            <p className="mt-1.5 border-t border-red-200 pt-1.5 dark:border-red-900">
              The website did not accept this connection password: type it again above and
              press Save. For whoever set up the website: it must be the{' '}
              <span className="font-semibold">exact same value</span> as{' '}
              <code className="font-mono">BRIDGE_SECRET</code> in your website host (Vercel →
              Project → Settings → Environment Variables), and the site must be redeployed after
              you set or change it. Re-enter it above and Save if unsure.
            </p>
          )}
        </div>
      )}

      {status?.lastImportError && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          An order couldn&rsquo;t be imported: {status.lastImportError}
        </p>
      )}

      {settingsLine && (
        <p
          className={cn(
            'mt-2 rounded-lg px-3 py-2 text-xs',
            settingsLine.tone === 'ok' && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
            settingsLine.tone === 'wait' && 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
            settingsLine.tone === 'bad' && 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200',
          )}
        >
          {settingsLine.tone === 'ok' ? <CheckCircle2 className="mr-1 inline h-3 w-3" /> : <AlertTriangle className="mr-1 inline h-3 w-3" />}
          {settingsLine.text}
        </p>
      )}
    </Card>
  );
}

/** "Publish the menu to the website by itself" ('online.options'): off by default — today's manual publish. */
function AutoPublishCard() {
  const s = useShopSetting('online.options');
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load “Publish the menu by itself”.</p>;
  if (!s.q.data) return null;
  return <AutoPublishFields s={s} />;
}

function AutoPublishFields({ s }: { s: ReturnType<typeof useShopSetting<'online.options'>> }) {
  const card = s.q.data as ShopSettingCard<'online.options'>;
  const draft = useDraft(card.value, (v) => v.autoPublishMenu);
  const value = useMemo(() => ({ v: card.value.v, autoPublishMenu: draft.form }), [card.value.v, draft.form]);
  const dirty = draft.touched && draft.form !== card.value.autoPublishMenu;
  const options = [
    { on: false, label: 'No — when I publish', hint: 'The menu goes to the website after a menu file import or “Publish menu”, as before.' },
    { on: true, label: 'Yes — by itself', hint: 'A few seconds after any change to the menu on this till (items, prices, choices, categories).' },
  ];
  return (
    <SettingCard
      card={card}
      title="Publish the menu to the website by itself"
      icon={<UploadCloud className="h-5 w-5" />}
      intro="A price changed on the till but not on the website is billed at a price the customer never saw. With Yes, the website follows the till’s menu by itself."
      describe={onlineOptionsSummary}
      dirty={dirty}
      problem={null}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => s.save.mutate(value, { onSuccess: draft.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: draft.reset })}
    >
      <div role="radiogroup" aria-label="Publish the menu by itself" className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {options.map((o) => (
          <button
            key={String(o.on)}
            type="button"
            role="radio"
            aria-checked={draft.form === o.on}
            onClick={() => draft.set(o.on)}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-lg border-2 p-3 text-left transition-colors disabled:opacity-60',
              draft.form === o.on ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
            )}
          >
            <span className="text-sm font-semibold">{o.label}</span>
            <span className="text-xs text-stone-500">{o.hint}</span>
          </button>
        ))}
      </div>
    </SettingCard>
  );
}
