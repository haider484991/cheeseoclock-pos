/**
 * The screen's copy of the pending order alerts (see alertState.ts for the
 * rules). One store for the whole app, so the Live Orders board can mark
 * orders seen and the banner anywhere reacts.
 *
 * Every "seen / silenced / closed" also goes to the main process, which keeps
 * the list across a reload of the screen. Those calls are fire-and-forget:
 * a failed one must never leave the chime ringing on screen.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { AcknowledgeAlertsRequest, ImportFailureAlert, OnlineOrderAlert, PendingAlerts } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import {
  EMPTY_ALERT_STATE,
  acknowledgeOrders,
  applySnapshot,
  closeFailure,
  markRang,
  markTicketFailed,
  receiveFailure,
  receiveOrder,
  seenOnScreen,
  type AlertState,
} from './alertState';

export const useAlertStore = create<{ state: AlertState }>(() => ({ state: EMPTY_ALERT_STATE }));

function update(fn: (s: AlertState) => AlertState): void {
  const current = useAlertStore.getState().state;
  const next = fn(current);
  if (next !== current) useAlertStore.setState({ state: next });
}

function tellMainProcess(req: AcknowledgeAlertsRequest): void {
  try {
    void ipc.alerts.acknowledge(req).catch(() => undefined);
  } catch {
    // an older main process without the channel: the screen still goes quiet
  }
}

export const alerts = {
  getState(): AlertState {
    return useAlertStore.getState().state;
  },
  receiveOrder(p: Partial<OnlineOrderAlert> & { orderId: string }): void {
    update((s) => receiveOrder(s, p, Date.now()));
  },
  receiveFailure(f: ImportFailureAlert): void {
    update((s) => receiveFailure(s, f, Date.now()));
  },
  applySnapshot(p: PendingAlerts, requestedAt: number): void {
    update((s) => applySnapshot(s, p, requestedAt, Date.now()));
  },
  markTicketFailed(orderId: string): void {
    update((s) => markTicketFailed(s, orderId));
  },
  markRang(now: number): void {
    update((s) => markRang(s, now));
  },
  /** Seen (any row, the pill) / Esc: only the row on screen — see seenOnScreen. */
  seen(): void {
    const now = Date.now();
    let orderIds: string[] = [];
    let failureIds: string[] = [];
    update((s) => {
      const r = seenOnScreen(s, now);
      orderIds = r.orderIds;
      failureIds = r.failureIds;
      return r.state;
    });
    if (orderIds.length > 0 || failureIds.length > 0) {
      tellMainProcess({ orderIds, silenceFailureIds: failureIds });
    }
  },
  /** View, or Live Orders opened: every pending order has been looked at. */
  acknowledgeAllOrders(): void {
    let orderIds: string[] = [];
    update((s) => {
      const a = acknowledgeOrders(s, Date.now(), { all: true });
      orderIds = a.orderIds;
      return a.state;
    });
    if (orderIds.length > 0) tellMainProcess({ orderIds });
  },
  /** Someone logged in has called the customer: take the card away. */
  closeFailure(webOrderId: string): void {
    update((s) => closeFailure(s, webOrderId));
    tellMainProcess({ closeFailureIds: [webOrderId], silenceFailureIds: [webOrderId] });
  },
};

/** Opening Live Orders counts as seeing every new online order on it. */
export function useAcknowledgeOnlineOrders(): void {
  useEffect(() => {
    alerts.acknowledgeAllOrders();
  }, []);
}

// ---------------------------------------------------------------------------
// Waiting reminders already given (per session: a reload must not repeat them)

const REMINDED_KEY = 'coc.alerts.reminded.v1';
const REMINDED_LIMIT = 300;

export function loadReminded(): Set<string> {
  try {
    const raw = sessionStorage.getItem(REMINDED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveReminded(keys: ReadonlySet<string>): void {
  try {
    const list = [...keys];
    sessionStorage.setItem(REMINDED_KEY, JSON.stringify(list.slice(Math.max(0, list.length - REMINDED_LIMIT))));
  } catch {
    // storage unavailable: at worst a reminder repeats after a reload
  }
}
