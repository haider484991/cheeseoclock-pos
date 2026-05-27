import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import type { PrinterConnectionConfig, PrinterTransport } from '@cheeseoclock/shared-types';
import { Printer, Wifi, Usb, Bluetooth, FlaskConical, Check, X } from 'lucide-react';

interface TransportOption {
  id: PrinterTransport | 'mock';
  label: string;
  icon: typeof Wifi;
  available: boolean;
  disabledReason?: string;
}

const TRANSPORTS: TransportOption[] = [
  { id: 'mock', label: 'Mock (file)', icon: FlaskConical, available: true },
  { id: 'network', label: 'Network', icon: Wifi, available: true },
  { id: 'usb', label: 'USB', icon: Usb, available: false, disabledReason: 'Phase 3.5' },
  {
    id: 'bluetooth',
    label: 'Bluetooth',
    icon: Bluetooth,
    available: false,
    disabledReason: 'Phase 3.5',
  },
];

function inferUiTransport(config: PrinterConnectionConfig): TransportOption['id'] {
  if (config.transport === 'network' && config.network?.host === 'mock') return 'mock';
  return config.transport;
}

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
  const [width, setWidth] = useState<32 | 48>(48);

  useEffect(() => {
    if (!cfgQ.data) return;
    const cfg = cfgQ.data.config;
    setUiTransport(inferUiTransport(cfg));
    setHost(cfg.network?.host && cfg.network.host !== 'mock' ? cfg.network.host : '192.168.1.100');
    setPort(String(cfg.network?.port ?? 9100));
    setWidth(cfg.width ?? 48);
  }, [cfgQ.data]);

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

  function buildConfig(): PrinterConnectionConfig {
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
    // USB / Bluetooth are disabled at the option level — we shouldn't reach here.
    return { transport: 'network', network: { host: 'mock', port: 9100 }, width };
  }

  function save() {
    saveMut.mutate(buildConfig());
  }

  function testPrint() {
    // Save first if user just changed anything? Easier: just run with current saved config.
    testMut.mutate();
  }

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Printer className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Receipt printer</h2>
      </div>

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
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
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
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
          </div>
        )}

        {uiTransport === 'mock' && (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400">
            Mock mode writes receipts to
            <code className="ml-1 rounded bg-stone-200 px-1 py-0.5 font-mono text-xs dark:bg-stone-700">
              userData/printer-mock/
            </code>
            . Perfect for development.
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
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={testMut.isPending}
              onClick={testPrint}
            >
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
  if (c.transport === 'network' && c.network?.host === 'mock') return 'Mock';
  if (c.transport === 'network' && c.network)
    return `Network · ${c.network.host}:${c.network.port}`;
  return c.transport;
}
