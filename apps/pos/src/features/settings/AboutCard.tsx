import { useQuery } from '@tanstack/react-query';
import { Card } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import { Info, Pizza, Heart, Mail, Phone, Code2 } from 'lucide-react';

export function AboutCard() {
  const versionQ = useQuery({
    queryKey: ['system', 'version'],
    queryFn: () => ipc.system.getVersion(),
    staleTime: Infinity,
  });
  const deviceQ = useQuery({
    queryKey: ['system', 'deviceInfo'],
    queryFn: () => ipc.system.getDeviceInfo(),
    staleTime: Infinity,
  });
  const brandingQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
    staleTime: 60_000,
  });

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Info className="h-5 w-5" />
        <h2 className="text-lg font-semibold">About</h2>
      </div>

      <div className="flex items-start gap-4">
        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-lift">
          {brandingQ.data?.branding.logoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <img src={brandingQ.data.branding.logoUrl} className="h-full w-full object-cover" />
          ) : (
            <Pizza className="h-8 w-8" />
          )}
        </div>
        <div className="flex-1">
          <div className="text-xl font-bold tracking-tight">
            {brandingQ.data?.branding.storeName ?? 'CheeseOclock POS'}
          </div>
          <div className="text-sm text-stone-500">
            {brandingQ.data?.branding.storeTagline ?? 'Modern POS for restaurants & cafés'}
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 border-t border-stone-200 pt-4 text-sm dark:border-stone-700">
        <dt className="text-stone-500">App version</dt>
        <dd className="font-mono font-medium">{versionQ.data?.version ?? '—'}</dd>
        <dt className="text-stone-500">Mode</dt>
        <dd>{versionQ.data?.isDev ? 'Development' : 'Production'}</dd>
        <dt className="text-stone-500">Device name</dt>
        <dd>{deviceQ.data?.displayName ?? '—'}</dd>
        <dt className="text-stone-500">Device ID</dt>
        <dd className="font-mono text-xs text-stone-500">{deviceQ.data?.deviceId ?? '—'}</dd>
        {deviceQ.data?.registeredAt && (
          <>
            <dt className="text-stone-500">Registered</dt>
            <dd>{new Date(deviceQ.data.registeredAt).toLocaleDateString()}</dd>
          </>
        )}
      </dl>

      <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/60 p-4 dark:border-stone-700 dark:bg-stone-900/40">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-700 dark:text-stone-200">
          <Code2 className="h-4 w-4" />
          Developer
        </div>
        <div className="text-sm font-medium">Haider Ali</div>
        <div className="mt-2 flex flex-col gap-1 text-xs text-stone-600 dark:text-stone-400">
          <a
            href="mailto:haider484991@gmail.com"
            className="inline-flex items-center gap-1.5 hover:text-amber-600"
          >
            <Mail className="h-3.5 w-3.5" />
            haider484991@gmail.com
          </a>
          <a
            href="tel:+923088440608"
            className="inline-flex items-center gap-1.5 hover:text-amber-600"
          >
            <Phone className="h-3.5 w-3.5" />
            +92 308 8440608
          </a>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-stone-200 pt-4 text-xs text-stone-500 dark:border-stone-700">
        <span className="inline-flex items-center gap-1">
          Built with <Heart className="h-3 w-3 text-red-500" /> for Pakistani restaurants
        </span>
        <span>© 2026 Haider Ali</span>
      </div>
    </Card>
  );
}
