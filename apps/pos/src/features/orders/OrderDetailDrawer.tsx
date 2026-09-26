import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import {
  Bike,
  ChefHat,
  CreditCard,
  MapPin,
  Phone,
  Printer,
  Undo2,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { isLeaveOutChoice } from '@cheeseoclock/shared-types';
import type { OrderStatus } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { VoidOrderDialog } from './VoidOrderDialog';
import { RefundOrderDialog } from './RefundOrderDialog';
import { MarkDeliveredDialog } from './MarkDeliveredDialog';
import { ModeBadge, PaidChip, StatusBadge } from './OrderBadges';
import { PAYMENT_LABELS, isOwed, orderTimeLabel, shortOrderNumber } from './historyFilters';

const KITCHEN_STATUSES: readonly OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready'];

interface DrawerProps {
  orderId: string;
  onClose: () => void;
}

/**
 * One order in full, from Order History: what was on it, what was paid, what
 * happened when — plus reprint, collect payment, refund and cancel where the
 * order allows them (the server checks again; manager PIN for refund/cancel).
 */
export function OrderDetailDrawer({ orderId, onClose }: DrawerProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [voidOpen, setVoidOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const dialogOpen = voidOpen || refundOpen || collectOpen;

  const snapQ = useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: () => ipc.orders.get(orderId),
  });
  const snap = snapQ.data;

  // Esc closes the drawer — but not while a dialog on top of it is open
  // (Esc there closes just the dialog).
  useEffect(() => {
    if (dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen, onClose]);

  const errorToast = (title: string) => (e: unknown) =>
    toast({ title, description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });

  const reprintMut = useMutation({
    mutationFn: () => ipc.printer.reprint(orderId),
    onSuccess: () => toast({ title: 'Receipt sent to printer' }),
    onError: errorToast('Reprint failed'),
  });
  const reprintKitchenMut = useMutation({
    mutationFn: () => ipc.printer.reprintKitchen(orderId),
    onSuccess: () => toast({ title: 'Kitchen ticket sent to printer' }),
    onError: errorToast('Reprint failed'),
  });

  const afterChange = (close: () => void) => () => {
    close();
    void qc.invalidateQueries({ queryKey: ['orders'] });
  };

  const o = snap?.order;
  const owed = o ? isOwed(o) : false;
  const canCollect =
    !!o &&
    owed &&
    (o.mode === 'delivery'
      ? o.status === 'ready' || o.status === 'out_for_delivery' || o.status === 'delivered'
      : o.status === 'ready' || o.status === 'served');
  const canRefund = !!o && o.paidAt !== null && o.status !== 'refunded' && o.status !== 'void';
  // Not for an 'open' cart: that is still being rung up at Checkout (it never
  // shows in history, but the guard stays in case one is opened directly).
  const canCancel = !!o && owed && o.status !== 'open';
  const inKitchen = !!o && KITCHEN_STATUSES.includes(o.status);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="Order details"
        className="fixed right-0 top-0 z-50 flex h-full w-[460px] max-w-full flex-col bg-white shadow-soft-lg dark:bg-stone-900"
      >
        <header className="flex items-start justify-between border-b border-stone-200 px-5 py-4 dark:border-stone-700">
          <div className="min-w-0">
            <h3 className="text-xl font-bold">{o ? `Order ${shortOrderNumber(o.orderNumber)}` : '…'}</h3>
            {o && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <ModeBadge mode={o.mode} />
                {o.source === 'web' && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-800">
                    Website
                  </span>
                )}
                <StatusBadge status={o.status} />
                {o.status !== 'void' && o.status !== 'refunded' && <PaidChip paid={o.paidAt !== null} />}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {snapQ.isError ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-red-600">
            Could not open this order. Close and try again.
          </div>
        ) : !snap || !o ? (
          <div className="flex flex-1 items-center justify-center text-sm text-stone-400">Loading…</div>
        ) : (
          <>
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {(snap.customerName || snap.customerPhone || snap.deliveryAddress || snap.rider) && (
                <section className="space-y-1 rounded-xl bg-stone-50 p-3 text-sm dark:bg-stone-800/60">
                  {snap.customerName && (
                    <div className="flex items-center gap-1.5 font-semibold">
                      <UserRound className="h-3.5 w-3.5 text-stone-400" />
                      {snap.customerName}
                    </div>
                  )}
                  {snap.customerPhone && (
                    <div className="flex items-center gap-1.5 font-mono text-xs text-stone-600 dark:text-stone-300">
                      <Phone className="h-3 w-3" />
                      {snap.customerPhone}
                    </div>
                  )}
                  {snap.deliveryAddress && (
                    <div className="flex items-start gap-1.5 text-xs text-stone-600 dark:text-stone-300">
                      <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                      {snap.deliveryAddress}
                    </div>
                  )}
                  {snap.rider && (
                    <div className="mt-1 flex items-center gap-1.5 rounded-md bg-violet-100 px-2 py-1 text-xs text-violet-800 dark:bg-violet-950 dark:text-violet-200">
                      <Bike className="h-3 w-3" />
                      Rider <strong>{snap.rider.name}</strong> · <span className="font-mono">{snap.rider.phone}</span>
                    </div>
                  )}
                </section>
              )}

              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">Items</h4>
                <ul className="space-y-1.5">
                  {snap.items.map((i) => (
                    <li
                      key={i.id}
                      className={cn('flex items-start justify-between gap-2 text-sm', i.parentOrderItemId && 'ml-4 text-stone-500')}
                    >
                      <div className="min-w-0">
                        <div>
                          <span className="font-semibold">{i.quantity}×</span> {i.menuItemName}
                        </div>
                        {i.modifiers.length > 0 && (
                          <ul className="ml-4 text-xs text-stone-500">
                            {i.modifiers.map((m) =>
                              isLeaveOutChoice(m.modifierName) ? (
                                <li key={m.id} className="font-semibold uppercase text-red-700 dark:text-red-300">
                                  {m.modifierName}
                                </li>
                              ) : (
                                <li key={m.id}>+ {m.modifierName}</li>
                              ),
                            )}
                          </ul>
                        )}
                        {i.notes && (
                          <div className="ml-4 text-xs font-semibold text-red-700 dark:text-red-300">Note: {i.notes}</div>
                        )}
                      </div>
                      {(!i.parentOrderItemId || i.lineTotalCents > 0) && (
                        <div className="font-mono text-sm">{formatCents(i.lineTotalCents)}</div>
                      )}
                    </li>
                  ))}
                </ul>
                {o.notes && (
                  <div className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    Order note: {o.notes}
                  </div>
                )}
              </section>

              <dl className="space-y-1 border-t border-stone-200 pt-3 text-sm dark:border-stone-700">
                <Row k="Subtotal" v={formatCents(o.subtotalCents)} />
                {o.discountCents > 0 && (
                  <Row
                    k={discountLabel(snap.discounts.find((d) => d.reason)?.reason)}
                    v={`− ${formatCents(o.discountCents)}`}
                    tone="emerald"
                  />
                )}
                <Row k="Tax" v={formatCents(o.taxCents)} />
                <Row k="Total" v={formatCents(o.totalCents)} emphasize />
              </dl>

              {snap.payments.length > 0 && (
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">Money</h4>
                  <ul className="space-y-1 text-sm">
                    {snap.payments.map((p) => {
                      const refund = p.amountCents < 0;
                      const change =
                        p.method === 'cash' && p.tenderedCents != null && p.tenderedCents > p.amountCents
                          ? p.tenderedCents - p.amountCents
                          : 0;
                      return (
                        <li
                          key={p.id}
                          className={cn(
                            'rounded-md px-2 py-1.5',
                            refund ? 'bg-orange-50 text-orange-900 dark:bg-orange-950/40 dark:text-orange-100' : 'bg-stone-50 dark:bg-stone-800',
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold">
                              {refund ? `Refund · ${PAYMENT_LABELS[p.method]}` : PAYMENT_LABELS[p.method]}
                            </span>
                            <span className="font-mono">
                              {refund ? `− ${formatCents(-p.amountCents)}` : formatCents(p.amountCents)}
                            </span>
                          </div>
                          <div className="text-[11px] text-stone-500 dark:text-stone-400">
                            {orderTimeLabel(p.paidAt)}
                            {change > 0 && ` · given ${formatCents(p.tenderedCents ?? 0)}, change ${formatCents(change)}`}
                            {!refund && p.referenceNo && ` · ref ${p.referenceNo}`}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">What happened</h4>
                <ol className="space-y-1 text-xs text-stone-600 dark:text-stone-300">
                  <Step label="Taken" at={o.createdAt} extra={`by ${snap.cashierName}`} />
                  {o.dispatchedAt && (
                    <Step label="Out with rider" at={o.dispatchedAt} extra={snap.rider ? snap.rider.name : undefined} />
                  )}
                  {o.deliveredAt && <Step label="Delivered" at={o.deliveredAt} />}
                  {o.paidAt && <Step label="Paid" at={o.paidAt} />}
                  {o.voidedAt && (
                    <Step label={o.status === 'refunded' ? 'Refunded' : 'Cancelled'} at={o.voidedAt} />
                  )}
                </ol>
              </section>

              {o.voidReason && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                  <strong>{o.status === 'refunded' ? 'Refund reason:' : 'Cancel reason:'}</strong> {o.voidReason}
                </div>
              )}
            </div>

            <footer className="space-y-2 border-t border-stone-200 px-4 py-3 dark:border-stone-700">
              {canCollect && (
                <Button variant="success" size="md" className="w-full whitespace-nowrap" onClick={() => setCollectOpen(true)}>
                  <CreditCard className="h-4 w-4" />
                  Collect payment · {formatCents(o.totalCents)}
                </Button>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  className="flex-1 whitespace-nowrap"
                  onClick={() => reprintMut.mutate()}
                  disabled={reprintMut.isPending}
                >
                  <Printer className="h-4 w-4" />
                  {reprintMut.isPending ? 'Sending…' : 'Reprint receipt'}
                </Button>
                {inKitchen && (
                  <Button
                    variant="secondary"
                    size="md"
                    className="flex-1 whitespace-nowrap"
                    onClick={() => reprintKitchenMut.mutate()}
                    disabled={reprintKitchenMut.isPending}
                  >
                    <ChefHat className="h-4 w-4" />
                    Kitchen ticket
                  </Button>
                )}
              </div>
              {(canRefund || canCancel) && (
                <div className="flex items-center gap-2">
                  {canRefund && (
                    <Button
                      variant="ghost"
                      size="md"
                      className="flex-1 whitespace-nowrap text-orange-700 hover:bg-orange-50 dark:text-orange-300 dark:hover:bg-orange-950"
                      onClick={() => setRefundOpen(true)}
                    >
                      <Undo2 className="h-4 w-4" />
                      Refund…
                    </Button>
                  )}
                  {canCancel && (
                    <Button
                      variant="ghost"
                      size="md"
                      className="flex-1 whitespace-nowrap text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                      onClick={() => setVoidOpen(true)}
                    >
                      <XCircle className="h-4 w-4" />
                      Cancel order…
                    </Button>
                  )}
                </div>
              )}
            </footer>
          </>
        )}
      </aside>

      {voidOpen && snap && (
        <VoidOrderDialog snap={snap} onClose={() => setVoidOpen(false)} onDone={afterChange(() => setVoidOpen(false))} />
      )}
      {refundOpen && snap && (
        <RefundOrderDialog snap={snap} onClose={() => setRefundOpen(false)} onDone={afterChange(() => setRefundOpen(false))} />
      )}
      {collectOpen && snap && (
        <MarkDeliveredDialog snap={snap} onClose={() => setCollectOpen(false)} onDone={afterChange(() => setCollectOpen(false))} />
      )}
    </>
  );
}

function discountLabel(reason: string | null | undefined): string {
  return reason ? `Discount (${reason})` : 'Discount';
}

function Row({ k, v, tone, emphasize }: { k: string; v: string; tone?: 'emerald'; emphasize?: boolean }) {
  return (
    <div
      className={cn(
        'flex justify-between gap-3',
        emphasize && 'rounded-md bg-amber-50 px-2 py-1.5 text-base font-bold dark:bg-amber-950/60',
        tone === 'emerald' && 'text-emerald-700 dark:text-emerald-300',
      )}
    >
      <dt className="text-stone-600 dark:text-stone-300">{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}

function Step({ label, at, extra }: { label: string; at: string; extra?: string | undefined }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 font-semibold text-stone-700 dark:text-stone-200">{label}</span>
      <span>
        {orderTimeLabel(at)}
        {extra ? ` · ${extra}` : ''}
      </span>
    </li>
  );
}
