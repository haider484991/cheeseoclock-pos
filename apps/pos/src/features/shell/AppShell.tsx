import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { ReceiptLogoKeeper } from '../settings/ReceiptLogoKeeper';
import { TopBar } from './TopBar';
import { useSessionStore } from '../../stores/sessionStore';
import { ipc, onLowStock, onPrinterFailed, onWebOrderReceived } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useQueryClient } from '@tanstack/react-query';
import { DRAWER_NOT_OPENED_CODE, DRAWER_UNSURE_CODE } from '@cheeseoclock/shared-types';

export function AppShell() {
  const user = useSessionStore((s) => s.user);
  const navigate = useNavigate();
  const isCheckout = useLocation().pathname === '/checkout';
  const { toast } = useToast();
  const qc = useQueryClient();

  useEffect(() => {
    if (!user) navigate('/login', { replace: true });
  }, [user, navigate]);

  // Idle lock. Key presses and clicks tell the till someone is here (at most
  // every 30 s); the session is checked every 30 s, so an owner or manager
  // login left alone ends on its own and the screen goes back to the PIN pad.
  const refresh = useSessionStore((s) => s.refresh);
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    let last = 0;
    const onInput = () => {
      const now = Date.now();
      if (now - last < 30_000) return;
      last = now;
      void ipc.auth.activity().catch(() => undefined);
    };
    window.addEventListener('pointerdown', onInput, true);
    window.addEventListener('keydown', onInput, true);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      window.removeEventListener('pointerdown', onInput, true);
      window.removeEventListener('keydown', onInput, true);
      window.clearInterval(timer);
    };
  }, [userId, refresh]);

  // Surface any spooler failure as a toast — sales are already saved.
  useEffect(() => {
    return onPrinterFailed((payload) => {
      // The cash drawer: say plainly what to do at the counter.
      if (payload.error?.code === DRAWER_NOT_OPENED_CODE || payload.error?.code === DRAWER_UNSURE_CODE) {
        const unsure = payload.error.code === DRAWER_UNSURE_CODE;
        toast({
          title: unsure ? 'Cash drawer may not have opened — check it' : 'Cash drawer did not open — use the key',
          description: payload.error.message,
          variant: 'warning',
          duration: 15_000,
        });
        return;
      }
      if (payload.jobKind === 'drawer' && payload.retrying) {
        toast({
          title: 'Cash drawer not opening yet',
          description: 'The printer is not answering. The till keeps trying for up to a minute, until the drawer opens.',
          variant: 'warning',
        });
        return;
      }
      toast({
        title: payload.retrying
          ? `Printer not responding — ${payload.jobKind === 'kitchen' ? 'kitchen ticket' : payload.jobKind === 'drawer' ? 'cash drawer' : 'receipt'} will retry`
          : 'Print failed',
        description:
          payload.error?.message ??
          (payload.jobKind === 'kitchen'
            ? 'Could not print kitchen ticket'
            : payload.jobKind === 'drawer'
              ? 'Could not open the cash drawer'
              : 'Could not print receipt'),
        // A retry on its way is a warning that clears itself; a final failure stays until closed.
        variant: payload.retrying ? 'warning' : 'error',
      });
    });
  }, [toast]);

  // An order just took an ingredient below its low-stock level: say so once,
  // while there is still time to send someone out for it.
  useEffect(() => {
    return onLowStock((items) => {
      toast({
        title: items.length === 1 ? `Running low: ${items[0]!.name}` : `Running low on ${items.length} items`,
        description: items
          .map((i) => `${i.name}: ${Math.max(0, i.resultingQty).toLocaleString('en-PK')} ${i.unit} left`)
          .join(' · '),
        variant: 'warning',
        duration: 15_000,
      });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    });
  }, [toast, qc]);

  // New online order from the website → refresh the board. The banner, the
  // chime and the "total changed" note come from OrderAlerts (mounted at the
  // root, so they work on the PIN screen too).
  useEffect(() => {
    return onWebOrderReceived(() => {
      void qc.invalidateQueries({ queryKey: ['orders', 'active'] });
    });
  }, [qc]);

  if (!user) return null;

  return (
    <div className={isCheckout ? 'app-shell app-shell--compact flex h-full' : 'app-shell flex h-full'}>
      <Sidebar />
      <ReceiptLogoKeeper />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className={isCheckout ? 'checkout-main min-h-0 flex-1 overflow-auto' : 'min-h-0 flex-1 overflow-auto p-4 lg:p-8'}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
