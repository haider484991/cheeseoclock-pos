import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import type { PrintPolicy, ShopCopyRule } from '@cheeseoclock/shared-types';
import { Bike, ChefHat, Copy, Receipt, RotateCcw, ScrollText } from 'lucide-react';

const DEFAULT_POLICY: PrintPolicy = {
  kitchenTicket: true,
  deliveryBillOnDispatch: true,
  shopCopy: 'delivery',
};

const SHOP_COPY_OPTIONS: Array<{ id: ShopCopyRule; label: string }> = [
  { id: 'never', label: 'Never' },
  { id: 'delivery', label: 'With delivery bills' },
  { id: 'always', label: 'With every receipt' },
];

/**
 * What prints automatically, and when. The rules live in the main process
 * (Settings → Printer → policy); this card only edits them. The wording here
 * is the contract the shop runs on, so keep it in step with
 * PrintPolicy in shared-types and printSpooler.onOrderEvent.
 */
export function PrintingRulesSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
  });
  const [policy, setPolicy] = useState<PrintPolicy>(DEFAULT_POLICY);
  // Hydrate from the saved rules only: saving a printer on this tab must not
  // wipe a rule that was changed here but not saved yet.
  const savedPolicy = cfgQ.data?.policy;
  useEffect(() => {
    if (savedPolicy) setPolicy(savedPolicy);
  }, [savedPolicy]);

  const saveMut = useMutation({
    mutationFn: (next: PrintPolicy) => ipc.printer.setPolicy(next),
    onSuccess: () => {
      toast({ title: 'Printing rules saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['printer', 'config'] });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const saved = cfgQ.data?.policy ?? DEFAULT_POLICY;
  const dirty =
    saved.kitchenTicket !== policy.kitchenTicket ||
    saved.deliveryBillOnDispatch !== policy.deliveryBillOnDispatch ||
    saved.shopCopy !== policy.shopCopy;

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <ScrollText className="h-5 w-5" />
        <h2 className="text-lg font-semibold">What prints, and when</h2>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        Paper comes out on its own at these moments. Nothing here ever blocks a sale: if the
        printer is off, the order is still saved and the print retries.
      </p>

      <ul className="divide-y divide-stone-200 dark:divide-stone-700">
        <Rule
          icon={ChefHat}
          title="Kitchen ticket"
          body="Printed once, the moment an order goes to the kitchen — Send to kitchen, Pay now at the counter, or a website order arriving. What to cook, big print, no prices. Comes out of the kitchen printer if one is set up below, otherwise the receipt printer."
          control={
            <Toggle
              checked={policy.kitchenTicket}
              onChange={(v) => setPolicy({ ...policy, kitchenTicket: v })}
              label="Print kitchen tickets"
            />
          }
        />
        <Rule
          icon={Receipt}
          title="Customer receipt"
          body="Printed when money is taken: Pay now at the counter, or a cash-on-delivery order marked served or delivered with its payment. A cash payment opens the drawer; card and wallet payments do not."
          control={<span className="text-xs font-semibold uppercase tracking-wider text-stone-400">Always</span>}
        />
        <Rule
          icon={Bike}
          title="Delivery bill goes with the rider"
          body="For delivery orders the bill prints when a rider is assigned, so it travels with the food and shows the amount to collect — or PAID. When the rider brings the cash back and the order is marked delivered, only the drawer opens; the customer already has the receipt."
          control={
            <Toggle
              checked={policy.deliveryBillOnDispatch}
              onChange={(v) => setPolicy({ ...policy, deliveryBillOnDispatch: v })}
              label="Print the bill when a rider is assigned"
            />
          }
        />
        <Rule
          icon={Copy}
          title="Shop copy"
          body="A second copy marked SHOP COPY, with a Received-by line for the rider or customer to sign. The shop keeps it to check the day's cash."
          control={
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Shop copy">
              {SHOP_COPY_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={policy.shopCopy === o.id}
                  onClick={() => setPolicy({ ...policy, shopCopy: o.id })}
                  className={cn(
                    'rounded-lg border-2 px-3 py-1.5 text-xs font-semibold transition-colors',
                    policy.shopCopy === o.id
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                      : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          }
        />
        <Rule
          icon={RotateCcw}
          title="Refunds and reprints"
          body="A refund prints a refund receipt (the drawer opens when cash goes back out). The print buttons on the Live Orders board, in order history and on the payment screen print the receipt or the kitchen ticket again — a reprinted kitchen ticket is stamped REPRINT so nothing is cooked twice."
          control={<span className="text-xs font-semibold uppercase tracking-wider text-stone-400">Always</span>}
        />
      </ul>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-stone-200 pt-4 dark:border-stone-700">
        {dirty && (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Your changes are not saved yet
          </span>
        )}
        <Button
          variant="primary"
          disabled={saveMut.isPending || !dirty}
          onClick={() => saveMut.mutate(policy)}
        >
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

function Rule(props: {
  icon: typeof ChefHat;
  title: string;
  body: string;
  control: React.ReactNode;
}) {
  const Icon = props.icon;
  return (
    <li className="flex flex-col gap-3 py-4 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{props.title}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{props.body}</p>
        </div>
      </div>
      <div className="shrink-0 md:pl-4">{props.control}</div>
    </li>
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        props.checked ? 'bg-amber-500' : 'bg-stone-300 dark:bg-stone-600',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
          props.checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
