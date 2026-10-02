import type { QueryClient } from '@tanstack/react-query';

/**
 * Every customer answer the screens keep (React Query, ['customers', …]): the
 * counter panel's phone search — 'inlineSearch' as a manager or the owner
 * types, 'byPhone' at the counter — the picker's search, a house number's
 * search, a customer's saved addresses and past orders.
 */
export const CUSTOMERS_QUERY_KEY = ['customers'] as const;

const listeners = new Set<() => void>();

/**
 * A customer was saved or put on an order, or an order was sent (Send's and
 * Pay's customer save, commitCustomerToOrder; Send to kitchen). The answers
 * above are kept 30 seconds (main.tsx), so a phone typed again right after
 * Send or Pay saved its customer still said "No match", and the add-on rule
 * ("Goes with #0009: no second delivery charge") did not show (e2e smoke
 * bug 3, 2 Oct 2026). Now they are asked again the next time a screen shows
 * them. Never throws: a listener's failure is not the sale's.
 */
export function customersChanged(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn('Could not refresh the customer lists (the order is not affected):', e);
    }
  }
}

/**
 * The app's QueryClient marks every ['customers', …] answer out of date on
 * customersChanged (main.tsx, once at start). Answers on screen are asked
 * again at once; the rest when a screen next shows them. Returns the undo.
 */
export function staleCustomersOnSave(qc: QueryClient): () => void {
  const fn = () => void qc.invalidateQueries({ queryKey: CUSTOMERS_QUERY_KEY });
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
