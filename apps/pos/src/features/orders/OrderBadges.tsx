import { cn } from '@cheeseoclock/ui';
import type { OrderMode, OrderStatus } from '@cheeseoclock/shared-types';
import { STATUS_LABELS } from './historyFilters';

const MODE_BADGE: Record<OrderMode, { text: string; tone: string }> = {
  dine_in: { text: 'Dine-in', tone: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-200 dark:ring-sky-800' },
  takeaway: {
    text: 'Takeaway',
    tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:ring-emerald-800',
  },
  delivery: {
    text: 'Delivery',
    tone: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/50 dark:text-violet-200 dark:ring-violet-800',
  },
  online: { text: 'Online', tone: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-800' },
  foodpanda: { text: 'Foodpanda', tone: 'bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-950/50 dark:text-pink-200 dark:ring-pink-800' },
};

export function ModeBadge({ mode }: { mode: OrderMode }) {
  const m = MODE_BADGE[mode] ?? MODE_BADGE.takeaway;
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1',
        m.tone,
      )}
    >
      {m.text}
    </span>
  );
}

const STATUS_TONE: Record<OrderStatus, string> = {
  open: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
  sent_to_kitchen: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  preparing: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  ready: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  out_for_delivery: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  delivered: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-100',
  served: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-100',
  paid: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-100',
  void: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200',
  refunded: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold',
        STATUS_TONE[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/** The words on Live Orders' red strip, and on its button. */
export const TICKET_NOT_PRINTED_TEXT = 'Ticket not printed';
export const TICKET_REPRINT_LABEL = 'Reprint kitchen ticket';

/**
 * A red strip on a Live Orders card whose kitchen ticket this till gave up
 * printing (orders:listActive's kitchenTicketNotPrinted), with Reprint. It
 * goes by itself once a ticket prints, Try again or Reprint is pressed, or
 * the order leaves the kitchen.
 */
export function TicketNotPrinted({ onReprint }: { onReprint: () => void }) {
  return (
    <div className="mt-1.5 flex items-center justify-between rounded-md bg-red-50 px-2 py-1 text-xs font-semibold text-red-800 ring-1 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-800">
      <span>{TICKET_NOT_PRINTED_TEXT}</span>
      <button
        type="button"
        onClick={onReprint}
        aria-label={TICKET_REPRINT_LABEL}
        title={TICKET_REPRINT_LABEL}
        className="shrink-0 rounded-md bg-white px-2.5 py-1 text-xs font-bold text-red-700 ring-1 ring-red-300 transition-colors hover:bg-red-100 dark:bg-red-900/40 dark:text-red-100 dark:ring-red-700 dark:hover:bg-red-900/70"
      >
        Reprint
      </button>
    </div>
  );
}

/** Paid / Not paid chip — the question a cashier asks first. */
export function PaidChip({ paid, className }: { paid: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        paid
          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
          : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
        className,
      )}
    >
      {paid ? 'Paid' : 'Not paid'}
    </span>
  );
}
