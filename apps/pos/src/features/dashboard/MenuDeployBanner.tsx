import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { MENU_DEPLOY_PROBLEM_PHASES } from '@cheeseoclock/shared-types';
import { useMenuDeployView } from '../menu-mgmt/useMenuDeploy';

/**
 * Dashboard → Shop status (the owner): a menu file from the costing PC that
 * needs him — refused, given up after 5 tries, too new for this till, or
 * stopped halfway on the other till. Nothing otherwise.
 */
export function MenuDeployBanner() {
  const q = useMenuDeployView();
  const view = q.data;
  if (!view || !MENU_DEPLOY_PROBLEM_PHASES.includes(view.phase)) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-none" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">A menu file from the costing PC needs you</div>
        <p className="mt-1">{view.message}</p>
        <Link to={view.phase === 'too_old' ? '/settings?tab=about' : '/menu?tab=import'} className="mt-2 inline-block font-semibold underline">
          {view.phase === 'too_old' ? 'Open About this till' : 'Open Menu → Import'}
        </Link>
      </div>
    </div>
  );
}
