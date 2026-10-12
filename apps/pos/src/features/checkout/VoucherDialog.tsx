import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, Ticket, X, XCircle } from 'lucide-react';
import { Button, cn } from '@cheeseoclock/ui';
import {
  formatCents,
  normalizeVoucherCode,
  parseVoucherNumber,
  voucherAmountCents,
  voucherCanCover,
  voucherLineEachCents,
  voucherNumberText,
  type VoucherLine,
} from '@cheeseoclock/pos-domain';
import type { OrderSnapshot, VoucherCheck } from '@cheeseoclock/shared-types';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useToast } from '../../components/toast/ToastProvider';
import { ipc } from '../../ipc/client';
import { voucherCheckWords, voucherLineWords } from './voucherWords';

interface Props {
  onClose: () => void;
}

/** The cart's lines a voucher can come off, as the main process tells them (pos-domain voucherCanCover). */
export function voucherLinesOfSnapshot(snapshot: OrderSnapshot | null): VoucherLine[] {
  return (snapshot?.items ?? [])
    .map((i) => ({
      id: i.id as string,
      menuItemName: i.menuItemName,
      menuItemId: (i.menuItemId as string | null) ?? null,
      quantity: i.quantity,
      lineTotalCents: i.lineTotalCents as number,
      noDiscount: i.noDiscount === true,
      parentOrderItemId: (i.parentOrderItemId as string | null) ?? null,
    }))
    .filter(voucherCanCover);
}

/**
 * "Use a voucher" (v0.7.48): the cashier types the number and the code
 * printed on a client's voucher; the till says at once whether it can be
 * used (never used, not ended) or why not, and which item it comes off —
 * the dearest one by default. One of that item comes off, up to what the
 * voucher covers; extras are paid. No PIN: the code is the proof. The main
 * process checks everything again when it is put on.
 */
