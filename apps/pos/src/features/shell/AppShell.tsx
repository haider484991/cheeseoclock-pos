import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { ReceiptLogoKeeper } from '../settings/ReceiptLogoKeeper';
import { TopBar } from './TopBar';
import { StepInHold } from './StepInHold';
import { useSessionStore } from '../../stores/sessionStore';
import { ipc, onLowStock, onMenuDeployChanged, onPrinterFailed, onWebOrderReceived } from '../../ipc/client';
import { MENU_DEPLOY_KEY } from '../menu-mgmt/useMenuDeploy';
import { useToast } from '../../components/toast/ToastProvider';
import { useQueryClient } from '@tanstack/react-query';
import { DRAWER_NOT_OPENED_CODE, DRAWER_UNSURE_CODE } from '@cheeseoclock/shared-types';
import { failedPrintNote } from '../printing/failedPrintNote';

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
      // Given up on a receipt or kitchen ticket: the note names the paper and
      // the order, and "Try again" sends that very job again, so the paper
      // the till prints by itself stays the original (a print button would
      // print a DUPLICATE). failedPrintNote.ts.
      toast(
        failedPrintNote(payload, (jobId) => {
          ipc.printer
            .retryJob(jobId)
            .then((r) =>
              toast({
                title: r.requeued ? 'Sent to the printer again' : 'Nothing to print again — it already printed',
                variant: r.requeued ? 'success' : 'info',
              }),
            )
            .catch((e: unknown) =>
              toast({ title: 'Could not try again', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
            );
        }),
      );
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

  // A menu file from the costing PC (v0.7.32): every screen re-reads the menu and stock (whoever is
  // signed in); the people who manage the menu get the note — the main process sends each once per file.
  const canManageMenu = useSessionStore((st) => st.can('menu.manage'));
  useEffect(() => {
    return onMenuDeployChanged(({ notice }) => {
      void qc.invalidateQueries({ queryKey: ['menu'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: MENU_DEPLOY_KEY });
      if (!notice || !canManageMenu) return;
      toast({
        title: notice.title,
        description: notice.description,
        variant: notice.kind === 'problem' ? 'error' : notice.kind === 'waiting_for_owner' ? 'info' : 'success',
        duration: 15_000,
      });
    });
  }, [qc, toast, canManageMenu]);

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
      {/* A manager's stepping-in login: the PIN box over the page when it is held. */}
      <StepInHold />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className={isCheckout ? 'checkout-main min-h-0 flex-1 overflow-auto' : 'min-h-0 flex-1 overflow-auto p-4 lg:p-8'}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
