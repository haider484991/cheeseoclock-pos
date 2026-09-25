import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useSessionStore } from '../../stores/sessionStore';
import { ipc, onLowStock, onPrinterFailed, onWebOrderReceived } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useQueryClient } from '@tanstack/react-query';
import { formatCents } from '@cheeseoclock/pos-domain';

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
        variant: 'error',
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

  // New online order from the website → loud toast + refresh the board.
  useEffect(() => {
    return onWebOrderReceived((payload) => {
      const no = payload.orderNumber.split('-').pop();
      toast({
        title: '🌐 New online order!',
        description: `#${no} — ${payload.customerName}. Check Live Orders.`,
      });
      // The till priced it differently from what the website showed (a price
      // changed since the menu was published): the customer expects the other
      // amount, so someone should call before the rider asks for it.
      if (payload.totalMismatch) {
        toast({
          title: `Online order #${no}: the total changed`,
          description: `The website showed ${formatCents(payload.totalMismatch.webTotalCents)}, the till bills ${formatCents(payload.totalMismatch.tillTotalCents)}. Call ${payload.customerName} before it goes out — and publish the menu again (Settings → Online orders).`,
          variant: 'warning',
          duration: 60_000,
        });
      }
      void qc.invalidateQueries({ queryKey: ['orders', 'active'] });
    });
  }, [toast, qc]);

  if (!user) return null;

  return (
    <div className={isCheckout ? 'app-shell app-shell--compact flex h-full' : 'app-shell flex h-full'}>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className={isCheckout ? 'checkout-main min-h-0 flex-1 overflow-auto' : 'min-h-0 flex-1 overflow-auto p-4 lg:p-8'}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
