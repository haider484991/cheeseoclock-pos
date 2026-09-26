import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { hasCapability } from '@cheeseoclock/shared-types';
import { useSessionStore } from '../../stores/sessionStore';
import { useToast } from '../../components/toast/ToastProvider';
import { PAGE_ACCESS, canOpenPage, homeFor, type GatedPage } from './navAccess';

/**
 * A page for some logins only. The route's loader already turns away anyone
 * without it when they navigate there; this covers someone who is ALREADY on
 * the page when that changes — their role was changed while signed in (the
 * till reads the role again every 30 s), or the screen kept its address over
 * a reload. They get one plain toast and go to their start page (Checkout for
 * the counter); the page itself never renders for them, so it asks the till
 * for nothing (which the main process would refuse anyway).
 */
export function OnlyFor({ page, children }: { page: GatedPage; children: ReactNode }) {
  const user = useSessionStore((s) => s.user);
  const navigate = useNavigate();
  const { toast } = useToast();
  const allowed = !!user && canOpenPage(user.role, page);

  useEffect(() => {
    // Nobody signed in: AppShell is already on its way to the PIN pad.
    if (!user || allowed) return;
    const home = homeFor(user.role);
    const { capability, label } = PAGE_ACCESS[page];
    toast({
      title: `${label} is for ${hasCapability('manager', capability) ? 'managers and the owner' : 'the owner'}`,
      description: `Taking you to ${home === '/checkout' ? 'Checkout' : 'the start page'}. Ask a manager if you need it.`,
      variant: 'warning',
    });
    navigate(home, { replace: true });
  }, [user, allowed, page, navigate, toast]);

  return allowed ? <>{children}</> : null;
}
