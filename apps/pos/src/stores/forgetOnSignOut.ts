import type { QueryClient } from '@tanstack/react-query';
import { useSessionStore } from './sessionStore';

/** Who is signed in, as far as what they may see goes. */
export function whoKey(user: { id: string; role: string } | null): string | null {
  return user ? `${user.id}:${user.role}` : null;
}

/**
 * When the person at the till changes — sign-out, the idle lock, a manager
 * handing the till back, a role changed while signed in — forget every answer the
 * screens are no longer showing. A manager's customer list, order history
 * and reports stay in the screen's memory for minutes after their pages
 * close (React Query keeps inactive answers for gcTime); the cashier who
 * signs in next must not be handed them by a page that finds them there.
 *
 * Only inactive answers go: whatever is still on screen (the website-order
 * alerts, which run even on the PIN pad) keeps working. It runs once React
 * has closed the old pages, hence the timeout.
 */
export function forgetOnWhoChanges(qc: QueryClient): () => void {
  let who = whoKey(useSessionStore.getState().user);
  return useSessionStore.subscribe((state) => {
    const next = whoKey(state.user);
    if (next === who) return;
    const hadSomeone = who !== null;
    who = next;
    if (hadSomeone) setTimeout(() => qc.removeQueries({ type: 'inactive' }), 0);
  });
}
