/**
 * Settings → Money & discounts → "Tax by how the customer pays" (0.7.45; the
 * owner, 12 Oct 2026: "add settings to set percentage tax on jazz cash or any
 * payment method"). Each tax category with its rate in cash and by card,
 * EasyPaisa, JazzCash and bank transfer; Change opens the same form as
 * Menu → Tax (TaxDialog), so the rates live in one place: the tax categories.
 * What the till does with them is pos-domain settleLegs: Pay, Picked up and
 * the bill show each way's total, and charge the way the customer pays.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { Percent } from 'lucide-react';
import { RATED_METHOD_LABEL, RATED_PAYMENT_METHODS, rateByMethod, taxRatePercentText, type TaxCategory } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { TaxDialog } from '../menu-mgmt/TaxTab';

export const TAX_BY_PAYMENT_INTRO =
  'Each way of paying can have its own tax rate — Sindh charges less when a bill is paid by card, wallet or bank transfer. ' +
  'The till charges the bill at the rate of the way the customer pays: Pay, Picked up and the printed bill show each way’s total. ' +
  'A part paid one way and the rest in cash is worked out part by part.';

export function TaxByPaymentCard() {
  const q = useQuery({ queryKey: ['menu', 'taxCategories'], queryFn: () => ipc.menu.listTaxCategories() });
  const [editing, setEditing] = useState<TaxCategory | null>(null);
  const cats = q.data ?? [];

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <Percent className="h-5 w-5 text-amber-600" aria-hidden="true" />
        <h2 className="font-semibold">Tax by how the customer pays</h2>
      </div>
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-300">{TAX_BY_PAYMENT_INTRO}</p>
      {q.isError ? (
        <p className="py-4 text-center text-stone-500">Could not load the tax rates.</p>
      ) : !q.data ? (
        <p className="py-4 text-center text-stone-500">Loading…</p>
      ) : cats.length === 0 ? (
        <p className="py-4 text-center text-stone-500">No tax categories yet — add them in Menu → Tax.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="tax-by-payment">
            <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
              <tr>
                <th className="pb-2">Tax</th>
                <th className="pb-2 text-right">Cash</th>
                {RATED_PAYMENT_METHODS.map((m) => (
                  <th key={m} className="pb-2 text-right">
                    {m === 'bank_transfer' ? 'Bank' : RATED_METHOD_LABEL[m]}
                  </th>
                ))}
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {cats.map((t) => (
                <tr key={t.id} className="border-t border-stone-100 dark:border-stone-800">
                  <td className="py-2 font-medium">{t.name}</td>
                  <td className="py-2 text-right font-mono">{taxRatePercentText(t.rateBps)}</td>
                  {RATED_PAYMENT_METHODS.map((m) => {
                    const rate = rateByMethod(t, m);
                    return (
                      <td
                        key={m}
                        className={cn('py-2 text-right font-mono', rate !== t.rateBps ? 'font-semibold text-amber-800 dark:text-amber-200' : 'text-stone-500')}
                      >
                        {taxRatePercentText(rate)}
                      </td>
                    );
                  })}
                  <td className="py-2 pl-2 text-right">
                    <Button variant="secondary" size="sm" onClick={() => setEditing(t)}>
                      Change
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <TaxDialog key={editing.id} existing={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
