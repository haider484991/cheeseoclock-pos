import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import { isLeaveOutChoice, paperCashierName } from '@cheeseoclock/shared-types';
import { CheckCircle2, Printer, Hourglass, ShieldCheck, AlertTriangle } from 'lucide-react';
import { ipc, onFbrQueueChanged } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { failedRetryToast, reprintReceipt, reprintToast } from '../printing/reprint';
import { paperButtonLabel } from '../printing/paperLabels';
import { isOfferTakenOff, receiptDiscountLabel } from './discountWords';
import { receiptDialogShop } from './receiptDialogShop';

interface Props {
  snapshot: OrderSnapshot;
  onClose: () => void;
}

const MODE_LABEL = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  online: 'Online',
  foodpanda: 'Foodpanda',
} as const;

const METHOD_LABEL = {
  cash: 'Cash',
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank',
  foodpanda: 'Foodpanda',
} as const;

export function ReceiptDialog({ snapshot, onClose }: Props) {
  const { order, items, payments, discounts, tableLabel } = snapshot;
  const [reprinting, setReprinting] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const newOrderRef = useRef<HTMLButtonElement>(null);
  // The change to hand back, big, before anything else (cash only).
  // Change is the cash handed over less the CASH part (as on the printed receipt).
  const cashLeg = payments.find((p) => p.method === 'cash' && p.tenderedCents != null) ?? null;
  const tenderedCents = cashLeg?.tenderedCents ?? null;
  const changeCents = cashLeg && tenderedCents != null ? Math.max(0, tenderedCents - cashLeg.amountCents) : 0;

  const fbrQ = useQuery({
    queryKey: ['fbr', 'status', order.id],
    queryFn: () => ipc.fbr.getInvoiceStatus(order.id),
    refetchInterval: (q) => (q.state.data?.status === 'sent' ? false : 3_000),
  });
  // Worker broadcasts when the queue changes — refresh immediately.
  useEffect(
    () =>
      onFbrQueueChanged(() => {
        void qc.invalidateQueries({ queryKey: ['fbr', 'status', order.id] });
      }),
    [qc, order.id],
  );

  // What the print button would print: the receipt printing now ("Printing…"),
  // one already out ("Reprint receipt"), or — a delivery whose bill prints
  // when the rider leaves — nothing yet. Pressed by hand, the paper always
  // says DUPLICATE (the owner's rule): the original is the one the till
  // prints by itself, here when the rider leaves.
  const papersQ = useQuery({
    queryKey: ['orders', 'papers', order.id],
    queryFn: () => ipc.printer.orderPapers(order.id),
    refetchInterval: (q) => (q.state.data?.next?.waiting ? 1_500 : false),
  });
  // This till's printers, what prints when, and the shop's receipt lines
  // (name, tagline, thank-you and extra lines: Settings → Shop & logo).
  const policyQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
    staleTime: 60_000,
  });
  const shop = receiptDialogShop(policyQ.data?.branding);
  const next = papersQ.data?.next ?? null;
  const receiptNotYetPrinted =
    order.mode === 'delivery' &&
    !order.dispatchedAt &&
    policyQ.data?.policy.deliveryBillOnDispatch === true &&
    next?.document === 'receipt' &&
    next.printedBefore === 0 &&
    !next.waiting;
  const buttonLabel = receiptNotYetPrinted ? 'Print receipt now' : paperButtonLabel(next);

  async function reprint() {
    setReprinting(true);
    try {
      if (next?.failedJobId) {
        // The receipt the till printed by itself failed: send THAT again —
        // it is the original the customer never got.
        const r = await ipc.printer.retryJob(next.failedJobId);
        toast({ title: failedRetryToast(next.document, r.requeued), variant: r.requeued ? 'success' : 'info' });
      } else {
        // Printed by hand: it says DUPLICATE (the one the till printed by
        // itself is the original); after the cashier's one copy, a manager.
        toast({ title: reprintToast(await reprintReceipt(order.id)), variant: 'success' });
      }
      void papersQ.refetch();
      setTimeout(() => void papersQ.refetch(), 2_000);
    } catch (e) {
      toast({
        title: 'Reprint failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    } finally {
      setReprinting(false);
    }
  }
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          // Enter (or Esc) starts the next order straight away.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            newOrderRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[400px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900 dark:text-stone-100"
        >
          <header className="flex items-center justify-center gap-2 border-b border-stone-200 p-4 dark:border-stone-800">
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            <Dialog.Title className="text-lg font-bold">Payment received</Dialog.Title>
          </header>
          {changeCents > 0 && (
            <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-center dark:border-emerald-800 dark:bg-emerald-950" role="status">
              <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Give change</div>
              <div className="font-mono text-3xl font-bold text-emerald-900 dark:text-emerald-50">{formatCents(changeCents)}</div>
            </div>
          )}

          <div className="flex-1 overflow-auto p-5 font-mono text-sm">
            <div className="text-center">
              {shop.name && <div className="break-words text-xl font-bold">{shop.name}</div>}
              {shop.tagline && <div className="break-words text-xs text-stone-500">{shop.tagline}</div>}
              <div className="mt-3 text-xs text-stone-500">{new Date(order.paidAt ?? Date.now()).toLocaleString()}</div>
              <div className="text-xs">
                Cashier: {paperCashierName(snapshot)} · {MODE_LABEL[order.mode]}
                {tableLabel ? ` · ${tableLabel}` : ''}
              </div>
              <div className="text-xs text-stone-500">Order #{order.orderNumber}</div>
            </div>

            <hr className="my-3 border-stone-300 dark:border-stone-700" />

            {items.map((it) => (
              <div key={it.id} className="mb-2">
                <div className="flex justify-between">
                  <span>
                    {it.quantity}× {it.menuItemName}
                  </span>
                  <span>{formatCents(it.lineTotalCents, { showSymbol: false })}</span>
                </div>
                {it.modifiers.map((m) => (
                  <div key={m.id} className="ml-3 text-xs text-stone-500">
                    {isLeaveOutChoice(m.modifierName) ? '' : '+ '}
                    {m.modifierName}
                    {m.priceDeltaCents !== 0 && (
                      <span> ({formatCents(m.priceDeltaCents, { showSymbol: false })})</span>
                    )}
                  </div>
                ))}
                {it.notes && <div className="ml-3 text-xs font-semibold text-amber-800 dark:text-amber-300">Note: {it.notes}</div>}
              </div>
            ))}

            <hr className="my-3 border-stone-300 dark:border-stone-700" />

            <div className="space-y-1">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatCents(order.subtotalCents, { showSymbol: false })}</span>
              </div>
              {/* An automatic offer the cashier took off takes nothing off: no line (as on the printed bill). */}
              {discounts.filter((d) => !isOfferTakenOff(d)).map((d) => (
                <div key={d.id} className="flex justify-between text-emerald-700 dark:text-emerald-300">
                  {/* "(10%, food only)" when the discount's own frozen rule left the delivery charge alone. */}
                  <span>{receiptDiscountLabel(d, items)}</span>
                  <span>−{formatCents(d.amountCents, { showSymbol: false })}</span>
                </div>
              ))}
              <div className="flex justify-between">
                <span>Tax</span>
                <span>{formatCents(order.taxCents, { showSymbol: false })}</span>
              </div>
              <div className="flex justify-between border-t border-stone-300 pt-1 text-base font-bold dark:border-stone-700">
                <span>Total</span>
                <span>Rs {formatCents(order.totalCents, { showSymbol: false })}</span>
              </div>
            </div>

            <hr className="my-3 border-stone-300 dark:border-stone-700" />

            {payments.map((p) => (
              <div key={p.id} className="flex justify-between text-xs">
                <span>{METHOD_LABEL[p.method]}</span>
                <span>{formatCents(p.amountCents, { showSymbol: false })}</span>
              </div>
            ))}
            {tenderedCents != null && (
              <>
                <div className="flex justify-between text-xs">
                  <span>Tendered</span>
                  <span>{formatCents(tenderedCents, { showSymbol: false })}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Change</span>
                  <span>{formatCents(changeCents, { showSymbol: false })}</span>
                </div>
              </>
            )}

            <hr className="my-3 border-stone-300 dark:border-stone-700" />

            <div className="mt-3 text-center text-xs text-stone-500">
              <div className="break-words">{shop.thanks}</div>
              {shop.extraLines.map((l, i) => (
                <div key={i} className="break-words">
                  {l}
                </div>
              ))}
            </div>
            <FbrBlock status={fbrQ.data} />
          </div>

          {receiptNotYetPrinted && (
            <p className="border-t border-stone-200 px-4 pt-3 text-xs text-stone-600 dark:border-stone-800 dark:text-stone-300">
              Printed now, this receipt says DUPLICATE. The original prints by itself when the rider leaves.
            </p>
          )}
          <footer className="flex gap-2 border-t border-stone-200 p-4 dark:border-stone-800">
            <Button ref={newOrderRef} variant="primary" size="lg" className="flex-[2]" onClick={onClose}>
              New order
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="flex-1 whitespace-nowrap"
              disabled={reprinting}
              onClick={reprint}
              title={fbrQ.data?.status === 'sent' ? 'Print the receipt (with the FBR number)' : 'Print bill or receipt'}
            >
              <Printer className="h-4 w-4" />
              {reprinting ? 'Sending…' : buttonLabel}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FbrBlock({
  status,
}: {
  status?: {
    status: 'none' | 'pending' | 'sent' | 'failed' | 'skipped';
    attempts: number;
    lastError?: string | null;
    irn?: string | null;
    qrPayload?: string | null;
  };
}) {
  if (!status || status.status === 'none' || status.status === 'skipped') {
    return null;
  }
  if (status.status === 'sent' && status.irn) {
    return (
      <div className="mt-2 rounded border-2 border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
        <div className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3 w-3" />
          FBR Digital Invoice
        </div>
        <div className="mt-1 break-all font-mono text-xs">{status.irn}</div>
        {status.qrPayload && (
          <div className="mt-1 break-all text-[10px] text-stone-500">{status.qrPayload}</div>
        )}
      </div>
    );
  }
  if (status.status === 'failed') {
    return (
      <div className="mt-2 rounded border border-red-300 bg-red-50 p-3 text-xs dark:border-red-800 dark:bg-red-950">
        <div className="flex items-center gap-1 font-semibold text-red-700 dark:text-red-300">
          <AlertTriangle className="h-3 w-3" />
          FBR submission failed
        </div>
        <div className="mt-1 text-red-600 dark:text-red-400">
          {status.lastError ?? 'Will retry from the queue.'}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded border border-dashed border-stone-300 p-3 text-center text-xs text-stone-500 dark:border-stone-700">
      <div className="inline-flex items-center gap-1">
        <Hourglass className="h-3 w-3 animate-pulse" />
        FBR submitting…{status.attempts > 1 ? ` (attempt ${status.attempts})` : ''}
      </div>
    </div>
  );
}
