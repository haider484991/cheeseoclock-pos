import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@cheeseoclock/ui';
import {
  Store,
  Printer,
  Globe,
  Database,
  Building2,
  Settings2,
  Info,
  CheckCircle2,
  AlertTriangle,
  MinusCircle,
} from 'lucide-react';
import { ipc } from '../../ipc/client';
import { PrinterSettings } from './PrinterSettings';
import { BrandingSettings } from './BrandingSettings';
import { FbrSettings } from './FbrSettings';
import { SyncSettings } from './SyncSettings';
import { BackupSettings, UsbRestoreSettings } from './BackupSettings';
import { CloudBackupSettings } from './CloudBackupSettings';
import { WebsiteSettings } from './WebsiteSettings';
import { AboutCard } from './AboutCard';

export type SettingsTab =
  | 'store'
  | 'printer'
  | 'online'
  | 'backups'
  | 'fbr'
  | 'advanced'
  | 'about';

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: typeof Store;
}

const TABS: TabDef[] = [
  { id: 'store', label: 'Store', icon: Store },
  { id: 'printer', label: 'Printer', icon: Printer },
  { id: 'online', label: 'Online orders', icon: Globe },
  { id: 'backups', label: 'Backups', icon: Database },
  { id: 'fbr', label: 'FBR invoicing', icon: Building2 },
  { id: 'advanced', label: 'Advanced', icon: Settings2 },
  { id: 'about', label: 'About', icon: Info },
];

const TAB_KEY = 'settings.tab';

function readSavedTab(): SettingsTab {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    if (v && TABS.some((t) => t.id === v)) return v as SettingsTab;
  } catch {
    // storage unavailable: start on the first tab
  }
  return 'store';
}

/**
 * Settings is organised by what the shop needs, one tab each. Everything that
 * belongs to one topic lives on one tab: the three backup layers (local, cloud,
 * USB) are together even though the cloud copy travels over the website
 * connection, and the second-till sync, a form that looks like the website one
 * but is unrelated, sits under Advanced so it cannot be mistaken for it.
 */
