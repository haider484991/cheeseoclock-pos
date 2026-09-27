import { Fragment, useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { BatchCalc } from '@cheeseoclock/shared-types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatBps, formatHundredths, formatQtyUnit, formatUnitPrice, madeOfNote, priceKindNote } from './costingFormat';

/**
 * What an amount of a batch item is made of: every input scaled (the exact
 * amount, and the whole units stock moves), its price, its cost and its
 * share of the batch. An input made in-house opens up the same way.
 * `showStock`: the "Taken from stock" column (the batch calculator).
 */
export function BatchBreakdown({ calc, showStock = false, depth = 0 }: { calc: BatchCalc; showStock?: boolean; depth?: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <table className={cn('w-full text-xs', depth > 0 && 'mt-1')}>
      {depth === 0 && (
        <thead className="text-left text-[11px] uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-1 font-medium">Ingredient</th>
            <th className="pb-1 text-right font-medium">Amount</th>
            {showStock && <th className="pb-1 text-right font-medium">From stock</th>}
            <th className="pb-1 text-right font-medium">Price</th>
            <th className="pb-1 text-right font-medium">Cost</th>
            <th className="pb-1 text-right font-medium">Share</th>
          </tr>
        </thead>
      )}
      <tbody>
        {calc.lines.map((l) => {
          const note = priceKindNote(l.priceKind);
          const expanded = !!open[l.inputId];
          return (
            <Fragment key={l.inputId}>
              <tr className="border-t border-stone-100 dark:border-stone-800">
                <td className="py-1" style={{ paddingLeft: depth * 14 }}>
                  {l.madeOf ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-left font-medium text-amber-800 hover:underline dark:text-amber-300"
                      onClick={() => setOpen((o) => ({ ...o, [l.inputId]: !o[l.inputId] }))}
                      aria-expanded={expanded}
                    >
                      {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {l.name}
                    </button>
                  ) : (
                    <span>{l.name}</span>
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
                <td className="py-1 text-right font-mono">{formatHundredths(l.scaledHundredths, l.unit)}</td>
                {showStock && (
                  <td
                    className={cn('py-1 text-right font-mono', l.stockQty * 100 !== l.scaledHundredths && 'text-amber-700 dark:text-amber-300')}
                    title={l.stockQty * 100 !== l.scaledHundredths ? 'Stock is counted in whole units, so this is rounded' : undefined}
                  >
                    {formatQtyUnit(l.stockQty, l.unit)}
                  </td>
                )}
                <td className="py-1 text-right font-mono text-stone-500">{formatUnitPrice(l.unitCostMc, l.unit)}</td>
                <td className="py-1 text-right font-mono">{formatCents(l.costCents)}</td>
                <td className="py-1 text-right font-mono text-stone-500">{l.shareBps === null ? '—' : formatBps(l.shareBps)}</td>
              </tr>
              {expanded && l.madeOf && (
                <tr>
                  <td colSpan={showStock ? 6 : 5} className="pb-1">
                    <div className="rounded bg-amber-50/60 px-1 py-0.5 dark:bg-amber-950/30">
                      {madeOfNote(l, l.madeOf) && (
                        <p className="text-[11px] font-medium text-red-700 dark:text-red-400" style={{ paddingLeft: (depth + 1) * 14 }}>
                          {madeOfNote(l, l.madeOf)}
                        </p>
                      )}
                      <div className="pl-2 text-[11px] text-stone-500" style={{ paddingLeft: (depth + 1) * 14 }}>
                        {formatHundredths(l.scaledHundredths, l.unit)} of {l.name} is made of:
                      </div>
                      <BatchBreakdown calc={l.madeOf} depth={depth + 1} />
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
