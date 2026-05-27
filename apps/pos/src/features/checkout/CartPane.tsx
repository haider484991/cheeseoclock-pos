import { useCheckoutStore } from '../../stores/checkoutStore';
import { Button, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { Minus, Plus, X, Percent, CreditCard, Trash2, AlertTriangle, ShoppingBag } from 'lucide-react';
import { useTenderGate } from './useTenderGate';

interface Props {
  onPay: () => void;
  onDiscount: () => void;
}

export function CartPane({ onPay, onDiscount }: Props) {
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const busy = useCheckoutStore((s) => s.busy);
  const updateItemQty = useCheckoutStore((s) => s.updateItemQty);
  const removeItem = useCheckoutStore((s) => s.removeItem);
  const clearDiscount = useCheckoutStore((s) => s.clearDiscount);
  const gate = useTenderGate();

  const items = snapshot?.items ?? [];
  const order = snapshot?.order;
  const totalCents = order?.totalCents ?? 0;
  const subtotalCents = order?.subtotalCents ?? 0;
  const discountCents = order?.discountCents ?? 0;
  const taxCents = order?.taxCents ?? 0;

  return (
    <aside className="flex w-[26rem] flex-col border-l border-stone-200/70 bg-white/80 backdrop-blur-md dark:border-stone-800/70 dark:bg-stone-900/80">
      <header className="flex items-center justify-between border-b border-stone-200/70 px-5 py-4 dark:border-stone-800/70">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-500">
            Current order
          </div>
          <div className="mt-0.5 font-mono text-sm font-semibold">
            {order ? `#${order.orderNumber}` : 'No order yet'}
          </div>
        </div>
        {items.length > 0 && (
          <div className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {items.length} item{items.length === 1 ? '' : 's'}
          </div>
        )}
      </header>

      <div className="flex-1 overflow-auto px-3 py-2">
        {items.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-stone-100 text-stone-400 dark:bg-stone-800">
              <ShoppingBag className="h-7 w-7" />
            </div>
            <div className="mt-3 text-sm font-medium text-stone-500">Cart is empty</div>
            <div className="mt-0.5 text-xs text-stone-400">
              Tap a menu item to start an order.
            </div>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="mb-1.5 rounded-xl p-2.5 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/60"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-1 text-sm font-semibold leading-tight">
                    {item.menuItemName}
                  </div>
                  {item.modifiers.length > 0 && (
                    <ul className="ml-2 mt-1 space-y-0.5 text-[11px] text-stone-500">
                      {item.modifiers.map((m) => (
                        <li key={m.id} className="flex items-baseline gap-1">
                          <span className="text-stone-400">+</span>
                          <span className="flex-1 truncate">{m.modifierName}</span>
                          {m.priceDeltaCents !== 0 && (
                            <span className="font-mono text-stone-400">
                              {formatCents(m.priceDeltaCents, { showSymbol: false })}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="font-mono text-sm font-semibold">
                  {formatCents(item.lineTotalCents)}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1">
                <div className="flex items-center rounded-lg bg-stone-100 p-0.5 dark:bg-stone-800">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void updateItemQty(item.id, item.quantity - 1)}
                    className="rounded-md p-1 text-stone-600 hover:bg-white disabled:opacity-50 dark:text-stone-300 dark:hover:bg-stone-700"
                    aria-label="Decrease quantity"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="min-w-[2ch] px-1.5 text-center font-mono text-sm font-bold">
                    {item.quantity}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void updateItemQty(item.id, item.quantity + 1)}
                    className="rounded-md p-1 text-stone-600 hover:bg-white disabled:opacity-50 dark:text-stone-300 dark:hover:bg-stone-700"
                    aria-label="Increase quantity"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeItem(item.id)}
                  className="ml-auto rounded-md p-1.5 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950"
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <footer
        className={cn(
          'border-t border-stone-200/70 px-4 py-3 dark:border-stone-800/70',
          items.length === 0 && 'opacity-60',
        )}
      >
        <dl className="mb-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-stone-500">Subtotal</dt>
            <dd className="font-mono">{formatCents(subtotalCents)}</dd>
          </div>
          {discountCents > 0 && (
            <div className="flex justify-between text-emerald-700 dark:text-emerald-300">
              <dt className="flex items-center gap-1">
                Discount
                <button
                  type="button"
                  onClick={() => void clearDiscount()}
                  className="rounded p-0.5 hover:bg-emerald-100 dark:hover:bg-emerald-900"
                  aria-label="Remove discount"
                >
                  <X className="h-3 w-3" />
                </button>
              </dt>
              <dd className="font-mono">−{formatCents(discountCents)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-stone-500">Tax</dt>
            <dd className="font-mono">{formatCents(taxCents)}</dd>
          </div>
          <div className="flex justify-between rounded-xl bg-gradient-to-r from-amber-50 to-amber-100/50 px-3 py-2 text-base dark:from-amber-950/60 dark:to-amber-900/30">
            <dt className="font-semibold">Total</dt>
            <dd className="font-mono text-xl font-bold text-amber-900 dark:text-amber-100">
              {formatCents(totalCents)}
            </dd>
          </div>
        </dl>

        {items.length > 0 && !gate.ok && (
          <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-2.5 text-xs dark:border-amber-700 dark:bg-amber-950">
            <div className="mb-0.5 flex items-center gap-1 font-semibold text-amber-900 dark:text-amber-200">
              <AlertTriangle className="h-3 w-3" />
              Before paying:
            </div>
            <ul className="ml-4 list-disc space-y-0.5 text-amber-800 dark:text-amber-200">
              {gate.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            size="lg"
            disabled={items.length === 0 || busy}
            onClick={onDiscount}
          >
            <Percent className="h-4 w-4" />
            Discount
            <kbd className="ml-1 rounded bg-stone-200 px-1 text-[10px] dark:bg-stone-700">F3</kbd>
          </Button>
          <Button
            variant="success"
            size="lg"
            disabled={items.length === 0 || busy || !gate.ok}
            onClick={onPay}
            title={!gate.ok ? gate.missing.join(' · ') : undefined}
          >
            <CreditCard className="h-4 w-4" />
            Pay
            <kbd className="ml-1 rounded bg-emerald-700 px-1 text-[10px]">F1</kbd>
          </Button>
        </div>
      </footer>
    </aside>
  );
}
