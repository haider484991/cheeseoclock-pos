/**
 * Costing → Targets & fees: what a sale costs besides its food (costing spec
 * Phase 9) — what card and wallet payments cost, and what a delivery costs
 * in rider. Until the owner sets them: no payment fees, the rider service's
 * rate for each area. Managers see them; only the owner (settings.manage)
 * changes them — the main process refuses anyone else. Saved for both tills.
 *
 * foodpanda's terms (its commission, fee, tax and dearer prices, and the
 * deal) live in ONE place, Settings → foodpanda: they are shown here
 * read-only, for the owner (profit.view — the main process leaves them out
 * for a manager), with a button that opens Settings → foodpanda.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  RIDER_COST_MODES,
  type ChannelFeesView,
  type FoodpandaTermsInForce,
  type ReportPaymentGroup,
  type RiderCostMode,
  type SetChannelFeesRequest,
} from '@cheeseoclock/shared-types';
import { Bike, ExternalLink, Lock } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { PAYMENT_LABEL, PAYMENT_ORDER } from '../reports/reportFormat';
import { dealSummary, percentFromBps } from '../settings/shop-rules/foodpandaWords';
import { COSTING_KEY } from './costingQueries';
import { parsePercent, parseRupees } from './costingFormat';
import { openFoodpandaSettings } from './deepLinks';
import { rupeesInput } from '../inventory/price-view';

const FEES_KEY = [...COSTING_KEY, 'channelFees'] as const;

const RIDER_LABEL: Record<RiderCostMode, string> = {
  zone_rate: "The rider service's rate for the area",
  fixed: 'The same amount every trip',
  none: 'Nothing per trip (riders on a salary)',
};

const pct = (bps: number) => new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2, useGrouping: false }).format(bps / 100);

export function ChannelFeesCard({ canEdit }: { canEdit: boolean }) {
  const q = useQuery({ queryKey: FEES_KEY, queryFn: () => ipc.costing.getChannelFees(), staleTime: 0 });
  if (!q.data) {
    return <Card className="py-6 text-center text-stone-500">{q.isError ? 'Could not load the fees.' : 'Loading…'}</Card>;
  }
  return <ChannelFeesForm key={q.data.savedAt ?? 'default'} view={q.data} canEdit={canEdit} />;
}

/** What the boxes say, as the setting; or what is wrong, in plain words. foodpanda's terms are not typed here. */
export function readChannelFees(f: {
  payment: Record<ReportPaymentGroup, string>;
  riderMode: RiderCostMode;
  riderFixed: string;
}): { ok: true; value: SetChannelFeesRequest } | { ok: false; problem: string } {
  const paymentFeeBps = { cash: 0, card: 0, foodpanda: 0, transfer: 0 } as Record<ReportPaymentGroup, number>;
  for (const g of PAYMENT_ORDER) {
    const v = parsePercent(f.payment[g]);
    if (v === null) return { ok: false, problem: `The fee for ${PAYMENT_LABEL[g]} is 0% to 100%.` };
    paymentFeeBps[g] = v;
  }
  const fixedCents = parseRupees(f.riderFixed);
  if (fixedCents === null || fixedCents > 10_000_000) return { ok: false, problem: 'The rider cost per trip is Rs 0 to Rs 100,000.' };
  return { ok: true, value: { fees: { paymentFeeBps }, riderCost: { mode: f.riderMode, fixedCents } } };
}

/**
 * foodpanda's terms in force, in one short list (Settings → foodpanda): the
 * commission ("not confirmed yet" until the owner confirms it), what it is
 * on, the fee and tax, the dearer prices, the deal.
 */
export function foodpandaTermsLines(t: FoodpandaTermsInForce): string[] {
  const f = t.fees;
  const lines = [
    `Commission ${percentFromBps(f.commissionBps)} of the food ${f.base === 'after_deal' ? 'after your part of the deal' : 'before the deal'}, before tax${f.confirmed ? '' : ' — not confirmed yet'}`,
    f.fixedFeeCents > 0 ? `Fee ${formatCents(f.fixedFeeCents)} an order` : 'No fee per order',
  ];
  if (f.commissionTaxBps > 0) lines.push(`Tax on the commission ${percentFromBps(f.commissionTaxBps)}`);
  lines.push(f.upliftBps > 0 ? `Menu ${percentFromBps(f.upliftBps)} above the till's prices` : "Menu at the till's prices");
  lines.push(t.deal.percent > 0 ? `Deal: ${dealSummary(t.deal)}${t.dealToday ? '' : ' (not running today)'}` : 'No deal on the listing');
  return lines;
}

