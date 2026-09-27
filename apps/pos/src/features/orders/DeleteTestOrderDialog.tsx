import { useState, type ElementType, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Trash2, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { TEST_DELETE_REASON_CHIPS, type OrderSnapshot, type TestDeletePreview, type TestDeleteResult } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { StatusBadge } from './OrderBadges';
import { orderTimeLabel, shortOrderNumber } from './historyFilters';
import { lineText, stockNotes } from './stockCopy';
import {
  TEST_DELETE_INTRO,
  TEST_DELETE_PUT_BACK,
  TEST_DELETE_REAL_ORDER,
  TEST_DELETE_STOCK_QUESTION,
  TEST_DELETE_WASTE,
  testDeleteAlsoLines,
  testDeleteCashLines,
  testDeleteMissing,
  testDeletePaidLine,
  testDeleteStockLine,
  testDeleteToast,
} from './testDeleteCopy';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onDone: (result: TestDeleteResult) => void;
}

/**
 * "Delete test order #0042" — the OWNER only (the button shows for the admin
 * login; the main process refuses anyone else). It reads what deleting would
 * do first (orders:testDeletePreview): a refusal is shown in its words and
 * the form is hidden. Otherwise the owner answers "Put the stock back?" (no
 * answer is picked for them), says why it was a test, and types the owner's
 * PIN or password again. It can't be undone. Never window.confirm.
 */
