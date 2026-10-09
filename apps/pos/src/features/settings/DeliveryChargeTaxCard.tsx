/**
 * Settings → Delivery areas & fees → "Tax on the delivery charge" (owner,
 * 10 Oct 2026: "i want to setting to set delivery tax in settings"). The
 * owner alone (the main process refuses anyone else). The charges' tax is
 * their "Delivery Charge (Rs N)" items' tax: this card reads it from them,
 * and its Save moves every one onto the food's tax, no tax, or a rate of its
 * own ("Delivery charge tax"), in one transaction — the website gets it with
 * the areas (shared-types delivery-charge-tax.ts, delivery-charge-tax-repo).
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { Percent } from 'lucide-react';
import { sameDeliveryChargeTax } from '@cheeseoclock/pos-domain';
import type { DeliveryChargeTaxChoice, DeliveryChargeTaxView } from '@cheeseoclock/shared-types';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { CHECKOUT_RULES_KEY, SHOP_SETTINGS_KEY } from './shop-rules/useShopSetting';
import { useDraft } from './shop-rules/useDraft';
import {
  chargeTaxExampleWords,
  chargeTaxFromForm,
  chargeTaxNowWords,
  chargeTaxSaveNote,
  chargeTaxSavedToast,
  chargeTaxToForm,
  foodOptionWords,
  percentText,
  type ChargeTaxForm,
} from './shop-rules/deliveryChargeTaxForm';

/** Under the shop rules' key: the areas' Save and a change from the other till read it again. */
export const DELIVERY_CHARGE_TAX_KEY = [...SHOP_SETTINGS_KEY, 'delivery-charge-tax'] as const;

const boxClass =
  'w-24 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';

export function DeliveryChargeTaxCard() {
  const q = useQuery({
    queryKey: DELIVERY_CHARGE_TAX_KEY,
    queryFn: () => ipc.settings.deliveryChargeTax(),
    // A charge's tax can change in Menu too: read it again whenever the tab opens.
    refetchOnMount: 'always',
  });
  if (q.isError) {
    return (
      <Card>
        <p className="py-4 text-center text-stone-500">Could not load the tax on the delivery charge.</p>
      </Card>
    );
  }
  if (!q.data) {
    return (
      <Card>
        <p className="py-4 text-center text-stone-500">Loading…</p>
      </Card>
    );
  }
  return <TaxChoiceCard view={q.data} />;
}

function TaxChoiceCard({ view }: { view: DeliveryChargeTaxView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const d = useDraft<DeliveryChargeTaxChoice | null, ChargeTaxForm>(view.now, chargeTaxToForm);
  const parsed = useMemo(() => chargeTaxFromForm(d.form), [d.form]);
  const noCharges = view.charges.length === 0;
  const dirty = parsed.value !== null && !sameDeliveryChargeTax(parsed.value, view.now);
  const example = chargeTaxExampleWords(view, parsed.value);
  const set = (patch: Partial<ChargeTaxForm>) => d.set({ ...d.form, ...patch });

  const save = useMutation({
    mutationFn: (choice: DeliveryChargeTaxChoice) => ipc.settings.saveDeliveryChargeTax({ choice }),
    onSuccess: (saved) => {
      qc.setQueryData(DELIVERY_CHARGE_TAX_KEY, saved.view);
      // This card, the areas' card (its latest Save), the counter's rules and Menu (the charges' tax).
      void qc.invalidateQueries({ queryKey: SHOP_SETTINGS_KEY });
      void qc.invalidateQueries({ queryKey: CHECKOUT_RULES_KEY });
      void qc.invalidateQueries({ queryKey: ['menu'] });
      toast({ ...chargeTaxSavedToast(saved), variant: 'success' });
      d.reset();
    },
    onError: (e) =>
      toast({ title: 'Not saved', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const choice = (kind: NonNullable<ChargeTaxForm['kind']>, title: string, help: string, onPick: () => void) => (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-lg border-2 p-3 text-sm',
        d.form.kind === kind ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40' : 'border-stone-200 dark:border-stone-700',
        noCharges && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name="delivery-charge-tax"
        className="mt-1"
        checked={d.form.kind === kind}
        disabled={noCharges || save.isPending}
        onChange={onPick}
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-stone-500">{help}</span>
      </span>
    </label>
  );

  return (
    <Card>
      <div className="mb-3 max-w-2xl">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Percent className="h-5 w-5" /> Tax on the delivery charge
        </h2>
        <p className="mt-0.5 text-sm text-stone-500">
          The tax added to the delivery charge on a delivery bill (“Sales tax on delivery”). The food’s tax is set in Menu → Tax.
        </p>
        <p className="mt-2 text-sm font-medium" aria-live="polite">
          {chargeTaxNowWords(view)}
        </p>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        {choice('food', foodOptionWords(view.food), 'The delivery charge is taxed like the food, at the same rates.', () =>
          set({ kind: 'food' }),
        )}
        {choice('none', 'No tax on the delivery charge', 'The bill shows the charge as it is, with no tax on it.', () =>
          set({ kind: 'none' }),
        )}
        {choice('rate', 'A rate of its own', 'Type the rate below; Menu → Tax shows it as “Delivery charge tax”.', () =>
          set({ kind: 'rate', rate: d.form.rate || (view.food ? percentText(view.food.rateBps) : '') }),
        )}
      </div>

      {d.form.kind === 'rate' && (
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <label className="block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Tax (%)</span>
            <input
              aria-label="Tax on the delivery charge, percent"
              inputMode="decimal"
              value={d.form.rate}
              disabled={save.isPending}
              onChange={(e) => set({ rate: e.target.value.replace(/[^\d.%]/g, '').slice(0, 6) })}
              className={boxClass}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Paid by card / wallet / bank (%)</span>
            <input
              aria-label="Tax on the delivery charge when paid by card, percent"
              inputMode="decimal"
              value={d.form.card}
              placeholder="same"
              disabled={save.isPending}
              onChange={(e) => set({ card: e.target.value.replace(/[^\d.%]/g, '').slice(0, 6) })}
              className={boxClass}
            />
          </label>
          <span className="pb-2 text-xs text-stone-500">Leave the card box empty for the same rate however the bill is paid.</span>
        </div>
      )}

      <div
        className="mt-4 space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100"
        aria-live="polite"
      >
        {example && (
          <p>
            <span className="font-semibold">For example: </span>
            {example}
          </p>
        )}
        <p className="text-xs">{chargeTaxSaveNote(view)}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => parsed.value && save.mutate(parsed.value)} disabled={!dirty || noCharges || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {d.touched && (
          <button
            type="button"
            onClick={d.reset}
            disabled={save.isPending}
            className="text-sm text-stone-500 underline-offset-2 hover:underline"
          >
            Undo
          </button>
        )}
        {d.form.kind !== null && parsed.problem && (
          <p className="text-sm text-red-700 dark:text-red-400" role="alert">
            {parsed.problem}
          </p>
        )}
      </div>
    </Card>
  );
}
