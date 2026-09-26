import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { Building2, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

type Mode = 'noop' | 'sandbox' | 'production';

const MODES: Array<{ id: Mode; label: string; description: string }> = [
  {
    id: 'noop',
    label: 'Off',
    description:
      'Nothing is sent to FBR, and receipts print without an FBR number or QR code. Keep this until you have your FBR token.',
  },
  {
    id: 'sandbox',
    label: 'Test',
    description: 'Sales go to a test server only, to check everything works before going live.',
  },
  {
    id: 'production',
    label: 'Live',
    description: 'Every sale is reported to FBR, and each receipt carries its FBR number and QR code.',
  },
];

/** Pakistan's provinces and territories, as FBR names them. */
const PROVINCES = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Islamabad Capital Territory',
  'Gilgit-Baltistan',
  'Azad Jammu and Kashmir',
];

/** The main process names missing fields in its own words; say them the way this form does. */
const MISSING_LABEL: Record<string, string> = {
  'Bearer token': 'FBR security token',
  'Seller NTN/CNIC': 'NTN or CNIC',
  'Business name': 'Registered business name',
  'Seller address': 'Business address',
};

export function FbrSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({
    queryKey: ['fbr', 'config'],
    queryFn: () => ipc.fbr.getConfig(),
  });

  const [mode, setMode] = useState<Mode>('noop');
  const [endpoint, setEndpoint] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [sellerNTNCNIC, setSellerNTNCNIC] = useState('');
  const [sellerBusinessName, setSellerBusinessName] = useState('');
  const [sellerProvince, setSellerProvince] = useState('Punjab');
  const [sellerAddress, setSellerAddress] = useState('');
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!cfgQ.data) return;
    const c = cfgQ.data;
    setMode(c.mode);
    setEndpoint(c.endpoint ?? '');
    setBearerToken(c.bearerToken ?? '');
    setSellerNTNCNIC(c.sellerNTNCNIC);
    setSellerBusinessName(c.sellerBusinessName);
    setSellerProvince(c.sellerProvince);
    setSellerAddress(c.sellerAddress);
    setPaused(c.paused);
  }, [cfgQ.data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      // Going live changes every receipt from now on: ask once, plainly.
      if (mode === 'production' && cfgQ.data?.mode !== 'production') {
        const ok = await askConfirm(
          'Start reporting every sale to FBR?\nFrom now on each sale is sent to FBR and its receipt carries the FBR number and QR code. Only do this once Test mode has worked.',
        );
        if (!ok) return false;
      }
      await ipc.fbr.setConfig({
        mode,
        ...(endpoint ? { endpoint } : {}),
        ...(bearerToken ? { bearerToken } : {}),
        sellerNTNCNIC,
        sellerBusinessName,
        sellerProvince,
        sellerAddress,
        paused,
      });
      return true;
    },
    onSuccess: (saved) => {
      if (!saved) return;
      toast({ title: 'FBR settings saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['fbr'] });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const ready = cfgQ.data?.ready;

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Building2 className="h-5 w-5" />
        <h2 className="text-lg font-semibold">FBR digital invoicing</h2>
        {ready && mode !== 'noop' && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
              ready.ok
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
            )}
          >
            {ready.ok ? (
              <>
                <CheckCircle2 className="h-3 w-3" />
                Ready
              </>
            ) : (
              <>
                <AlertTriangle className="h-3 w-3" />
                Needs setup
              </>
            )}
          </span>
        )}
      </div>

      <p className="mb-4 text-sm text-stone-500">
        Only needed if the shop has to report its sales to FBR (Digital Invoicing). Leave it Off
        otherwise; nothing else in the till depends on it.
      </p>

      <section className="space-y-4">
        <div>
          <label className="mb-2 block text-xs uppercase tracking-wider text-stone-500">
            Report sales to FBR
          </label>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-lg border-2 p-3 text-left transition-colors',
                  mode === m.id
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                    : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                )}
              >
                <span className="text-sm font-semibold">{m.label}</span>
                <span className="text-xs text-stone-500">{m.description}</span>
              </button>
            ))}
          </div>
        </div>

        {mode !== 'noop' && (
          <>
            {mode === 'sandbox' && (
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                  Test server address
                </label>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="http://localhost:8787/di_data/v1/di/postinvoicedata"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                />
                <p className="mt-1 text-xs text-stone-500">
                  The test address PRAL gave you for your account (FBR only shares it with registered businesses).
                </p>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                FBR security token
              </label>
              <div className="flex gap-2">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={bearerToken}
                  onChange={(e) => setBearerToken(e.target.value)}
                  placeholder="Paste the long token from e.fbr.gov.pk"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  className="rounded-lg border border-stone-300 px-3 text-xs dark:border-stone-700"
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="mt-1 text-xs text-stone-500">
                From your account on e.fbr.gov.pk (Digital Invoicing). Only the last 4 characters
                show once saved.
              </p>
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="NTN or CNIC"
            value={sellerNTNCNIC}
            onChange={setSellerNTNCNIC}
            placeholder="0000000-0"
          />
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Province</label>
            <select
              value={sellerProvince}
              onChange={(e) => setSellerProvince(e.target.value)}
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
            >
              {!PROVINCES.includes(sellerProvince) && sellerProvince && (
                <option value={sellerProvince}>{sellerProvince}</option>
              )}
              {PROVINCES.map((pr) => (
                <option key={pr} value={pr}>
                  {pr}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Field
          label="Registered business name"
          value={sellerBusinessName}
          onChange={setSellerBusinessName}
          placeholder="Cheese O Clock (Pvt) Ltd"
        />
        <Field
          label="Business address"
          value={sellerAddress}
          onChange={setSellerAddress}
          placeholder="DHA Phase 6, Karachi"
        />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={paused}
            onChange={(e) => setPaused(e.target.checked)}
            className="h-4 w-4 rounded border-stone-300 dark:border-stone-700"
          />
          Pause sending (sales wait on this till and go out when you untick this)
        </label>

        {ready && !ready.ok && mode !== 'noop' && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <div>
              <div className="font-semibold">Fill these in before sales can go to FBR:</div>
              <div className="text-amber-900 dark:text-amber-200">
                {ready.missing.map((m) => MISSING_LABEL[m] ?? m).join(', ')}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end border-t border-stone-200 pt-3 dark:border-stone-700">
          <Button variant="primary" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
            {saveMut.isPending ? 'Saving…' : 'Save FBR settings'}
          </Button>
        </div>
      </section>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
      />
    </div>
  );
}
