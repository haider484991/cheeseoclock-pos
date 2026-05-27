import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, ImagePicker, cn } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import {
  Store,
  Receipt,
  ShieldCheck,
  Sparkles,
  Plus,
  Trash2,
  ArrowRight,
  ArrowLeft,
  Pizza,
  Check,
} from 'lucide-react';

/**
 * First-run onboarding. Visible until at least one user exists. Collects:
 *   1. Business basics (logo, name, contact)
 *   2. Tax categories (pre-filled with Pakistan defaults)
 *   3. First admin user (name + PIN)
 *
 * On finish, calls system:completeOnboarding which atomically creates the
 * user, writes branding, and inserts the chosen tax categories. After success
 * the parent re-queries setup status and the router unmounts this page.
 */

interface TaxRow {
  name: string;
  rateBps: number;
}

const DEFAULT_TAX_PRESETS: TaxRow[] = [
  { name: 'Standard 17%', rateBps: 1700 },
  { name: 'Beverages 13%', rateBps: 1300 },
  { name: 'Zero-rated', rateBps: 0 },
];

interface Props {
  onComplete: () => void;
}

export function OnboardingPage({ onComplete }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState(0);

  // Step 1
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [storeName, setStoreName] = useState('');
  const [storeTagline, setStoreTagline] = useState('');
  const [phoneLine, setPhoneLine] = useState('');
  const [branchLine, setBranchLine] = useState('');

  // Step 2
  const [taxRows, setTaxRows] = useState<TaxRow[]>(DEFAULT_TAX_PRESETS);

  // Step 3
  const [adminName, setAdminName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');

  const completeMut = useMutation({
    mutationFn: () =>
      ipc.system.completeOnboarding({
        storeName: storeName.trim(),
        ...(storeTagline.trim() ? { storeTagline: storeTagline.trim() } : {}),
        ...(branchLine.trim() ? { branchLine: branchLine.trim() } : {}),
        ...(phoneLine.trim() ? { phoneLine: phoneLine.trim() } : {}),
        ...(logoUrl ? { logoUrl } : {}),
        taxCategories: taxRows.filter((r) => r.name.trim()),
        admin: { fullName: adminName.trim(), pin },
      }),
    onSuccess: () => {
      toast({ title: 'Welcome aboard!', variant: 'success' });
      onComplete();
    },
    onError: (e) =>
      toast({
        title: 'Setup failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const steps: Array<{ title: string; icon: typeof Store; complete: boolean }> = [
    { title: 'Business', icon: Store, complete: storeName.trim().length > 0 },
    { title: 'Tax', icon: Receipt, complete: taxRows.some((r) => r.name.trim()) },
    {
      title: 'Admin',
      icon: ShieldCheck,
      complete:
        adminName.trim().length > 0 &&
        pin.length >= 4 &&
        pin === confirmPin,
    },
  ];

  function next() {
    if (step < steps.length - 1) setStep(step + 1);
  }
  function back() {
    if (step > 0) setStep(step - 1);
  }
  function canAdvance(): boolean {
    return steps[step]?.complete ?? false;
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      {/* Ambient orbs */}
      <div
        className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(251,191,36,0.4) 0%, transparent 70%)' }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-40 h-[28rem] w-[28rem] rounded-full opacity-30 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(244,114,182,0.25) 0%, transparent 70%)' }}
        aria-hidden
      />

      <div className="relative w-[640px] animate-scale-in">
        {/* Logo header */}
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-lift">
            <Pizza className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Welcome to CheeseOclock POS</h1>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            A 2-minute setup — then you're ready to take orders.
          </p>
        </div>

        {/* Stepper */}
        <div className="mb-4 flex items-center justify-center gap-2">
          {steps.map((s, i) => {
            const Icon = s.icon;
            const active = i === step;
            const past = i < step;
            return (
              <div key={i} className="flex items-center gap-2">
                <div
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full transition-all',
                    active &&
                      'bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-lift ring-4 ring-amber-200',
                    past && 'bg-emerald-500 text-white shadow-soft-sm',
                    !active && !past && 'bg-stone-200 text-stone-500 dark:bg-stone-700',
                  )}
                >
                  {past ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={cn(
                      'h-0.5 w-12 transition-all',
                      past ? 'bg-emerald-500' : 'bg-stone-200 dark:bg-stone-700',
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Card */}
        <div className="glass-surface rounded-3xl p-7 shadow-soft-lg ring-1 ring-stone-200/60 dark:ring-stone-700/60">
          {step === 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold">Tell us about your business</h2>
              <p className="text-xs text-stone-500">
                These details print on every receipt and show in the sidebar.
              </p>

              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                  Logo
                </label>
                <ImagePicker
                  value={logoUrl}
                  onChange={setLogoUrl}
                  rounded
                  emptyLabel="Logo"
                />
              </div>

              <Field label="Business name *">
                <input
                  type="text"
                  value={storeName}
                  autoFocus
                  onChange={(e) => setStoreName(e.target.value)}
                  placeholder="e.g. Cheese O Clock"
                  className="w-full rounded-xl border border-stone-300 px-3 py-2.5 text-base dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>

              <Field label="Tagline">
                <input
                  type="text"
                  value={storeTagline}
                  onChange={(e) => setStoreTagline(e.target.value)}
                  placeholder="e.g. Pakistani Pizza · Cafe"
                  className="w-full rounded-xl border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Phone">
                  <input
                    type="tel"
                    value={phoneLine}
                    onChange={(e) => setPhoneLine(e.target.value)}
                    placeholder="+92 51 1234 5678"
                    className="w-full rounded-xl border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                  />
                </Field>
                <Field label="Branch / address">
                  <input
                    type="text"
                    value={branchLine}
                    onChange={(e) => setBranchLine(e.target.value)}
                    placeholder="F-10 Markaz, Islamabad"
                    className="w-full rounded-xl border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                  />
                </Field>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold">Set up sales tax</h2>
              <p className="text-xs text-stone-500">
                Categories you'll assign per menu item. Pakistani defaults are pre-filled — change them
                to match your registration.
              </p>

              <div className="space-y-2">
                {taxRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={row.name}
                      onChange={(e) => {
                        const next = [...taxRows];
                        next[i] = { ...row, name: e.target.value };
                        setTaxRows(next);
                      }}
                      placeholder="Tax category name"
                      className="flex-1 rounded-xl border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                    />
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        step="0.01"
                        value={(row.rateBps / 100).toString()}
                        onChange={(e) => {
                          const pct = parseFloat(e.target.value) || 0;
                          const next = [...taxRows];
                          next[i] = { ...row, rateBps: Math.round(pct * 100) };
                          setTaxRows(next);
                        }}
                        className="w-20 rounded-xl border border-stone-300 px-2 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                      />
                      <span className="text-sm text-stone-500">%</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTaxRows(taxRows.filter((_, j) => j !== i))}
                      className="rounded-lg p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setTaxRows([...taxRows, { name: '', rateBps: 0 }])
                  }
                >
                  <Plus className="h-3 w-3" /> Add tax category
                </Button>
              </div>

              <div className="rounded-xl bg-stone-100 p-3 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-400">
                <strong>Tip:</strong> If you're FBR-registered, ask your accountant which rates apply
                to your menu. You can always edit these later in Menu → Tax.
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold">Create your admin login</h2>
              <p className="text-xs text-stone-500">
                This first user can do everything: manage menu, staff, settings. You'll add cashiers
                + managers from Users later.
              </p>

              <Field label="Your full name *">
                <input
                  type="text"
                  value={adminName}
                  autoFocus
                  onChange={(e) => setAdminName(e.target.value)}
                  placeholder="e.g. Ali Khan"
                  className="w-full rounded-xl border border-stone-300 px-3 py-2.5 text-base dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="PIN (4–8 digits) *">
                  <input
                    type="password"
                    value={pin}
                    inputMode="numeric"
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="****"
                    className="w-full rounded-xl border border-stone-300 px-3 py-2.5 text-center font-mono text-lg tracking-widest dark:border-stone-700 dark:bg-stone-800"
                  />
                </Field>
                <Field label="Confirm PIN *">
                  <input
                    type="password"
                    value={confirmPin}
                    inputMode="numeric"
                    onChange={(e) =>
                      setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 8))
                    }
                    placeholder="****"
                    className="w-full rounded-xl border border-stone-300 px-3 py-2.5 text-center font-mono text-lg tracking-widest dark:border-stone-700 dark:bg-stone-800"
                  />
                </Field>
              </div>

              {pin.length > 0 && pin.length < 4 && (
                <p className="text-xs text-red-500">PIN must be at least 4 digits.</p>
              )}
              {confirmPin.length > 0 && pin !== confirmPin && (
                <p className="text-xs text-red-500">PINs don't match.</p>
              )}

              <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  Write your PIN down somewhere safe — there's no "forgot PIN" yet. If you lose it,
                  you'd need to reset the device.
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="mt-5 flex items-center justify-between">
          <Button variant="ghost" disabled={step === 0} onClick={back}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>

          {step < steps.length - 1 ? (
            <Button variant="primary" disabled={!canAdvance()} onClick={next}>
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="success"
              size="lg"
              disabled={!canAdvance() || completeMut.isPending}
              onClick={() => completeMut.mutate()}
            >
              {completeMut.isPending ? 'Setting up…' : 'Finish setup'}
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">
        {label}
      </label>
      {children}
    </div>
  );
}
