import { useQuery } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';

/** Every query about the menu files from the costing PC is under this key (the app shell re-reads it on news). */
export const MENU_DEPLOY_KEY = ['menu-deploy'] as const;

/**
 * Where this till stands with the menu files from the costing PC
 * (menuDeploy:getStatus; menu.manage). `withHistory` adds the website's last
 * lines (one network call); otherwise nothing leaves the till.
 */
export function useMenuDeployView(opts: { withHistory?: boolean; enabled?: boolean } = {}) {
  const withHistory = opts.withHistory === true;
  return useQuery({
    queryKey: [...MENU_DEPLOY_KEY, withHistory ? 'history' : 'view'],
    queryFn: () => ipc.menuDeploy.getStatus(withHistory),
    staleTime: withHistory ? 60_000 : 15_000,
    refetchInterval: withHistory ? false : 60_000,
    enabled: opts.enabled ?? true,
  });
}
