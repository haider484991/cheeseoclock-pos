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
  Trash2,
  Undo2,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { discountLeavesDeliveryCharge, discountLeavesNoDiscountItems, isLeaveOutChoice, orderNotesOf } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { failedRetryToast, reprintReceipt, reprintToast } from '../printing/reprint';
import { paperButtonLabel } from '../printing/paperLabels';
import { PapersPrinted } from '../printing/PapersPrinted';
import { useToast } from '../../components/toast/ToastProvider';
import { VoidOrderDialog } from './VoidOrderDialog';
import { DeleteTestOrderDialog } from './DeleteTestOrderDialog';
import { mayDeleteTestOrder } from './testDeleteCopy';
import { useSessionStore } from '../../stores/sessionStore';
import { RefundOrderDialog } from './RefundOrderDialog';
import { MarkDeliveredDialog } from './MarkDeliveredDialog';
import { drawerDiscountLabel } from '../checkout/discountWords';
import { CameByRow } from './CameByRow';
import { ModeBadge, PaidChip, StatusBadge } from './OrderBadges';
import { PAYMENT_LABELS, isOwed, orderTimeLabel, shortOrderNumber } from './historyFilters';
import { historyStockStep } from './stockCopy';
import { offersKitchenReprint, sentStepAt } from './boardLogic';

interface DrawerProps {
  orderId: string;
  onClose: () => void;
}

/**
 * One order in full, from Order History: what was on it, what was paid, what
 * happened when — plus reprint, collect payment, refund and cancel where the
 * order allows them (the server checks again; a manager's PIN or password for
 * refund/cancel).
 */
