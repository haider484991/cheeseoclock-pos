import { Link } from 'react-router-dom';
import { AlertTriangle, Send } from 'lucide-react';
import { MENU_DEPLOY_PROBLEM_PHASES } from '@cheeseoclock/shared-types';
import { useMenuDeployView } from '../menu-mgmt/useMenuDeploy';

/**
 * Dashboard → Shop status (the owner): a menu file from the costing PC that
 * needs him — refused, given up after 5 tries, too new for this till, or
 * stopped halfway on the other till (red); or waiting for his OK (amber —
 * it stays here until he looks, whoever was signed in when it arrived and
 * its one-time note went by), or held back by the link to the other till
 * (amber: nothing on the screens says the link is down otherwise). Nothing
 * otherwise.
 */
export function MenuDeployBanner() {
  const q = useMenuDeployView();
  const view = q.data;
  if (!view) return null;
  const problem = MENU_DEPLOY_PROBLEM_PHASES.includes(view.phase);
  const waiting = (view.phase === 'waiting_for_owner' && view.canApplyNow) || view.phase === 'waiting_link';
  if (!problem && !waiting) return null;
  return (
    <div
      role={problem ? 'alert' : 'status'}
      className={
        problem
          ? 'flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100'
          : 'flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100'
      }
    >
      {problem ? <AlertTriangle className="mt-0.5 h-5 w-5 flex-none" /> : <Send className="mt-0.5 h-5 w-5 flex-none" />}
      <div className="min-w-0 flex-1">
        <div className="font-semibold">
          {problem
            ? 'A menu file from the costing PC needs you'
            : view.phase === 'waiting_link'
              ? 'A menu file from the costing PC waits for the link to the other till'
              : 'A menu file from the costing PC waits for your OK'}
        </div>
        <p className="mt-1">{view.message}</p>
        {view.phase === 'waiting_link' ? (
          <Link to="/settings?tab=advanced" className="mt-2 inline-block font-semibold underline">
            Open Settings → Second till
          </Link>
        ) : (
          <Link to={view.phase === 'too_old' ? '/settings?tab=about' : '/menu?tab=import'} className="mt-2 inline-block font-semibold underline">
            {view.phase === 'too_old' ? 'Open About this till' : 'Open Menu → Import'}
          </Link>
        )}
      </div>
    </div>
  );
}
