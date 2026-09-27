/**
 * The Costing page's queries, shared with the cost chip in Menu → Items and
 * the costs shown in Inventory → Recipes. Costs are worked out from today's
 * prices on every read, and prices change in Inventory, so each read goes
 * back to the till (no 30-second cache like the rest of the app).
 */
import { useQuery } from '@tanstack/react-query';
import { COST_CAPABILITY } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/sessionStore';

export const COSTING_KEY = ['costing'] as const;

/** May this login see costs (COST_CAPABILITY)? The main process refuses the rest anyway. */
export function useCanSeeCosts(): boolean {
  return useSessionStore((s) => s.can(COST_CAPABILITY));
}

export function useMenuCosts(enabled = true) {
  return useQuery({
    queryKey: [...COSTING_KEY, 'menuCosts'],
    queryFn: () => ipc.costing.menuCosts(),
    enabled,
    staleTime: 0,
  });
}

export function useMissingCosts(enabled = true) {
  return useQuery({
    queryKey: [...COSTING_KEY, 'missing'],
    queryFn: () => ipc.costing.missingCosts(),
    enabled,
    staleTime: 0,
  });
}

export function useCostingTargets() {
  return useQuery({
    queryKey: [...COSTING_KEY, 'targets'],
    queryFn: () => ipc.costing.getTargets(),
    staleTime: 0,
  });
}

export function useItemCostSheet(menuItemId: string) {
  return useQuery({
    queryKey: [...COSTING_KEY, 'sheet', menuItemId],
    queryFn: () => ipc.costing.itemSheet(menuItemId),
    staleTime: 0,
  });
}

/** Costing → Alerts (Phase 6): not seen yet first; the tab's badge counts the unseen. */
export function useCostAlerts(enabled = true) {
  return useQuery({
    queryKey: [...COSTING_KEY, 'alerts'],
    queryFn: () => ipc.costing.alerts(),
    enabled,
    staleTime: 0,
  });
}

/** The alert thresholds and key ingredients; the purchase screens read the price-jump band too (D1). */
export function useCostAlertSettings(enabled = true) {
  return useQuery({
    queryKey: [...COSTING_KEY, 'alertSettings'],
    queryFn: () => ipc.costing.getAlertSettings(),
    enabled,
    staleTime: 0,
  });
}
