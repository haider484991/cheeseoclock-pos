import { cn } from '@cheeseoclock/ui';
import type { OrderPaperLine } from '@cheeseoclock/shared-types';
import { paperLineText } from './paperLabels';

/** Under the list: the rule the lines follow (the owner's, 27 Sep 2026). */
export const PAPERS_RULE_NOTE =
  'The bill or receipt the till prints by itself is the original. Any paper printed with a print button says DUPLICATE, even the first one.';

/**
 * The order panel's "Papers printed": every bill, receipt, slip and kitchen
 * ticket the order had on either till, oldest first, each with what it said
 * at the top ("19:35 RECEIPT — Original — at payment — Ali",
 * "19:52 RECEIPT — DUPLICATE Reprint #1 — Sana (approved by Owner)").
 * Collapsed until opened; nothing when nothing printed. Anyone who may open
 * the order may read it.
 */
export function PapersPrinted({ papers, orderCreatedAt }: { papers: readonly OrderPaperLine[]; orderCreatedAt: string }) {
  if (papers.length === 0) return null;
  return (
    <details className="group rounded-lg border border-stone-200 dark:border-stone-700" data-testid="papers-printed">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
        Papers printed ({papers.length})
      </summary>
      <ol className="space-y-1 px-3 pb-3 text-xs text-stone-600 dark:text-stone-300">
        {papers.map((p, i) => (
          <li key={`${p.at}-${i}`} className={cn(p.duplicate && p.copy !== 'kitchen' && 'font-semibold')}>
            {paperLineText(p, orderCreatedAt)}
          </li>
        ))}
      </ol>
      <p className="px-3 pb-3 text-[11px] text-stone-400">{PAPERS_RULE_NOTE}</p>
    </details>
  );
}
