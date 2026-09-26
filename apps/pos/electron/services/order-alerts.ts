import {
  fulfilmentLabel,
  orderNumberList,
  shortOrderNumber,
  type AcknowledgeAlertsRequest,
  type ImportFailureAlert,
  type ImportFailureReason,
  type OnlineOrderAlert,
  type PendingAlerts,
} from '@cheeseoclock/shared-types';

/**
 * The till's list of website orders nobody has looked at yet, and website
 * orders that did not come in.
 *
 * It lives in the main process, next to the website bridge, because the
 * bridge starts before the screen does: an order imported in the first
 * seconds after a restart (or while the screen is reloading after a crash)
 * used to land silently on the board. The screen asks for this list when it
 * starts and keeps it in step; the main process also flashes the taskbar and
 * shows the Windows notice itself, so that works even when the screen is not
 * answering.
 *
 * Pure: Electron, the database and the clock come in through `deps` (see
 * order-alerts-hub.ts for the real ones), so the rules are unit-tested.
 * Nothing here throws — a problem with an alert must never break an import.
 */

/** What the website bridge sends when a web order is on the board. */
export interface ReceivedWebOrder {
  orderId: string;
  orderNumber: string;
  customerName: string;
  webOrderId?: string;
  fulfilment?: 'delivery' | 'pickup';
  totalCents?: number | null;
  totalMismatch?: { webTotalCents: number; tillTotalCents: number };
}

/** What the website bridge sends when a web order could not be imported. */
export interface FailedWebOrder {
  webOrderId: string;
  customerName: string;
  message: string;
  customerPhone?: string | null;
  final?: boolean;
  reason?: ImportFailureReason;
}

export interface AttentionNotice {
  kind: 'newOrder' | 'importFailed';
  title: string;
  body: string;
}

