import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { Building2, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

type Mode = 'noop' | 'sandbox' | 'production';

const MODES: Array<{ id: Mode; label: string; description: string }> = [
  {
    id: 'noop',
    label: 'Noop',
    description: 'Dry-run: payloads dumped to disk. Default until credentials ready.',
  },
  {
    id: 'sandbox',
    label: 'Sandbox',
    description: 'POST to a sandbox or local mock URL — for testing flows.',
  },
  {
    id: 'production',
    label: 'Production',
    description: 'Live FBR PRAL gateway. Requires registered SCO credentials.',
  },
];

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
    mutationFn: () =>
      ipc.fbr.setConfig({
        mode,
        ...(endpoint ? { endpoint } : {}),
        ...(bearerToken ? { bearerToken } : {}),
        sellerNTNCNIC,
        sellerBusinessName,
        sellerProvince,
        sellerAddress,
        paused,
      }),
    onSuccess: () => {
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
        <h2 className="text-lg font-semibold">FBR Digital Invoicing</h2>
        {ready && (
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

      <section className="space-y-4">
        <div>
          <label className="mb-2 block text-xs uppercase tracking-wider text-stone-500">
            Submission mode
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
                  Sandbox endpoint (POST URL)
                </label>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="http://localhost:8787/di_data/v1/di/postinvoicedata"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                Bearer token (from e.fbr.gov.pk)
              </label>
              <div className="flex gap-2">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={bearerToken}
                  onChange={(e) => setBearerToken(e.target.value)}
                  placeholder="Long alphanumeric string from your SCO account"
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
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Seller NTN / CNIC"
            value={sellerNTNCNIC}
            onChange={setSellerNTNCNIC}
            placeholder="0000000-0"
          />
          <Field
            label="Province"
            value={sellerProvince}
            onChange={setSellerProvince}
            placeholder="Punjab"
          />
        </div>
        <Field
          label="Business name"
          value={sellerBusinessName}
          onChange={setSellerBusinessName}
          placeholder="Cheese O Clock (Pvt) Ltd"
        />
        <Field
          label="Seller address"
          value={sellerAddress}
          onChange={setSellerAddress}
          placeholder="F-10 Markaz, Islamabad"
        />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={paused}
            onChange={(e) => setPaused(e.target.checked)}
            className="h-4 w-4 rounded border-stone-300 dark:border-stone-700"
          />
          Pause submissions (workers idle but queue keeps filling)
        </label>

        {ready && !ready.ok && mode !== 'noop' && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <div>
              <div className="font-semibold">Missing fields before live submission:</div>
              <div className="text-amber-900 dark:text-amber-200">
                {ready.missing.join(', ')}
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