export function OrderDetailDrawer({ orderId, onClose }: DrawerProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [voidOpen, setVoidOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const dialogOpen = voidOpen || refundOpen || collectOpen || deleteOpen;
  // "Delete test order…" is the owner's alone (the main process checks again,
  // and asks for the owner's PIN or password in the dialog).
  const role = useSessionStore((st) => st.user?.role ?? null);

  const snapQ = useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: () => ipc.orders.get(orderId),
  });
  const snap = snapQ.data;
  // What cancelling did to its stock (or would do): only worth a read once the
  // order has ended. Under ['orders'], so a cancel / refund refreshes it.
  const ended = snap?.order.status === 'void' || snap?.order.status === 'refunded';
  const stockQ = useQuery({
    queryKey: ['orders', 'stock', orderId],
    queryFn: () => ipc.orders.stockStatus(orderId),
    enabled: ended,
  });
  const stockStep = ended && stockQ.data ? historyStockStep(stockQ.data) : null;
  // What the print button would print (and whether that is the original),
  // and every paper the order had. Under ['orders']: a cancel or refund
  // refreshes it; while a paper waits for the printer it is read again.
  const papersQ = useQuery({
    queryKey: ['orders', 'papers', orderId],
    queryFn: () => ipc.printer.orderPapers(orderId),
    enabled: !!snap && snap.order.status !== 'open',
    refetchInterval: (q) => (q.state.data?.next?.waiting ? 1_500 : false),
  });
  const papers = papersQ.data?.papers ?? [];

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

  // The paper goes into the print log once the printer took it: read the
  // papers again now (it is waiting) and shortly after.
  const refreshPapers = () => {
    void papersQ.refetch();
    setTimeout(() => void papersQ.refetch(), 2_000);
  };
  const reprintMut = useMutation({
    mutationFn: () => reprintReceipt(orderId),
    onSuccess: (r) => {
      toast({ title: reprintToast(r) });
      refreshPapers();
    },
    onError: errorToast('Print failed'),
  });
  // The till's own paper failed and nothing came since: the button sends that
  // job again — the original, like "Try again" on the failed-print note —
  // even after the note was closed or the till restarted.
  const failedNext = papersQ.data?.next?.failedJobId ? papersQ.data.next : null;
  const retryFailedMut = useMutation({
    mutationFn: (jobId: string) => ipc.printer.retryJob(jobId),
    onSuccess: (r) => {
      toast({ title: failedRetryToast(failedNext?.document ?? 'receipt', r.requeued) });
      refreshPapers();
    },
    onError: errorToast('Print failed'),
  });
  const printPaper = () => {
    if (failedNext?.failedJobId) retryFailedMut.mutate(failedNext.failedJobId);
    else reprintMut.mutate();
  };
  const reprintKitchenMut = useMutation({
    mutationFn: () => ipc.printer.reprintKitchen(orderId),
    onSuccess: (r) => {
      toast({ title: reprintToast(r) });
      refreshPapers();
    },
    onError: errorToast('Reprint failed'),
  });

  const afterChange = (close: () => void) => () => {
    close();
    void qc.invalidateQueries({ queryKey: ['orders'] });
  };

  const o = snap?.order;
  const owed = o ? isOwed(o) : false;
  // "Sent" in What happened: when it went to the kitchen, if that was a minute or more after it was started.
  const sentAt = o ? sentStepAt(o) : null;
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
  const inKitchen = !!o && offersKitchenReprint(o.status);
  const canDeleteTest = mayDeleteTestOrder(role, o?.status);

  // A deleted test order is gone from every list, shift, stock figure and
  // report: read them all again, and close this panel.
  const afterDelete = () => {
    setDeleteOpen(false);
    for (const key of ['orders', 'shifts', 'inventory', 'customers', 'reports', 'costing'] as const) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
    onClose();
  };

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

              {/* How a counter order came in (locked at send; a manager changes it, audited). */}
              <CameByRow snap={snap} />

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
                {/* The counter's "Order notes" and a website customer's note, as the ticket and bill print them. */}
                {orderNotesOf(snap).map((note) => (
                  <div
                    key={note}
                    className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    Order note: {note}
                  </div>
                ))}
              </section>

              <dl className="space-y-1 border-t border-stone-200 pt-3 text-sm dark:border-stone-700">
                <Row k="Subtotal" v={formatCents(o.subtotalCents)} />
                {o.discountCents > 0 && (
                  <Row
                    k={drawerDiscountLabel(
                      snap.discounts.find((d) => d.reason)?.reason,
                      discountLeavesDeliveryCharge(snap.discounts[snap.discounts.length - 1], snap.items),
                      // One of the owner's automatic offers: by its name, as the bill prints it.
                      snap.discounts[snap.discounts.length - 1]?.source === 'offer' ? snap.discounts[snap.discounts.length - 1]?.reason : null,
                      // "not on value deals": its own frozen rule left the deals on this order alone.
                      discountLeavesNoDiscountItems(snap.discounts[snap.discounts.length - 1], snap.items),
                    )}
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
                  {/* When it went to the kitchen (0048): hidden when that came within a minute of
                      starting, so a quick Pay does not show the same time twice. */}
                  {sentAt && <Step label="Sent" at={sentAt} />}
                  {o.dispatchedAt && (
                    <Step label="Out with rider" at={o.dispatchedAt} extra={snap.rider ? snap.rider.name : undefined} />
                  )}
                  {o.deliveredAt && <Step label="Delivered" at={o.deliveredAt} />}
                  {o.paidAt && <Step label="Paid" at={o.paidAt} />}
                  {o.voidedAt && (
                    <Step label={o.status === 'refunded' ? 'Refunded' : 'Cancelled'} at={o.voidedAt} />
                  )}
                  {stockStep && (
                    <Step
                      label={stockStep.label}
                      at={stockQ.data?.settledAt ?? o.voidedAt ?? null}
                      extra={stockStep.extra || undefined}
                    />
                  )}
                </ol>
              </section>

              {o.voidReason && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                  <strong>{o.status === 'refunded' ? 'Refund reason:' : 'Cancel reason:'}</strong> {o.voidReason}
                </div>
              )}

              <PapersPrinted papers={papers} orderCreatedAt={o.createdAt} />
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
                  onClick={printPaper}
                  disabled={reprintMut.isPending || retryFailedMut.isPending}
                  title="Print bill or receipt"
                >
                  <Printer className="h-4 w-4" />
                  {reprintMut.isPending || retryFailedMut.isPending ? 'Sending…' : paperButtonLabel(papersQ.data?.next)}
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
              {canDeleteTest && (
                <div className="flex items-center border-t border-stone-100 pt-2 dark:border-stone-800">
                  <Button
                    variant="ghost"
                    size="md"
                    className="w-full whitespace-nowrap text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete test order…
                  </Button>
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
      {deleteOpen && snap && (
        <DeleteTestOrderDialog snap={snap} onClose={() => setDeleteOpen(false)} onDone={afterDelete} />
      )}
      {collectOpen && snap && (
        <MarkDeliveredDialog snap={snap} onClose={() => setCollectOpen(false)} onDone={afterChange(() => setCollectOpen(false))} />
      )}
    </>
  );
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

function Step({ label, at, extra }: { label: string; at: string | null; extra?: string | undefined }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 font-semibold text-stone-700 dark:text-stone-200">{label}</span>
      <span>
        {at ? orderTimeLabel(at) : ''}
        {extra ? `${at ? ' · ' : ''}${extra}` : ''}
      </span>
    </li>
  );
}
