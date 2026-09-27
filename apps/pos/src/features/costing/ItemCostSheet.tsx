import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ChoiceCostView, CostLineView, ItemCostSheet, PaidExtraView, RequiredGroupView } from '@cheeseoclock/shared-types';
import { BookOpen, ChevronDown, ChevronRight, Printer, X } from 'lucide-react';
import { useItemCostSheet } from './costingQueries';
import { FoodCostChip } from './CostChip';
import { BatchBreakdown } from './BatchBreakdown';
import {
  FLAG_LABEL,
  atLeast,
  cantCostReason,
  formatBps,
  formatHundredths,
  formatQtyUnit,
  formatUnitPrice,
  hasMissing,
  leaveOutText,
  madeOfNote,
  priceKindNote,
} from './costingFormat';
import { costSheetPrintHtml } from './costSheetPrint';
import { openRecipeInInventory } from './deepLinks';
import { usePrintSheet } from './usePrintSheet';

/**
 * One item's cost sheet, in a drawer: what is always in it (a sauce or dough
 * made in-house opens up into what it is made of), each choice the customer
 * must make with what every option costs and how often it is picked, the
 * paid extras (price, cost, what you keep) and what each leave-out saves.
 */
export function ItemCostSheetDrawer({ menuItemId, onClose }: { menuItemId: string; onClose: () => void }) {
  const q = useItemCostSheet(menuItemId);
  const navigate = useNavigate();
  const printer = usePrintSheet();
  const sheet = q.data ?? null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[720px] max-w-full flex-col bg-white shadow-soft-lg dark:bg-stone-900">
          <header className="flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4 dark:border-stone-700">
            <div className="min-w-0">
              <Dialog.Title className="text-xl font-bold">{sheet?.row.name ?? 'Cost sheet'}</Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                  {sheet ? <Headline sheet={sheet} /> : q.isLoading ? 'Working out the cost…' : 'This item is no longer on the menu.'}
                </div>
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          {sheet && (
            <div className="flex-1 space-y-5 overflow-auto px-5 py-4">
              <section>
                <h3 className="mb-1 flex items-baseline justify-between text-sm font-semibold uppercase tracking-wider text-stone-500">
                  <span>Always in it</span>
                  <span className="font-mono normal-case tracking-normal text-stone-800 dark:text-stone-100">
                    {atLeast(sheet.alwaysCostCents, hasMissing(sheet.always))}
                  </span>
                </h3>
                {sheet.always.length > 0 ? (
                  <LineTable lines={sheet.always} shareOf="of a typical plate's cost (choices included)" />
                ) : (
                  <p className="text-sm text-stone-500">
                    {sheet.row.hasRecipe ? 'Nothing: everything comes from the choices below.' : 'No recipe yet: nothing is known about what goes into it.'}
                  </p>
                )}
              </section>

              {sheet.groups.map((g) => (
                <GroupSection key={g.groupId} group={g} />
              ))}

              {sheet.paidExtras.length > 0 && <PaidExtras extras={sheet.paidExtras} />}

              {sheet.leaveOuts.length > 0 && (
                <section>
                  <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-stone-500">Leave-outs</h3>
                  <ul className="divide-y divide-stone-100 text-sm dark:divide-stone-800">
                    {sheet.leaveOuts.map((l) => (
                      <li key={l.modifierId} className="flex justify-between py-1.5">
                        <span>
                          {l.name} <span className="text-stone-500">({l.ingredientName})</span>
                        </span>
                        <span className={cn('font-mono', l.missingLines > 0 && 'text-stone-500')}>{leaveOutText(l)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <p className="text-xs text-stone-500">
                At today&apos;s prices, from the recipe as it is now; the menu price is before tax. Sold on this till in the
                last 28 days: {new Intl.NumberFormat('en-PK').format(sheet.row.soldLast28)}.
              </p>
            </div>
          )}

          <footer className="flex items-center gap-2 border-t border-stone-200 px-5 py-3 dark:border-stone-700">
            <Button
              variant="secondary"
              size="sm"
              disabled={!sheet}
              onClick={() => sheet && openRecipeInInventory(navigate, { id: sheet.row.menuItemId, name: sheet.row.name })}
            >
              <BookOpen className="h-4 w-4" /> Open recipe
            </Button>
            <Button variant="secondary" size="sm" disabled={!sheet} onClick={() => sheet && printer.print(costSheetPrintHtml(sheet))}>
              <Printer className="h-4 w-4" /> Print cost sheet
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
              Close
            </Button>
          </footer>
          {printer.portal}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Headline({ sheet }: { sheet: ItemCostSheet }) {
  const r = sheet.row;
  if (r.flag === 'grey') {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <FoodCostChip flag={r.flag} bps={r.foodCostBps} />
        {cantCostReason(r)}, so the cost is not known.
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span>
        Costs <b className="text-stone-900 dark:text-stone-100">{formatCents(r.costCents)}</b> to make, you keep{' '}
        <b className="text-stone-900 dark:text-stone-100">{formatCents(r.profitCents)}</b> per sale at {formatCents(r.priceCents)}.
      </span>
      <FoodCostChip flag={r.flag} bps={r.foodCostBps} targetBps={r.targetBps} />
      <span className="text-xs text-stone-500">
        {FLAG_LABEL[r.flag]} · target {formatBps(r.targetBps)}
        {r.targetConfirmed ? '' : ' (suggested)'}
      </span>
    </span>
  );
}

/**
 * Ingredient lines with amount, price, cost and share; a batch line opens
 * into what it is made of. `shareOf` says what the share is of (the typical
 * plate, or this choice).
 */
function LineTable({ lines, compact, shareOf = "of this choice's cost" }: { lines: readonly CostLineView[]; compact?: boolean; shareOf?: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <table className={cn('w-full', compact ? 'text-xs' : 'text-sm')}>
      {!compact && (
        <thead className="text-left text-[11px] uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-1 font-medium">Ingredient</th>
            <th className="pb-1 text-right font-medium">Amount</th>
            <th className="pb-1 text-right font-medium">Price</th>
            <th className="pb-1 text-right font-medium">Cost</th>
            <th className="w-28 pb-1 pl-3 font-medium">Share</th>
          </tr>
        </thead>
      )}
      <tbody>
        {lines.map((l, i) => {
          const note = priceKindNote(l.priceKind);
          const key = `${l.ingredientId}-${i}`;
          const expanded = !!open[key];
          return (
            <Fragment key={key}>
              <tr className="border-t border-stone-100 dark:border-stone-800">
                <td className="py-1">
                  {l.madeOf ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
                      className="inline-flex items-center gap-1 text-left font-medium text-amber-800 hover:underline dark:text-amber-300"
                      title="Made here: show what it is made of"
                    >
                      {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      {l.name}
                    </button>
                  ) : (
                    l.name
                  )}
                  {note && (
                    <span
                      className={cn(
                        'ml-1.5 rounded px-1 text-[10px]',
                        note === 'no price yet' ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200' : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
                      )}
                    >
                      {note}
                    </span>
                  )}
                </td>
                <td className="py-1 text-right font-mono">{formatQtyUnit(l.qty, l.unit)}</td>
                <td className="py-1 text-right font-mono text-stone-500">{formatUnitPrice(l.unitCostMc, l.unit)}</td>
                <td className="py-1 text-right font-mono">{formatCents(l.costCents)}</td>
                <td className="py-1 pl-3">
                  <ShareBar bps={l.shareBps} of={shareOf} />
                </td>
              </tr>
              {expanded && l.madeOf && (
                <tr>
                  <td colSpan={5} className="pb-2">
                    <div className="rounded-lg bg-amber-50/70 p-2 dark:bg-amber-950/30">
                      {madeOfNote(l, l.madeOf) && (
                        <p className="mb-1 text-xs font-medium text-red-700 dark:text-red-400">{madeOfNote(l, l.madeOf)}</p>
                      )}
                      <div className="mb-1 text-xs text-stone-600 dark:text-stone-400">
                        {formatHundredths(l.qty * 100, l.unit)} of {l.name} is made of (one batch makes{' '}
                        {formatQtyUnit(l.madeOf.batchYield, l.madeOf.unit)}):
                      </div>
                      <BatchBreakdown calc={l.madeOf} />
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function ShareBar({ bps, of }: { bps: number | null; of: string }) {
  if (bps === null) return null;
  const pct = Math.max(0, Math.min(100, bps / 100));
  return (
    <div className="flex items-center gap-1.5" title={`${formatBps(bps)} ${of}`}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700" aria-hidden>
        <div className="h-full rounded-full bg-amber-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right font-mono text-[11px] text-stone-500">{formatBps(bps)}</span>
    </div>
  );
}

function picksText(g: RequiredGroupView): string {
  const n = g.kMin === g.kMax ? `${g.kMin}` : `${g.kMin} to ${g.kMax}`;
  return `The customer picks ${n}.`;
}

function GroupSection({ group: g }: { group: RequiredGroupView }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // An option with no price counts as Rs 0: every figure of the group is then only a floor.
  const partial = g.options.some((o) => o.missingLines > 0);
  return (
    <section>
      <h3 className="mb-1 flex items-baseline justify-between text-sm font-semibold uppercase tracking-wider text-stone-500">
        <span>Customer picks: {g.name}</span>
        <span className="font-mono normal-case tracking-normal text-stone-800 dark:text-stone-100">usually {atLeast(g.typicalCostCents, partial)}</span>
      </h3>
      <p className="mb-1 text-xs text-stone-500">
        {picksText(g)}{' '}
        {g.basis === 'observed'
          ? 'Weighted by what customers picked in the last 28 days.'
          : `Not enough sales yet, so it counts ${g.kMax} × the average option.`}{' '}
        Cheapest {atLeast(g.cheapestCostCents, partial)}, dearest {atLeast(g.dearestCostCents, partial)}.
        {g.typicalPriceCents > 0 && <> Customers usually pay {formatCents(g.typicalPriceCents)} extra here.</>}
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-1 font-medium">Option</th>
            <th className="pb-1 text-right font-medium">Extra price</th>
            <th className="pb-1 text-right font-medium">Cost</th>
            <th className="pb-1 text-right font-medium">Picked</th>
          </tr>
        </thead>
        <tbody>
          {g.options.map((o) => (
            <OptionRow key={o.modifierId} option={o} open={!!open[o.modifierId]} onToggle={() => setOpen((s) => ({ ...s, [o.modifierId]: !s[o.modifierId] }))} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function OptionRow({ option: o, open, onToggle }: { option: ChoiceCostView; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="border-t border-stone-100 dark:border-stone-800">
        <td className="py-1">
          {o.lines.length > 0 ? (
            <button type="button" aria-expanded={open} onClick={onToggle} className="inline-flex items-center gap-1 text-left hover:underline">
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {o.name}
            </button>
          ) : (
            <span className="pl-[18px]">
              {o.name} <span className="text-xs text-stone-400">(no recipe lines)</span>
            </span>
          )}
          {o.missingLines > 0 && (
            <span className="ml-1.5 rounded bg-red-100 px-1 text-[10px] text-red-800 dark:bg-red-950 dark:text-red-200">no price yet</span>
          )}
        </td>
        <td className="py-1 text-right font-mono text-stone-500">{o.priceDeltaCents ? formatCents(o.priceDeltaCents) : '—'}</td>
        <td className="py-1 text-right font-mono">{atLeast(o.costCents, o.missingLines > 0)}</td>
        <td className="py-1 text-right font-mono text-stone-500">{o.pickedShareBps === null ? '—' : formatBps(o.pickedShareBps)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="pb-2 pl-5">
            <LineTable lines={o.lines} compact />
          </td>
        </tr>
      )}
    </>
  );
}

function PaidExtras({ extras }: { extras: readonly PaidExtraView[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-stone-500">Paid extras</h3>
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-1 font-medium">Extra</th>
            <th className="pb-1 text-right font-medium">Price</th>
            <th className="pb-1 text-right font-medium">Cost</th>
            <th className="pb-1 text-right font-medium">You keep</th>
            <th className="pb-1 text-center font-medium">Food cost</th>
          </tr>
        </thead>
        <tbody>
          {extras.map((x) => {
            const expanded = !!open[x.modifierId];
            return (
              <Fragment key={x.modifierId}>
                <tr className="border-t border-stone-100 dark:border-stone-800">
                  <td className="py-1">
                    {x.lines.length > 0 ? (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setOpen((s) => ({ ...s, [x.modifierId]: !s[x.modifierId] }))}
                        className="inline-flex items-center gap-1 text-left hover:underline"
                      >
                        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        {x.name}
                      </button>
                    ) : (
                      <span className="pl-[18px]">{x.name}</span>
                    )}
                    <span className="ml-2 text-xs text-stone-500">{x.groupName}</span>
                  </td>
                  <td className="py-1 text-right font-mono">{formatCents(x.priceDeltaCents)}</td>
                  <td className="py-1 text-right font-mono">{x.flag === 'grey' ? '—' : formatCents(x.costCents)}</td>
                  <td className="py-1 text-right font-mono">{x.flag === 'grey' ? '—' : formatCents(x.marginCents)}</td>
                  <td className="py-1 text-center">
                    <FoodCostChip flag={x.flag} bps={x.foodCostBps} />
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={5} className="pb-2 pl-5">
                      <LineTable lines={x.lines} compact />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