export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>(readSavedTab);

  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_KEY, tab);
    } catch {
      // storage unavailable: the tab just is not remembered
    }
  }, [tab]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          Set up the shop in order: Store, Printer, then Online orders. Backups
          run on their own once the website is connected.
        </p>
      </header>

      <SettingsOverview onSelect={setTab} />

      <nav
        role="tablist"
        aria-label="Settings sections"
        className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-stone-200 dark:border-stone-700"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-tab={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'border-amber-500 text-stone-900 dark:text-stone-50'
                  : 'border-transparent text-stone-500 hover:text-stone-800 dark:hover:text-stone-200',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </nav>

      <div role="tabpanel" className="space-y-6">
        {tab === 'store' && <BrandingSettings />}
        {tab === 'printer' && <PrinterSettings />}
        {tab === 'online' && <WebsiteSettings />}
        {tab === 'backups' && (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Three copies protect the shop&rsquo;s data: a daily snapshot on this
              PC, a daily compressed copy in the cloud, and the USB copy you export
              yourself. If this PC dies, restore from the cloud or the USB copy.
            </p>
            <BackupSettings />
            <CloudBackupSettings onGoToOnline={() => setTab('online')} />
            <UsbRestoreSettings />
          </>
        )}
        {tab === 'fbr' && <FbrSettings />}
        {tab === 'advanced' && <SyncSettings />}
        {tab === 'about' && <AboutCard />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type Tone = 'good' | 'warn' | 'off';

interface Tile {
  label: string;
  tone: Tone;
}

const LOADING: Tile = { label: 'Loading…', tone: 'off' };

/**
 * One glance answers "what is set up?": the four things that decide whether
 * the shop can trade today, each a button that jumps to its tab.
 */
function SettingsOverview({ onSelect }: { onSelect: (tab: SettingsTab) => void }) {
  const printerQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
  });
  const bridgeCfgQ = useQuery({
    queryKey: ['webBridge', 'config'],
    queryFn: () => ipc.webBridge.getConfig(),
  });
  const bridgeStatusQ = useQuery({
    queryKey: ['webBridge', 'status'],
    queryFn: () => ipc.webBridge.getStatus(),
    refetchInterval: 15_000,
  });
  const fbrQ = useQuery({
    queryKey: ['fbr', 'config'],
    queryFn: () => ipc.fbr.getConfig(),
  });

  const printer = printerQ.data?.config;
  let printerTile: Tile = LOADING;
  if (printer) {
    if (printer.transport === 'network' && printer.network?.host === 'mock') {
      printerTile = { label: 'No printer, saving to file', tone: 'warn' };
    } else if (printer.transport === 'network' && printer.network) {
      printerTile = { label: `Wi-Fi / LAN · ${printer.network.host}`, tone: 'good' };
    } else {
      printerTile = { label: printer.transport, tone: 'warn' };
    }
  }

  const st = bridgeStatusQ.data;
  let onlineTile: Tile = LOADING;
  if (st) {
    if (!st.enabled) onlineTile = { label: 'Off', tone: 'off' };
    else if (!st.ready) onlineTile = { label: 'Needs website URL and secret', tone: 'warn' };
    else if (st.lastError) onlineTile = { label: 'On, last check failed', tone: 'warn' };
    else onlineTile = { label: 'Connected', tone: 'good' };
  }

  const freq = bridgeCfgQ.data?.cloudBackupFrequency;
  let cloudTile: Tile = LOADING;
  if (st && freq) {
    if (freq === 'off') cloudTile = { label: 'Off', tone: 'off' };
    else if (!st.ready) cloudTile = { label: 'Set up Online orders first', tone: 'warn' };
    else if (st.lastCloudBackupError) cloudTile = { label: 'Last upload failed', tone: 'warn' };
    else if (st.lastCloudBackupAt)
      cloudTile = {
        label: `Last copy ${new Date(st.lastCloudBackupAt).toLocaleDateString()}`,
        tone: 'good',
      };
    else cloudTile = { label: 'Waiting for first upload', tone: 'warn' };
  }

  let fbrTile: Tile = LOADING;
  if (fbrQ.data) {
    if (fbrQ.data.mode === 'noop') fbrTile = { label: 'Off', tone: 'off' };
    else if (fbrQ.data.mode === 'sandbox') fbrTile = { label: 'Test mode', tone: 'warn' };
    else fbrTile = { label: 'Live', tone: 'good' };
  }

  const tiles: Array<{ title: string; tile: Tile; tab: SettingsTab }> = [
    { title: 'Printer', tile: printerTile, tab: 'printer' },
    { title: 'Online orders', tile: onlineTile, tab: 'online' },
    { title: 'Cloud backup', tile: cloudTile, tab: 'backups' },
    { title: 'FBR invoicing', tile: fbrTile, tab: 'fbr' },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Setup status">
      {tiles.map(({ title, tile, tab }) => {
        const Icon =
          tile.tone === 'good' ? CheckCircle2 : tile.tone === 'warn' ? AlertTriangle : MinusCircle;
        return (
          <button
            key={title}
            type="button"
            onClick={() => onSelect(tab)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors',
              'border-stone-200 bg-white hover:border-amber-300 dark:border-stone-700 dark:bg-stone-900 dark:hover:border-amber-600',
            )}
          >
            <span className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
              {title}
            </span>
            <span
              className={cn(
                'inline-flex max-w-full items-center gap-1.5 text-sm font-semibold',
                tile.tone === 'good' && 'text-emerald-700 dark:text-emerald-300',
                tile.tone === 'warn' && 'text-amber-700 dark:text-amber-300',
                tile.tone === 'off' && 'text-stone-500',
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{tile.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
