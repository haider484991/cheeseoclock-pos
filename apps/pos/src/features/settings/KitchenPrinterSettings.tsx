import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import type { PrinterConnectionConfig } from '@cheeseoclock/shared-types';
import { ChefHat, Check, RefreshCw } from 'lucide-react';

type Where = 'same' | 'network' | 'usb';

const inputClass =
  'w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800';

/**
 * Optional second printer at the pass. Left on "Same printer", kitchen tickets
 * come out of the receipt printer — the right answer for a one-printer counter.
 */
export function KitchenPrinterSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
  });

  const [where, setWhere] = useState<Where>('same');
  const [host, setHost] = useState('192.168.1.101');
  const [port, setPort] = useState('9100');
  const [printerName, setPrinterName] = useState('');
  const [width, setWidth] = useState<32 | 48>(48);

  useEffect(() => {
    if (!cfgQ.data) return;
    const k = cfgQ.data.kitchenPrinter;
    if (!k) {
      setWhere('same');
      return;
    }
    setWhere(k.transport === 'usb' ? 'usb' : 'network');
    if (k.network?.host) setHost(k.network.host);
    if (k.network?.port) setPort(String(k.network.port));
    setPrinterName(k.usb?.printerName ?? '');
    setWidth(k.width ?? 48);
  }, [cfgQ.data]);

  const printersQ = useQuery({
    queryKey: ['printer', 'system'],
    queryFn: () => ipc.printer.listSystemPrinters(),
    enabled: where === 'usb',
    staleTime: 10_000,
  });
  const systemPrinters = useMemo(() => printersQ.data?.printers ?? [], [printersQ.data]);
  const usbSupported = printersQ.data?.supported ?? true;

  const saveMut = useMutation({
    mutationFn: (config: PrinterConnectionConfig | null) =>
      ipc.printer.setKitchenPrinter({ config }),
    onSuccess: () => {
      toast({ title: 'Kitchen printer saved', variant: 'success' });
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
    mutationFn: () => ipc.printer.test('kitchen'),
    onSuccess: (result) => {
      if (result.ok) {
        toast({ title: 'Test page sent to the kitchen printer', variant: 'success' });
      } else {
        toast({
          title: 'Kitchen test print failed',
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

  function buildConfig(): PrinterConnectionConfig | null | undefined {
    if (where === 'same') return null;
    if (where === 'network') {
      const p = parseInt(port, 10);
      if (!host.trim()) {
        toast({ title: 'Enter the printer address', variant: 'error' });
        return undefined;
      }
      return {
        transport: 'network',
        network: { host: host.trim(), port: Number.isFinite(p) && p > 0 ? p : 9100, timeoutMs: 5000 },
        width,
      };
    }
    const name = printerName.trim();
    if (!name) {
      toast({
        title: 'Pick the printer first',
        description: 'Choose the kitchen printer from the list, then save.',
        variant: 'error',
      });
      return undefined;
    }
    return { transport: 'usb', usb: { printerName: name }, width };
  }

  function save() {
    const config = buildConfig();
    if (config !== undefined) saveMut.mutate(config);
  }

  const current = cfgQ.data?.kitchenPrinter ?? null;
  const selectedIsKnown = !printerName || systemPrinters.some((p) => p.name === printerName);

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <ChefHat className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Kitchen printer</h2>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        Where kitchen tickets come out. With one printer at the counter leave this on &ldquo;Same
        printer&rdquo;. A printer at the pass can be on the Wi-Fi / LAN, or plugged into this PC by
        USB.
      </p>

      <section className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { id: 'same', label: 'Same printer' },
              { id: 'network', label: 'Wi-Fi / LAN' },
              { id: 'usb', label: 'USB' },
            ] as Array<{ id: Where; label: string }>
          ).map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setWhere(o.id)}
              className={cn(
                'rounded-lg border-2 p-3 text-sm font-semibold transition-colors',
                where === o.id
                  ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                  : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>

        {where === 'network' && (
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                IP address or hostname
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.101"
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

        {where === 'usb' && (
          <div className="space-y-2">
            <label
              htmlFor="kitchen-usb-printer-select"
              className="mb-1 block text-xs uppercase tracking-wider text-stone-500"
            >
              Printer
            </label>
            <div className="flex gap-2">
              <select
                id="kitchen-usb-printer-select"
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
            {!usbSupported && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                USB printing is available on Windows only.
              </p>
            )}
          </div>
        )}

        {where !== 'same' && (
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
        )}

        <div className="flex items-center justify-between border-t border-stone-200 pt-4 dark:border-stone-700">
          <div className="text-xs text-stone-500">
            <span className="inline-flex items-center gap-1">
              <Check className="h-3 w-3 text-emerald-500" />
              Current: {labelCurrent(current)}
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={testMut.isPending} onClick={() => testMut.mutate()}>
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

function labelCurrent(c: PrinterConnectionConfig | null): string {
  if (!c) return 'Same as the receipt printer';
  if (c.transport === 'network' && c.network)
    return `Wi-Fi / LAN · ${c.network.host}:${c.network.port}`;
  if (c.transport === 'usb' && c.usb?.printerName) return `USB · ${c.usb.printerName}`;
  return c.transport;
}
