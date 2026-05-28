import { useEffect, useState } from 'react';
import { Button } from '@cheeseoclock/ui';
import { useSessionStore } from '../../stores/sessionStore';
import { LogOut, Clock, Calculator } from 'lucide-react';
import { CalculatorPopover } from './CalculatorPopover';
import { ShiftWidget } from './ShiftWidget';

/** Re-render every minute so the wall clock stays current. */
function useNowTick(intervalMs = 60_000): number {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return tick;
}

const ROLE_LABEL = {
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
} as const;

const ROLE_COLOR = {
  admin: 'from-emerald-400 to-emerald-600',
  manager: 'from-amber-400 to-amber-600',
  cashier: 'from-blue-400 to-blue-600',
} as const;

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function TopBar() {
  const user = useSessionStore((s) => s.user);
  const logout = useSessionStore((s) => s.logout);
  const [calcOpen, setCalcOpen] = useState(false);
  const tick = useNowTick();
  const now = new Date(tick);

  return (
    <header className="flex h-16 items-center justify-between border-b border-stone-200/70 bg-white/70 px-8 backdrop-blur-md dark:border-stone-800/70 dark:bg-stone-900/70">
      <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
        <Clock className="h-4 w-4" />
        <span className="font-medium">
          {now.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          })}
        </span>
        <span className="ml-2 text-xs text-stone-400">
          {now.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          })}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <ShiftWidget />
        <button
          type="button"
          onClick={() => setCalcOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-xl text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-800 dark:hover:text-stone-100"
          title="Calculator"
        >
          <Calculator className="h-4 w-4" />
        </button>
        {user && (
          <div className="flex items-center gap-3 rounded-xl bg-stone-100/70 px-3 py-1.5 dark:bg-stone-800/70">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br ${ROLE_COLOR[user.role]} text-xs font-bold text-white shadow-soft-sm`}
            >
              {initials(user.fullName)}
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold">{user.fullName}</span>
              <span className="text-[10px] uppercase tracking-widest text-stone-500">
                {ROLE_LABEL[user.role]}
              </span>
            </div>
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={() => void logout()}>
          <LogOut className="h-4 w-4" />
          Log out
        </Button>
      </div>
      <CalculatorPopover open={calcOpen} onClose={() => setCalcOpen(false)} />
    </header>
  );
}
