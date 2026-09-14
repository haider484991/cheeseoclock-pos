import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import type { PrinterConnectionConfig, PrinterTransport } from '@cheeseoclock/shared-types';
import { Printer, Wifi, Usb, Bluetooth, FlaskConical, Check, RefreshCw } from 'lucide-react';

interface TransportOption {
  id: PrinterTransport | 'mock';
  label: string;
  icon: typeof Wifi;
  available: boolean;
  disabledReason?: string;
}

const TRANSPORTS: TransportOption[] = [
  { id: 'usb', label: 'USB', icon: Usb, available: true },
  { id: 'network', label: 'Wi-Fi / LAN', icon: Wifi, available: true },
  { id: 'mock', label: 'No printer', icon: FlaskConical, available: true },
  {
    id: 'bluetooth',
    label: 'Bluetooth',
    icon: Bluetooth,
    available: false,
    disabledReason: 'Not yet',
  },
];

function inferUiTransport(config: PrinterConnectionConfig): TransportOption['id'] {
  if (config.transport === 'network' && config.network?.host === 'mock') return 'mock';
  return config.transport;
}

const inputClass =
  'w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800';

export function PrinterSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
  });

  // Editable form state — initialized from server.
  const [uiTransport, setUiTransport] = useState<TransportOption['id']>('mock');
  const [host, setHost] = useState('192.168.1.100');
  const [port, setPort] = useState('9100');
  const [printerName, setPrinterName] = useState('');
  const [width, setWidth] = useState<32 | 48>(48);

  useEffect(() => {
    if (!cfgQ.data) return;
    const cfg = cfgQ.data.config;
    setUiTransport(inferUiTransport(cfg));
    setHost(cfg.network?.host && cfg.network.host !== 'mock' ? cfg.network.host : '192.168.1.100');
    setPort(String(cfg.network?.port ?? 9100));
    setPrinterName(cfg.usb?.printerName ?? '');
    setWidth(cfg.width ?? 48);
  }, [cfgQ.data]);

  // Printers Windows knows about — only asked for while the USB option is open.
  const printersQ = useQuery({
    queryKey: ['printer', 'system'],
    queryFn: () => ipc.printer.listSystemPrinters(),
    enabled: uiTransport === 'usb',
    staleTime: 10_000,
  });
  const systemPrinters = useMemo(() => printersQ.data?.printers ?? [], [printersQ.data]);
  const usbSupported = printersQ.data?.supported ?? true;

  // First time in: pre-pick the queue that looks like a receipt printer so the
  // usual case is "plug in → Save → Test print" with no dropdown at all. Once
  // only — clearing the box afterwards must stay cleared.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || uiTransport !== 'usb' || systemPrinters.length === 0) return;
    autoPicked.current = true;
    if (printerName) return;
    const guess = systemPrinters.find((p) => p.likelyReceiptPrinter);
    if (guess) setPrinterName(guess.name);
  }, [uiTransport, printerName, systemPrinters]);

  const saveMut = useMutation({
    mutationFn: (config: PrinterConnectionConfig) => ipc.printer.setConfig({ config }),
    onSuccess: () => {
      toast({ title: 'Printer saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['printer', 'config'] });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const testMut = useMutation({
    mutationFn: () => ipc.printer.test(),
    onSuccess: (result) => {
      if (result.ok) {
        toast({
          title: 'Test print sent',
          description: `Took ${result.durationMs}ms`,
          variant: 'success',
        });
      } else {
        toast({
          title: 'Test print failed',
          description: result.error?.message ?? 'Unknown error',
          variant: 'error',
        });
      }
    },
    onError: (e) =>
      toast({
        title: 'Test failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  function buildConfig(): PrinterConnectionConfig | null {
    if (uiTransport === 'mock') {
      return { transport: 'network', network: { host: 'mock', port: 9100 }, width };
    }
    if (uiTransport === 'network') {
      const p = parseInt(port, 10);
      return {
        transport: 'network',
        network: {
          host,
          port: Number.isFinite(p) && p > 0 ? p : 9100,
          timeoutMs: 5000,
        },
        width,
      };
    }
    if (uiTransport === 'usb') {
      const name = printerName.trim();
      if (!name) {
        toast({
          title: 'Pick the printer first',
          description: 'Choose the printer from the list, then save.',
          variant: 'error',
        });
        return null;
      }
      return { transport: 'usb', usb: { printerName: name }, width };
    }
    // Bluetooth is disabled at the option level — we shouldn't reach here.
    return { transport: 'network', network: { host: 'mock', port: 9100 }, width };
  }

  function save() {
    const config = buildConfig();
    if (config) saveMut.mutate(config);
  }

  function testPrint() {
    // Runs against the saved config, so the toast reflects what the till will do.
    testMut.mutate();
  }

  const savedName = cfgQ.data?.config.usb?.printerName;
  const selectedIsKnown = !printerName || systemPrinters.some((p) => p.name === printerName);

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Printer className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Printer</h2>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        Receipts and the cash drawer go through this printer — and kitchen tickets too, unless you
        set up a separate kitchen printer below. A USB printer works as soon as Windows shows it
        under Printers &amp; scanners; most Wi-Fi and LAN thermal printers work with the Wi-Fi / LAN
        option on port 9100. Bluetooth printers are not supported yet.
      </p>

      <section className="space-y-4">
        <div>
          <label className="mb-2 block text-xs uppercase tracking-wider text-stone-500">
            Connection type
          </label>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {TRANSPORTS.map((t) => {
              const Icon = t.icon;
              const selected = uiTransport === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={!t.available}
                  onClick={() => setUiTransport(t.id)}
                  className={cn(
                    'relative flex flex-col items-center gap-1 rounded-lg border-2 p-3 transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    selected
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                      : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-sm font-semibold">{t.label}</span>
                  {!t.available && t.disabledReason && (
                    <span className="absolute right-1 top-1 rounded bg-stone-200 px-1 py-0.5 text-[9px] uppercase tracking-wider text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                      {t.disabledReason}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {uiTransport === 'usb' && (
          <div className="space-y-2">
            <label
              htmlFor="usb-printer-select"
              className="mb-1 block text-xs uppercase tracking-wider text-stone-500"
            >
              Printer
            </label>
            <div className="flex gap-2">
              <select
                id="usb-printer-select"
                value={printerName}
                onChange={(e) => setPrinterName(e.target.value)}
                disabled={!usbSupported}
                className={inputClass}
              >
                <option value="">
                  {printersQ.isPending ? 'Looking for printers…' : '— pick the printer —'}
                </option>
                {!selectedIsKnown && (
                  <option value={printerName}>{printerName} (not found right now)</option>
                )}
                {systemPrinters.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.displayName}
                    {p.isDefault ? ' (Windows default)' : ''}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                disabled={!usbSupported || printersQ.isFetching}
                onClick={() => void printersQ.refetch()}
                aria-label="Refresh printer list"
              >
                <RefreshCw className={cn('h-4 w-4', printersQ.isFetching && 'animate-spin')} />
              </Button>
            </div>
            {!usbSupported ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                USB printing is available on Windows only.
              </p>
            ) : printersQ.isSuccess && systemPrinters.length === 0 ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Windows hasn&rsquo;t found any printer yet. Check the USB cable and power, install
                the driver from the printer&rsquo;s CD or the maker&rsquo;s website, then refresh.
              </p>
            ) : (
              <p className="text-xs text-stone-500">
                Plug the printer into this PC with its USB cable and switch it on. It must appear in
                Windows under Settings → Bluetooth &amp; devices → Printers &amp; scanners (install
                the driver from the printer&rsquo;s CD or the maker&rsquo;s website if it
                doesn&rsquo;t). Pick it here, Save, then Test print. Receipts go through
                Windows&rsquo; own print queue, so if the printer is off they print when it comes
                back.
              </p>
            )}
          </div>
        )}

        {uiTransport === 'network' && (
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                IP address or hostname
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                Port
              </label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="9100"
                className={inputClass}
              />
            </div>
          </div>
        )}

        {uiTransport === 'mock' && (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400">
            No printer connected: receipts are saved as files in the app&rsquo;s
            <code className="mx-1 rounded bg-stone-200 px-1 py-0.5 font-mono text-xs dark:bg-stone-700">
              printer-mock
            </code>
            folder instead of printing. Sales still work. Switch to USB or Wi-Fi / LAN once the
            printer is connected.
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
            Paper width
          </label>
          <div className="flex gap-2">
            {([32, 48] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWidth(w)}
                className={cn(
                  'rounded-lg border-2 px-4 py-2 font-semibold transition-colors',
                  width === w
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                    : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                )}
              >
                {w === 32 ? '58 mm' : '80 mm'} <span className="text-stone-500">({w} cols)</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-stone-200 pt-4 dark:border-stone-700">
          <div className="text-xs text-stone-500">
            {cfgQ.data?.config && (
              <span className="inline-flex items-center gap-1">
                <Check className="h-3 w-3 text-emerald-500" />
                Current: {labelCurrent(cfgQ.data.config)}
                {uiTransport === 'usb' && savedName && savedName !== printerName.trim() && (
                  <span className="ml-1 text-amber-600 dark:text-amber-400">
                    — save to use the new pick
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={testMut.isPending} onClick={testPrint}>
              {testMut.isPending ? 'Sending…' : 'Test print'}
            </Button>
            <Button variant="primary" disabled={saveMut.isPending} onClick={save}>
              {saveMut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </section>
    </Card>
  );
}

function labelCurrent(c: PrinterConnectionConfig): string {
  if (c.transport === 'network' && c.network?.host === 'mock') return 'No printer (saving to file)';
  if (c.transport === 'network' && c.network)
    return `Wi-Fi / LAN · ${c.network.host}:${c.network.port}`;
  if (c.transport === 'usb' && c.usb?.printerName) return `USB · ${c.usb.printerName}`;
  return c.transport;
}
