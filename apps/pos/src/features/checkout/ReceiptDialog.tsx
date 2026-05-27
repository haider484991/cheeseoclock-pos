import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import { CheckCircle2, Printer, Hourglass, ShieldCheck, AlertTriangle } from 'lucide-react';
import { ipc, onFbrQueueChanged } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';

interface Props {
  snapshot: OrderSnapshot;
  onClose: () => void;
}

const MODE_LABEL = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  online: 'Online',
} as const;

const METHOD_LABEL = {
  cash: 'Cash',
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank',
} as const;

export function ReceiptDialog({ snapshot, onClose }: Props) {
  const { order, items, payments, discounts, cashierName, tableLabel } = snapshot;
  const [reprinting, setReprinting] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

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

  async function reprint() {
    setReprinting(true);
    try {
      await ipc.printer.reprint(order.id);
      toast({ title: 'Reprint sent', variant: 'success' });
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[400px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-center gap-2 border-b border-stone-200 p-4 dark:border-stone-800">
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            <Dialog.Title className="text-lg font-bold">Payment received</Dialog.Title>
          </header>

          <div className="flex-1 overflow-auto p-5 font-mono text-sm">
            <div className="text-center">
              <div className="text-xl font-bold">CheeseOclock</div>
              <div className="text-xs text-stone-500">Pakistani Pizza • Cafe</div>
              <div className="mt-3 text-xs text-stone-500">{new Date(order.paidAt ?? Date.now()).toLocaleString()}</div>
              <div className="text-xs">
                Cashier: {cashierName} · {MODE_LABEL[order.mode]}
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
                    + {m.modifierName}
                    {m.priceDeltaCents !== 0 && (
                      <span> ({formatCents(m.priceDeltaCents, { showSymbol: false })})</span>
                    )}
                  </div>
                ))}
              </div>
            ))}

            <hr className="my-3 border-stone-300 dark:border-stone-700" />

            <div className="space-y-1">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatCents(order.subtotalCents, { showSymbol: false })}</span>
              </div>
              {discounts.map((d) => (
                <div key={d.id} className="flex justify-between text-emerald-700 dark:text-emerald-300">
                  <span>Discount ({d.reason ?? d.discountType})</span>
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
            {payments.length > 0 && payments[0]?.tenderedCents != null && (
              <>
                <div className="flex justify-between text-xs">
                  <span>Tendered</span>
                  <span>{formatCents(payments[0].tenderedCents, { showSymbol: false })}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>Change</span>
                  <span>
                    {formatCents(
                      (payments[0].tenderedCents ?? 0) - order.totalCents,
                      { showSymbol: false },
                    )}
                  </span>
                </div>
              </>
            )}

            <hr className="my-3 border-stone-300 dark:border-stone-700" />

            <div className="mt-3 text-center text-xs text-stone-500">
              Thank you — visit us again!
            </div>
            <FbrBlock status={fbrQ.data} />
          </div>

          <footer className="flex gap-2 border-t border-stone-200 p-4 dark:border-stone-800">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              New order
            </Button>
            <Button
              variant="primary"
              className="flex-1"
              disabled={reprinting}
              onClick={reprint}
              title={
                fbrQ.data?.status === 'sent'
                  ? 'Reprint with FBR IRN'
                  : 'Reprint receipt'
              }
            >
              <Printer className="h-4 w-4" />
              {reprinting ? 'Sending…' : 'Reprint'}
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
