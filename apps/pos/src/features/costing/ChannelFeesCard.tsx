/**
 * Costing → Targets & fees: what a sale costs beyond its food (costing spec
 * Phase 9, owner question 9) — foodpanda's commission (what it is taken on,
 * a fixed fee, whether foodpanda's menu is dearer than the till's), what
 * card and wallet payments cost, and what a delivery costs in rider. Until
 * the owner answers: 25% of the order before tax, no fixed fee, foodpanda at
 * till prices, no payment fees, the rider service's rate for each area.
 * Managers see it; only the owner (settings.manage) changes it — the main
 * process refuses anyone else. Saved for both tills.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  COMMISSION_BASES,
  COMMISSION_BASE_LABEL,
  RIDER_COST_MODES,
  type ChannelFeesView,
  type ReportPaymentGroup,
  type RiderCostMode,
  type SetChannelFeesRequest,
} from '@cheeseoclock/shared-types';
import { Bike, Lock } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { PAYMENT_LABEL, PAYMENT_ORDER } from '../reports/reportFormat';
import { COSTING_KEY } from './costingQueries';
import { parsePercent, parseRupees } from './costingFormat';
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

/** What the boxes say, as the setting; or what is wrong, in plain words. */
export function readChannelFees(f: {
  commission: string;
  base: SetChannelFeesRequest['fees']['foodpanda']['base'];
  fixedFee: string;
  uplift: string;
  payment: Record<ReportPaymentGroup, string>;
  riderMode: RiderCostMode;
  riderFixed: string;
}): { ok: true; value: SetChannelFeesRequest } | { ok: false; problem: string } {
  const commissionBps = parsePercent(f.commission);
  if (commissionBps === null) return { ok: false, problem: 'The commission is 0% to 100%.' };
  const upliftBps = parsePercent(f.uplift);
  if (upliftBps === null) return { ok: false, problem: 'How much dearer foodpanda is: 0% to 100%.' };
  const fixedFeeCents = parseRupees(f.fixedFee);
  if (fixedFeeCents === null || fixedFeeCents > 10_000_000) return { ok: false, problem: 'The fixed fee is Rs 0 to Rs 100,000.' };
  const paymentFeeBps = { cash: 0, card: 0, foodpanda: 0, transfer: 0 } as Record<ReportPaymentGroup, number>;
  for (const g of PAYMENT_ORDER) {
    const v = parsePercent(f.payment[g]);
    if (v === null) return { ok: false, problem: `The fee for ${PAYMENT_LABEL[g]} is 0% to 100%.` };
    paymentFeeBps[g] = v;
  }
  const fixedCents = parseRupees(f.riderFixed);
  if (fixedCents === null || fixedCents > 10_000_000) return { ok: false, problem: 'The rider cost per trip is Rs 0 to Rs 100,000.' };
  return {
    ok: true,
    value: {
      fees: { foodpanda: { commissionBps, base: f.base, fixedFeeCents, upliftBps }, paymentFeeBps },
      riderCost: { mode: f.riderMode, fixedCents },
    },
  };
}

function ChannelFeesForm({ view, canEdit }: { view: ChannelFeesView; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fp = view.fees.foodpanda;
  const [commission, setCommission] = useState(pct(fp.commissionBps));
  const [base, setBase] = useState(fp.base);
  const [fixedFee, setFixedFee] = useState(rupeesInput(fp.fixedFeeCents));
  const [uplift, setUplift] = useState(pct(fp.upliftBps));
  const [payment, setPayment] = useState<Record<ReportPaymentGroup, string>>(() => ({
    cash: pct(view.fees.paymentFeeBps.cash),
    card: pct(view.fees.paymentFeeBps.card),
    foodpanda: pct(view.fees.paymentFeeBps.foodpanda),
    transfer: pct(view.fees.paymentFeeBps.transfer),
  }));
  const [riderMode, setRiderMode] = useState<RiderCostMode>(view.riderCost.mode);
  const [riderFixed, setRiderFixed] = useState(rupeesInput(view.riderCost.fixedCents));
  const reading = readChannelFees({ commission, base, fixedFee, uplift, payment, riderMode, riderFixed });
  const dirty = reading.ok && JSON.stringify(reading.value) !== JSON.stringify({ fees: view.fees, riderCost: view.riderCost });

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
  const selectCls =
    'h-9 rounded-lg border border-stone-300 bg-white px-2 text-sm disabled:bg-stone-100 disabled:text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:disabled:bg-stone-900';

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 font-semibold">
            <Bike className="h-4 w-4" /> foodpanda, card fees and riders
          </h2>
          <p className="mt-0.5 text-sm text-stone-500">
            What a sale costs besides its food, for Reports → Profit. The till&apos;s own prices and bills never change.
          </p>
          {view.isDefault && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              Nothing is saved yet: foodpanda at 25% of the order before tax, at till prices; no card fees; the rider service&apos;s rate
              for each area.
            </p>
          )}
        </div>
        {!canEdit && (
          <p className="inline-flex items-center gap-1.5 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600 dark:bg-stone-800 dark:text-stone-300">
            <Lock className="h-4 w-4" /> Only the owner can change these.
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <fieldset className="space-y-2 text-sm">
          <legend className="mb-1 font-semibold">foodpanda</legend>
          <label className="flex flex-wrap items-center gap-2">
            Commission
            <input className={inputCls} value={commission} disabled={!canEdit} inputMode="decimal" onChange={(e) => setCommission(e.target.value)} aria-label="foodpanda commission, %" />%
          </label>
          <label className="flex flex-wrap items-center gap-2">
            of
            <select className={selectCls} value={base} disabled={!canEdit} onChange={(e) => setBase(e.target.value as typeof base)} aria-label="What the commission is taken on">
              {COMMISSION_BASES.map((b) => (
                <option key={b} value={b}>
                  {COMMISSION_BASE_LABEL[b]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            plus Rs
            <input className={inputCls} value={fixedFee} disabled={!canEdit} inputMode="decimal" onChange={(e) => setFixedFee(e.target.value)} aria-label="Fixed fee per order, rupees" />
            an order
          </label>
          <label className="flex flex-wrap items-center gap-2">
            foodpanda&apos;s menu is dearer by
            <input className={inputCls} value={uplift} disabled={!canEdit} inputMode="decimal" onChange={(e) => setUplift(e.target.value)} aria-label="How much dearer the foodpanda menu is, %" />%
          </label>
          <p className="text-xs text-stone-500">0% means foodpanda sells at the till&apos;s prices.</p>
        </fieldset>

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