export interface OrderAlertsDeps {
  now(): number;
  /**
   * Of these orders, the ones still waiting to be started ('sent_to_kitchen').
   * Null when the database cannot say (not open yet).
   */
  stillWaiting(orderIds: readonly string[]): ReadonlySet<string> | null;
  /** Flash the taskbar + Windows notice — only if the till is not in front (the caller decides). */
  requestAttention(notice: AttentionNotice): void;
  clearAttention(): void;
  formatMoney(cents: number): string;
  warn(message: string, detail?: unknown): void;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** Most alerts kept (oldest go first). */
export const MAX_ORDER_ALERTS = 50;
export const MAX_FAILURE_ALERTS = 50;
/** An order the database cannot check is forgotten after an hour. */
export const UNCHECKED_ORDER_TTL_MS = 60 * 60_000;
/** A failure card nobody closed goes after 12 hours (the next day's shift). */
export const FAILURE_TTL_MS = 12 * 60 * 60_000;
/** Orders from one check of the website share one Windows notice. */
export const NOTICE_DEBOUNCE_MS = 1_000;
/** Ids already seen, so a repeated event does not ring again. */
export const SEEN_LIMIT = 500;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function text(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export class OrderAlertsHub {
  private readonly orders = new Map<string, OnlineOrderAlert>();
  private readonly failures = new Map<string, ImportFailureAlert>();
  /** Orders acknowledged or moved along; failure cards closed. Bounded, oldest out. */
  private readonly seen = new Set<string>();
  private noticeHandle: unknown = null;

  constructor(private readonly deps: OrderAlertsDeps) {}

  /** A website order is on the board. Called by the bridge right after it tells the screen. */
  orderReceived(p: ReceivedWebOrder): void {
    try {
      if (!p || typeof p.orderId !== 'string' || !p.orderId) return;
      if (this.seen.has(`o:${p.orderId}`) || this.orders.has(p.orderId)) return;
      const alert: OnlineOrderAlert = {
        orderId: p.orderId,
        orderNumber: text(p.orderNumber, p.orderId),
        customerName: text(p.customerName),
        webOrderId: typeof p.webOrderId === 'string' ? p.webOrderId : null,
        fulfilment: p.fulfilment === 'pickup' || p.fulfilment === 'delivery' ? p.fulfilment : null,
        totalCents: typeof p.totalCents === 'number' && Number.isFinite(p.totalCents) ? p.totalCents : null,
        totalMismatch: p.totalMismatch ?? null,
        receivedAt: isoAt(this.deps.now()),
      };
      this.orders.set(alert.orderId, alert);
      while (this.orders.size > MAX_ORDER_ALERTS) {
        const oldest = this.orders.keys().next().value;
        if (oldest === undefined) break;
        this.orders.delete(oldest);
      }
      // A retry that worked: that order is not "did not come in" any more.
      if (alert.webOrderId) this.failures.delete(alert.webOrderId);
      this.scheduleNotice();
    } catch (e) {
      this.deps.warn('Order alert not recorded', e);
    }
  }

  /**
   * A website order did not come in. Only a final failure is kept: while the
   * till is still retrying, telling staff to "call the customer" is how an
   * order got cooked twice (audit 2026-09-25). One card per website order.
   */
  importFailed(p: FailedWebOrder): void {
    try {
      if (!p || typeof p.webOrderId !== 'string' || !p.webOrderId || p.final !== true) return;
      if (this.failures.has(p.webOrderId) || this.seen.has(`f:${p.webOrderId}`)) return;
      const reason: ImportFailureReason =
        p.reason === 'gave_up' || p.reason === 'stale' ? p.reason : 'error';
      this.failures.set(p.webOrderId, {
        webOrderId: p.webOrderId,
        customerName: text(p.customerName),
        customerPhone: typeof p.customerPhone === 'string' && p.customerPhone.trim() ? p.customerPhone.trim() : null,
        message: text(p.message),
        reason,
        // Came in while the till was off: the website already told the
        // customer to call. A card, no alarm.
        silenced: reason === 'stale',
        at: isoAt(this.deps.now()),
      });
      while (this.failures.size > MAX_FAILURE_ALERTS) {
        const oldest = this.failures.keys().next().value;
        if (oldest === undefined) break;
        this.failures.delete(oldest);
      }
      if (reason !== 'stale') this.scheduleNotice();
    } catch (e) {
      this.deps.warn('Import-failure alert not recorded', e);
    }
  }

  /** Everything still waiting for someone, oldest first. Orders that moved along drop out here. */
  pending(): PendingAlerts {
    try {
      this.prune();
    } catch (e) {
      this.deps.warn('Order alerts not checked', e);
    }
    return {
      orders: [...this.orders.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
      failures: [...this.failures.values()].sort((a, b) => a.at.localeCompare(b.at)),
    };
  }

  /** Seen / silenced / closed. Closing a failure card needs someone logged in. */
  acknowledge(req: AcknowledgeAlertsRequest, opts: { loggedIn: boolean }): PendingAlerts {
    try {
      for (const id of req?.orderIds ?? []) {
        if (typeof id !== 'string') continue;
        this.orders.delete(id);
        this.remember(`o:${id}`);
      }
      for (const id of req?.silenceFailureIds ?? []) {
        const f = typeof id === 'string' ? this.failures.get(id) : undefined;
        if (f) f.silenced = true;
      }
      if (opts.loggedIn) {
        for (const id of req?.closeFailureIds ?? []) {
          if (typeof id !== 'string') continue;
          this.failures.delete(id);
          this.remember(`f:${id}`);
        }
      }
      this.afterChange();
    } catch (e) {
      this.deps.warn('Order alerts not acknowledged', e);
    }
    return this.pending();
  }

  /** True while something should be ringing: an unseen order or an unsilenced failure. */
  isLoud(): boolean {
    if (this.orders.size > 0) return true;
    for (const f of this.failures.values()) if (!f.silenced) return true;
    return false;
  }

  /** The words for the Windows notice, from what is pending right now. */
  notice(): AttentionNotice | null {
    const loudFailures = [...this.failures.values()].filter((f) => !f.silenced);
    const orders = [...this.orders.values()];
    if (loudFailures.length > 0) {
      const first = loudFailures[0]!;
      const also = orders.length > 0 ? ` Also ${orders.length} new online order${orders.length === 1 ? '' : 's'}.` : '';
      return {
        kind: 'importFailed',
        title:
          loudFailures.length === 1
            ? `Website order from ${first.customerName || 'a customer'} did not come in`
            : `${loudFailures.length} website orders did not come in`,
        body: `Open the till and call the customer.${also}`,
      };
    }
    if (orders.length === 0) return null;
    if (orders.length === 1) {
      const o = orders[0]!;
      const parts = [
        fulfilmentLabel(o.fulfilment),
        o.totalCents !== null ? this.deps.formatMoney(o.totalCents) : null,
        o.customerName || null,
      ].filter((s): s is string => !!s);
      return {
        kind: 'newOrder',
        title: `New online order ${shortOrderNumber(o.orderNumber)}`,
        body: `${parts.length > 0 ? `${parts.join(' · ')} — ` : ''}click to open the till`,
      };
    }
    return {
      kind: 'newOrder',
      title: `${orders.length} new online orders`,
      body: `${orderNumberList(orders.map((o) => o.orderNumber))} — click to open the till`,
    };
  }

  private remember(key: string): void {
    this.seen.delete(key);
    this.seen.add(key);
    while (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /** Drop orders someone moved along (started, voided, done) and very old cards. */
  private prune(): void {
    const now = this.deps.now();
    let changed = false;
    const ids = [...this.orders.keys()];
    if (ids.length > 0) {
      let waiting: ReadonlySet<string> | null = null;
      try {
        waiting = this.deps.stillWaiting(ids);
      } catch (e) {
        this.deps.warn('Could not check order status for alerts', e);
      }
      for (const [id, o] of this.orders) {
        const gone = waiting
          ? !waiting.has(id)
          : now - Date.parse(o.receivedAt) > UNCHECKED_ORDER_TTL_MS;
        if (gone) {
          this.orders.delete(id);
          this.remember(`o:${id}`);
          changed = true;
        }
      }
    }
    for (const [id, f] of this.failures) {
      if (now - Date.parse(f.at) > FAILURE_TTL_MS) {
        this.failures.delete(id);
        changed = true;
      }
    }
    if (changed) this.afterChange();
  }

  private afterChange(): void {
    if (this.isLoud()) return;
    if (this.noticeHandle !== null) {
      this.deps.cancel(this.noticeHandle);
      this.noticeHandle = null;
    }
    this.deps.clearAttention();
  }

  /** One notice per batch: later orders update it after a short pause. */
  private scheduleNotice(): void {
    if (this.noticeHandle !== null) this.deps.cancel(this.noticeHandle);
    this.noticeHandle = this.deps.schedule(() => {
      this.noticeHandle = null;
      try {
        const n = this.notice();
        if (n) this.deps.requestAttention(n);
      } catch (e) {
        this.deps.warn('Windows notice not shown', e);
      }
    }, NOTICE_DEBOUNCE_MS);
  }
}
