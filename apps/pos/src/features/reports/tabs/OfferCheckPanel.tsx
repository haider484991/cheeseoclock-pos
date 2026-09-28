/**
 * Reports → Team & leakage → "Came by & offers": the owner's check on his
 * automatic offers (Settings → Money & discounts). An offer is money a
 * cashier could claim by tapping the wrong button (Phone or WhatsApp on a
 * cash walk-in) and keeping the difference, so each cashier's share of
 * counter orders marked Phone or WhatsApp and what the offers took off their
 * orders are shown against the shop's own over the same period; anyone over
 * 1.5 × the shop's, with enough orders to tell, is flagged (pos-domain
 * offerFlags). Shown once there is something to compare.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportOfferCheck, ReportStaffLine } from '@cheeseoclock/shared-types';
import { AlertTriangle } from 'lucide-react';
import { DataTable, Panel } from '../reportUi';
import { OFFER_FLAG_WORDS, offerCheckNote, percentOf } from '../reportFormat';

export function OfferCheckPanel({ staff, check }: { staff: ReportStaffLine[]; check: ReportOfferCheck | undefined }) {
  if (!check || check.counterOrders === 0 || (check.phoneOrWhatsapp === 0 && check.offerCents === 0)) return null;
  const rows = staff.filter((s) => !s.isWebsite && (s.counterOrders ?? 0) > 0);
  return (
    <Panel title="Came by & offers" note={offerCheckNote(check)} className="xl:col-span-2">
      <DataTable
        columns={[
          { label: 'Taken by' },
          { label: 'Counter orders', right: true },
          { label: 'Phone / WhatsApp', right: true },
          { label: 'With an offer', right: true },
          { label: 'Offers took off', right: true },
          { label: 'Flag' },
        ]}
        rows={rows.map((s) => [
          <span key="n" className="font-medium">{s.name}</span>,
          s.counterOrders ?? 0,
          <span key="p">
            {s.phoneOrWhatsapp ?? 0} <span className="text-xs text-stone-500">{percentOf(s.phoneOrWhatsapp ?? 0, s.counterOrders ?? 0)}</span>
          </span>,
          s.offerCount ?? 0,
          (s.offerCents ?? 0) > 0 ? formatCents(s.offerCents ?? 0) : '—',
          s.flags && s.flags.length > 0 ? (
            <span key="f" className="inline-flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              {s.flags.map((f) => OFFER_FLAG_WORDS[f]).join(', ')}
            </span>
          ) : (
            '—'
          ),
        ])}
        empty="None."
      />
    </Panel>
  );
}