function FoodpandaTerms({ terms }: { terms: FoodpandaTermsInForce }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-2 text-sm">
      <p className="font-semibold">foodpanda</p>
      <ul className="space-y-1 text-stone-700 dark:text-stone-300">
        {foodpandaTermsLines(terms).map((l) => (
          <li key={l} className={cn(l.endsWith('not confirmed yet') && 'text-amber-800 dark:text-amber-300')}>
            {l}
          </li>
        ))}
      </ul>
      <p className="text-xs text-stone-500">
        {terms.carriedOver
          ? 'Carried over from what you saved here before. Settings → foodpanda keeps them now.'
          : terms.isDefault
            ? 'Suggested until you set them in Settings → foodpanda.'
            : 'Set in Settings → foodpanda.'}
      </p>
      <Button variant="secondary" size="sm" onClick={() => openFoodpandaSettings(navigate)}>
        <ExternalLink className="h-4 w-4" /> Change in Settings → foodpanda
      </Button>
    </div>
  );
}

function ChannelFeesForm({ view, canEdit }: { view: ChannelFeesView; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [payment, setPayment] = useState<Record<ReportPaymentGroup, string>>(() => ({
    cash: pct(view.fees.paymentFeeBps.cash),
    card: pct(view.fees.paymentFeeBps.card),
    foodpanda: pct(view.fees.paymentFeeBps.foodpanda),
    transfer: pct(view.fees.paymentFeeBps.transfer),
  }));
  const [riderMode, setRiderMode] = useState<RiderCostMode>(view.riderCost.mode);
  const [riderFixed, setRiderFixed] = useState(rupeesInput(view.riderCost.fixedCents));
  const reading = readChannelFees({ payment, riderMode, riderFixed });
  const dirty =
    reading.ok &&
    JSON.stringify(reading.value) !== JSON.stringify({ fees: { paymentFeeBps: view.fees.paymentFeeBps }, riderCost: view.riderCost });

  const mut = useMutation({
    mutationFn: (req: SetChannelFeesRequest) => ipc.costing.setChannelFees(req),
    onSuccess: () => {
      toast({ title: 'Fees saved', description: 'Profit uses them on both tills.', variant: 'success' });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => toast({ title: 'Could not save the fees', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const inputCls =
    'w-20 rounded-lg border border-stone-300 px-2 py-1.5 text-right font-mono disabled:bg-stone-100 disabled:text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:disabled:bg-stone-900';

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 font-semibold">
            <Bike className="h-4 w-4" /> {view.foodpanda ? 'foodpanda, card fees and riders' : 'Card fees and riders'}
          </h2>
          <p className="mt-0.5 text-sm text-stone-500">
            What a sale costs besides its food, for Reports → Profit. The till&apos;s own prices and bills never change.
          </p>
          {view.isDefault && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              Nothing is saved yet: no card fees; the rider service&apos;s rate for each area.
            </p>
          )}
        </div>
        {!canEdit && (
          <p className="inline-flex items-center gap-1.5 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600 dark:bg-stone-800 dark:text-stone-300">
            <Lock className="h-4 w-4" /> Only the owner can change these.
          </p>
        )}
      </div>

      <div className={cn('grid gap-4', view.foodpanda ? 'lg:grid-cols-3' : 'lg:grid-cols-2')}>
        {view.foodpanda && <FoodpandaTerms terms={view.foodpanda} />}

        <fieldset className="space-y-2 text-sm">
          <legend className="mb-1 font-semibold">What taking the money costs</legend>
          {PAYMENT_ORDER.map((g) => (
            <label key={g} className="flex items-center justify-between gap-2">
              <span>{PAYMENT_LABEL[g]}</span>
              <span className="flex items-center gap-1">
                <input
                  className={inputCls}
                  value={payment[g]}
                  disabled={!canEdit}
                  inputMode="decimal"
                  onChange={(e) => setPayment((p) => ({ ...p, [g]: e.target.value }))}
                  aria-label={`Fee on ${PAYMENT_LABEL[g]} payments, %`}
                />
                %
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-2 text-sm">
          <legend className="mb-1 font-semibold">Your riders</legend>
          {RIDER_COST_MODES.map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input type="radio" name="rider-mode" checked={riderMode === m} disabled={!canEdit} onChange={() => setRiderMode(m)} />
              {RIDER_LABEL[m]}
            </label>
          ))}
          {riderMode === 'fixed' && (
            <label className="flex items-center gap-2 pl-6">
              Rs
              <input className={inputCls} value={riderFixed} disabled={!canEdit} inputMode="decimal" onChange={(e) => setRiderFixed(e.target.value)} aria-label="Rider cost per trip, rupees" />
              a trip
            </label>
          )}
          {riderMode === 'zone_rate' && <p className="pl-6 text-xs text-stone-500">With no area on the address, the delivery charge on the bill.</p>}
        </fieldset>
      </div>

      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled={!reading.ok || !dirty || mut.isPending} onClick={() => reading.ok && mut.mutate(reading.value)}>
            Save the fees
          </Button>
          {!reading.ok && <span className={cn('text-sm text-red-700 dark:text-red-400')}>{reading.problem}</span>}
        </div>
      )}
    </Card>
  );
}
