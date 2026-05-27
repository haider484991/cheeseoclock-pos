import { Outlet, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useSessionStore } from '../../stores/sessionStore';
import { onPrinterFailed } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';

export function AppShell() {
  const user = useSessionStore((s) => s.user);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (!user) navigate('/login', { replace: true });
  }, [user, navigate]);

  // Surface any spooler failure as a toast — sales are already saved.
  useEffect(() => {
    return onPrinterFailed((payload) => {
      toast({
        title: 'Print failed',
        description:
          payload.error?.message ??
          `Could not print ${payload.jobKind === 'receipt' ? 'receipt' : 'job'}`,
        variant: 'error',
      });
    });
  }, [toast]);

  if (!user) return null;

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