export function DeleteTestOrderDialog({ snap, onClose, onDone }: Props) {
  const { toast } = useToast();
  const [restock, setRestock] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const [secret, setSecret] = useState('');

  const previewQ = useQuery({
    queryKey: ['orders', 'testDeletePreview', snap.order.id],
    queryFn: () => ipc.orders.testDeletePreview(snap.order.id),
    retry: false,
  });
  const p = previewQ.data;
  const holdsStock = p?.stock.state === 'holds';

  const deleteMut = useMutation({
    mutationFn: () => {
      if (!p) throw new Error('Still checking the order');
      return ipc.orders.deleteTest({
        orderId: snap.order.id,
        reason: reason.trim(),
        restock: holdsStock ? restock : null,
        ownerSecret: secret,
        expectStatus: p.status,
      });
    },
    onSuccess: (done) => {
      toast({ title: testDeleteToast(done), variant: 'success' });
      onDone(done);
    },
    onError: (e) =>
      toast({ title: 'Not deleted', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  const loadError = previewQ.error ? (previewQ.error instanceof Error ? previewQ.error.message : 'The order could not be checked.') : null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[500px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white shadow-soft-lg dark:bg-stone-900"
          data-testid="delete-test-order-dialog"
        >
          <DeleteTestOrderForm
            orderNumber={snap.order.orderNumber}
            preview={p ?? null}
            loading={previewQ.isLoading}
            loadError={loadError}
            restock={restock}
            onRestock={setRestock}
            reason={reason}
            onReason={setReason}
            secret={secret}
            onSecret={setSecret}
            pending={deleteMut.isPending}
            onSubmit={() => deleteMut.mutate()}
            onClose={onClose}
            Title={Dialog.Title}
            Description={Dialog.Description}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type TextSlot = ElementType<{ className?: string; children?: ReactNode }>;

export interface DeleteTestOrderFormProps {
  orderNumber: string;
  /** What deleting would do (null while it is read). */
  preview: TestDeletePreview | null;
  loading: boolean;
  /** The preview could not be read (the order is gone, or the login may not). */
  loadError: string | null;
  restock: boolean | null;
  onRestock: (v: boolean) => void;
  reason: string;
  onReason: (v: string) => void;
  secret: string;
  onSecret: (v: string) => void;
  pending: boolean;
  onSubmit: () => void;
  onClose: () => void;
  /** Where the title and the intro go (the dialog's own, or plain elements in a test). */
  Title?: TextSlot;
  Description?: TextSlot;
}

const PlainTitle = ({ className, children }: { className?: string; children?: ReactNode }) => <h2 className={className}>{children}</h2>;
const PlainDescription = ({ className, children }: { className?: string; children?: ReactNode }) => <p className={className}>{children}</p>;

/**
 * The dialog's body: the order, the refusal (then nothing else), or the
 * stock question, the money, what else happens, why it was a test and the
 * owner's secret. "Delete test order" stays greyed out until the stock is
 * answered (when there is any), the reason written and the secret typed.
 */
export function DeleteTestOrderForm(props: DeleteTestOrderFormProps) {
  const { preview: p, restock, reason, secret } = props;
  const Title = props.Title ?? PlainTitle;
  const Description = props.Description ?? PlainDescription;
  const short = shortOrderNumber(props.orderNumber);
  const holdsStock = p?.stock.state === 'holds';
  const refusal = props.loadError ?? p?.refusal ?? null;
  const missing = testDeleteMissing({ holdsStock, restock, reason, secret });
  const canDelete = !!p && !refusal && !missing && !props.pending;

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (canDelete) props.onSubmit();
      }}
    >
      <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="flex items-start gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200">
            <Trash2 className="h-4 w-4" />
          </span>
          <div>
            <Title className="text-lg font-semibold">Delete test order {short}</Title>
            <Description className="mt-0.5 text-xs text-stone-600 dark:text-stone-300">{TEST_DELETE_INTRO}</Description>
          </div>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close"
          className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-2 text-sm">
        <p className="rounded-lg bg-amber-50 p-2.5 text-xs font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {TEST_DELETE_REAL_ORDER}
        </p>

        {props.loading && <p className="py-4 text-center text-stone-500">Checking the order…</p>}

        {refusal && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 font-semibold text-red-800 dark:bg-red-950/40 dark:text-red-200">
            {refusal}
          </p>
        )}

        {p && (
          <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-700" aria-label="The order">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{formatCents(p.totalCents)}</span>
              <StatusBadge status={p.status} />
            </div>
            <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
              {p.items.map((i) => `${i.quantity}× ${i.name}`).join(', ') || 'No items'}
            </p>
            <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">{testDeletePaidLine(p.paid)}</p>
            <p className="mt-1 text-xs text-stone-500">
              Taken {orderTimeLabel(p.takenAt)} by {p.takenBy}
            </p>
          </section>
        )}

        {p && !refusal && (
          <>
            {holdsStock ? (
              <fieldset className="space-y-2">
                <legend className="mb-1 font-medium text-stone-800 dark:text-stone-100">{TEST_DELETE_STOCK_QUESTION}</legend>
                <div className="grid gap-2">
                  {(
                    [
                      [true, TEST_DELETE_PUT_BACK],
                      [false, TEST_DELETE_WASTE],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={restock === value}
                      onClick={() => props.onRestock(value)}
                      className={cn(
                        'rounded-lg px-3 py-2 text-left text-sm font-medium ring-1 transition-colors',
                        restock === value
                          ? 'bg-amber-100 text-amber-950 ring-amber-400 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-600'
                          : 'bg-stone-50 text-stone-800 ring-stone-200 hover:bg-stone-100 dark:bg-stone-800 dark:text-stone-100 dark:ring-stone-700',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {p.stock.lines.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-stone-600 dark:text-stone-300">
                    {p.stock.lines.map((l) => (
                      <li key={l.ingredientId}>
                        {lineText(l)}
                        {l.estCostCents > 0 ? ` · about ${formatCents(l.estCostCents)}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {stockNotes({ lines: p.stock.lines, otherTill: false }).map((n) => (
                  <p key={n} className="text-xs text-stone-500">
                    {n}
                  </p>
                ))}
              </fieldset>
            ) : (
              <p className="text-stone-700 dark:text-stone-200">{testDeleteStockLine(p.stock.state)}</p>
            )}

            <section aria-label="Money" className="space-y-1">
              {[...testDeleteCashLines(p), ...testDeleteAlsoLines(p)].map((line) => (
                <p key={line} className="text-stone-700 dark:text-stone-200">
                  {line}
                </p>
              ))}
            </section>

            <div>
              <label htmlFor="test-delete-reason" className="mb-1 block font-medium text-stone-800 dark:text-stone-100">
                Why was it a test?
              </label>
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {TEST_DELETE_REASON_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => props.onReason(chip)}
                    aria-pressed={reason === chip}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors',
                      reason === chip
                        ? 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700'
                        : 'bg-stone-50 text-stone-700 ring-stone-200 hover:bg-stone-100 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-700',
                    )}
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <input
                id="test-delete-reason"
                value={reason}
                maxLength={200}
                onChange={(e) => props.onReason(e.target.value)}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                placeholder="Or type why…"
              />
            </div>

            <label className="block">
              <span className="mb-1 block font-medium text-stone-800 dark:text-stone-100">Type your owner PIN or password to confirm</span>
              <SecretInput
                value={secret}
                onChange={props.onSecret}
                aria-label="Owner PIN or password"
                className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-2 text-center font-mono text-lg tracking-[0.5em] focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                placeholder="••••"
              />
            </label>
          </>
        )}
      </div>

      <div className="flex gap-2 border-t border-stone-100 px-5 py-4 dark:border-stone-800">
        <Button type="button" variant="ghost" size="md" className="flex-1" onClick={props.onClose}>
          Keep the order
        </Button>
        {!refusal && (
          <Button type="submit" variant="danger" size="md" className="flex-1" disabled={!canDelete} title={missing ?? undefined}>
            {props.pending ? 'Deleting…' : 'Delete test order'}
          </Button>
        )}
      </div>
    </form>
  );
}
