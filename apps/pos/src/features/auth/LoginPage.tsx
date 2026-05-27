import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { NumberPad } from '@cheeseoclock/ui';
import { useSessionStore } from '../../stores/sessionStore';
import { useToast } from '../../components/toast/ToastProvider';
import { ipc } from '../../ipc/client';
import { Pizza, Lock } from 'lucide-react';

export function LoginPage() {
  const [pin, setPin] = useState('');
  const navigate = useNavigate();
  const login = useSessionStore((s) => s.login);
  const refresh = useSessionStore((s) => s.refresh);
  const status = useSessionStore((s) => s.status);
  const errorMessage = useSessionStore((s) => s.errorMessage);
  const { toast } = useToast();
  const brandingQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
    staleTime: 60_000,
  });
  const logoUrl = brandingQ.data?.branding.logoUrl;
  const storeName = brandingQ.data?.branding.storeName ?? 'CheeseOclock POS';
  const tagline = brandingQ.data?.branding.storeTagline;

  useEffect(() => {
    void refresh().then(() => {
      const u = useSessionStore.getState().user;
      if (u) navigate('/', { replace: true });
    });
  }, [navigate, refresh]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key >= '0' && e.key <= '9') {
        if (pin.length < 8) setPin(pin + e.key);
      } else if (e.key === 'Backspace') {
        setPin(pin.slice(0, -1));
      } else if (e.key === 'Enter') {
        void submit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  async function submit() {
    if (pin.length < 4) {
      toast({ title: 'PIN too short', description: 'Enter 4–8 digits.', variant: 'warning' });
      return;
    }
    try {
      await login(pin);
      setPin('');
      navigate('/', { replace: true });
    } catch {
      setPin('');
      toast({ title: 'Login failed', description: errorMessage ?? 'Invalid PIN', variant: 'error' });
    }
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      {/* Ambient gradient orbs */}
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

      <div className="relative w-[460px] animate-scale-in">
        <div className="glass-surface rounded-3xl p-8 shadow-soft-lg ring-1 ring-stone-200/60 dark:ring-stone-700/60">
          <div className="mb-6 flex flex-col items-center gap-3">
            <div className="relative">
              <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-lift">
                {logoUrl ? (
                  /* eslint-disable-next-line jsx-a11y/alt-text */
                  <img src={logoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Pizza className="h-10 w-10" />
                )}
              </div>
              <div className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full bg-white shadow-soft ring-1 ring-stone-200 dark:bg-stone-800 dark:ring-stone-700">
                <Lock className="h-3.5 w-3.5 text-stone-600 dark:text-stone-300" />
              </div>
            </div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight">{storeName}</h1>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              {tagline ?? 'Enter your PIN to continue'}
            </p>
          </div>

          <NumberPad value={pin} onChange={setPin} onSubmit={submit} mask maxLength={8} />

          {status === 'loading' ? (
            <p className="mt-4 text-center text-sm font-medium text-amber-700 dark:text-amber-300">
              Verifying…
            </p>
          ) : (
            <p className="mt-4 text-center text-[11px] uppercase tracking-widest text-stone-400">
              Dev PINs · admin 9999 · manager 5678 · cashier 1234
            </p>
          )}
        </div>

        <div className="mt-4 text-center text-[10px] uppercase tracking-widest text-stone-400">
          Built for restaurants · Offline-first · FBR-ready
        </div>
      </div>
    </div>
  );
}