export function VoucherDialog({ onClose }: Props) {
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const applyVoucher = useCheckoutStore((s) => s.applyVoucher);
  const busy = useCheckoutStore((s) => s.busy);
  const { toast } = useToast();
  const numberRef = useRef<HTMLInputElement>(null);
  const [numberText, setNumberText] = useState('');
  const [codeText, setCodeText] = useState('');
  const [check, setCheck] = useState<VoucherCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const lines = useMemo(() => voucherLinesOfSnapshot(snapshot), [snapshot]);
  const dearest = useMemo(
    () => lines.reduce<VoucherLine | null>((best, l) => (!best || voucherLineEachCents(l) > voucherLineEachCents(best) ? l : best), null),
    [lines],
  );
  const [lineId, setLineId] = useState<string | null>(dearest?.id ?? null);
  useEffect(() => {
    if (lineId === null || !lines.some((l) => l.id === lineId)) setLineId(dearest?.id ?? null);
  }, [lines, lineId, dearest]);

  const number = parseVoucherNumber(numberText);
  const code = normalizeVoucherCode(codeText);
  const typed = number !== null && code.length >= 3;
  const orderId = snapshot?.order.id ?? null;

  // Checked as it is typed (a moment after the last key): the cashier sees the answer before Apply.
  useEffect(() => {
    setCheck(null);
    setError(null);
    if (!typed || number === null) return;
    let live = true;
    setChecking(true);
    const t = window.setTimeout(() => {
      ipc.vouchers
        .check({ number, code, orderId })
        .then((r) => {
          if (live) setCheck(r);
        })
        .catch((e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : 'Could not check the voucher');
        })
        .finally(() => {
          if (live) setChecking(false);
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [typed, number, code, orderId]);

  const line = lines.find((l) => l.id === lineId) ?? null;
  const ok = check?.ok === true ? check : null;
  const off = ok && line ? voucherAmountCents(ok.batch.coversCents, line) : 0;
  const canApply = ok !== null && line !== null && !saving && !busy;

  async function apply() {
    if (!ok || !line || number === null) return;
    setSaving(true);
    setError(null);
    try {
      await applyVoucher(number, code, line.id);
      toast({ title: `Voucher No. ${voucherNumberText(ok.number)} is on the order`, description: `${formatCents(off)} off ${line.menuItemName}`, variant: 'success' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use the voucher');
    } finally {
      setSaving(false);
    }
  }

  const words = check ? voucherCheckWords(check) : null;
  // One discount per order: a voucher takes the place of the one on it now (an offer comes back if the voucher comes off).
  const replacing = (snapshot?.discounts ?? []).find((d) => d.source !== 'voucher' && (d.amountCents as number) > 0) ?? null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            numberRef.current?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canApply) {
              e.preventDefault();
              void apply();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[480px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl bg-white p-5 shadow-xl outline-none dark:bg-stone-900 dark:text-stone-100"
        >
          <header className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="flex items-center gap-2 text-xl font-bold">
                <Ticket className="h-5 w-5 text-amber-600" aria-hidden="true" />
                Use a voucher
              </Dialog.Title>
              <Dialog.Description className="text-sm text-stone-500 dark:text-stone-400">
                Type the number and the code printed on the voucher (a photo of it is fine).
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-lg p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Close">
              <X className="h-5 w-5" />
            </Dialog.Close>
          </header>

          <div className="grid grid-cols-[1fr_1.4fr] gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">Voucher No.</span>
              <input
                ref={numberRef}
                inputMode="numeric"
                autoComplete="off"
                value={numberText}
                onChange={(e) => setNumberText(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                placeholder="001"
                className="h-12 w-full rounded-lg border border-stone-200 px-3 font-mono text-2xl font-bold tracking-wider focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">Code</span>
              <input
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={codeText}
                onChange={(e) => setCodeText(e.target.value.toUpperCase().slice(0, 14))}
                placeholder="MF7U"
                className="h-12 w-full rounded-lg border border-stone-200 px-3 font-mono text-2xl font-bold tracking-[0.3em] focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
          </div>

          <div className="mt-3 min-h-[56px]" aria-live="polite">
            {!typed ? null : checking && !check ? (
              <p className="text-sm text-stone-500">Checking…</p>
            ) : words ? (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
                  words.ok
                    ? 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:ring-emerald-800'
                    : 'bg-red-50 text-red-900 ring-1 ring-red-200 dark:bg-red-950 dark:text-red-100 dark:ring-red-800',
                )}
              >
                {words.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <div>
                  <p className="font-semibold">{words.title}</p>
                  {words.detail && <p>{words.detail}</p>}
                </div>
              </div>
            ) : null}
          </div>

          {ok && (
            <section className="mt-2">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">It comes off</h3>
              {lines.length === 0 ? (
                <p className="text-sm text-stone-600 dark:text-stone-300">Add the item the voucher is for to the order first.</p>
              ) : (
                <ul className="space-y-1.5" role="radiogroup" aria-label="The item the voucher is for">
                  {lines.map((l) => {
                    const picked = l.id === lineId;
                    return (
                      <li key={l.id}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={picked}
                          onClick={() => setLineId(l.id)}
                          className={cn(
                            'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm',
                            picked
                              ? 'border-amber-500 bg-amber-50 ring-2 ring-amber-200 dark:bg-amber-950 dark:ring-amber-800'
                              : 'border-stone-200 hover:border-stone-400 dark:border-stone-700',
                          )}
                        >
                          <span className="font-medium">{voucherLineWords(l)}</span>
                          <span className="shrink-0 font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                            −{formatCents(voucherAmountCents(ok.batch.coversCents, l), { showSymbol: false })}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {ok && replacing && (
            <p className="mt-3 text-xs font-medium text-amber-800 dark:text-amber-300">
              It takes the place of the discount on this order now ({replacing.reason ?? 'Discount'}, −{formatCents(replacing.amountCents)}): one per order.
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 text-sm font-semibold text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <footer className="mt-4 flex items-center gap-2">
            <p className="text-xs text-stone-500">One voucher per order.</p>
            <div className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="lg" disabled={!canApply} onClick={() => void apply()}>
              {saving ? 'Using it…' : off > 0 ? `Use it: −${formatCents(off)}` : 'Use voucher'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
