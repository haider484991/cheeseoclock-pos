import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import type { MissingPriceRow } from '@cheeseoclock/shared-types';
import { BookOpen, CheckCircle2, Gift, Pencil, Soup } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { COSTING_KEY, useMissingCosts } from './costingQueries';
import { formatBps } from './costingFormat';
import { openBatchInInventory, openIngredientInInventory, openRecipeInInventory } from './deepLinks';

/**
 * Missing costs: everything that keeps a dish from being costed, each with
 * the one step that fixes it — "Set price" or "Mark free" (Inventory →
 * Ingredients), "Open recipe" (Inventory → Recipes). When every list is
 * empty, every dish can be costed.
 */
export function MissingCostsTab() {
  const q = useMissingCosts();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const m = q.data;

  const freeMut = useMutation({
    mutationFn: (row: MissingPriceRow) => ipc.inventory.updateIngredient({ id: row.ingredientId, priceKind: 'free' }),
    onSuccess: (i) => {
      toast({ title: `${i.name} now costs nothing`, description: 'It counts as Rs 0 in every dish that uses it.', variant: 'success' });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) => toast({ title: 'Could not mark it free', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const setPrice = (row: MissingPriceRow) => openIngredientInInventory(navigate, { id: row.ingredientId, name: row.name });

  if (!m) {
    return <Card className="py-8 text-center text-stone-500">{q.isError ? 'Could not check the costs.' : 'Checking…'}</Card>;
  }
  if (m.total === 0) {
    return (
      <Card className="flex items-center gap-3 py-6">
        <CheckCircle2 className="h-6 w-6 text-emerald-600" />
        <div>
          <p className="font-semibold">Nothing missing</p>
          <p className="text-sm text-stone-500">Every dish can be costed from real prices.</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {m.unpriced.length > 0 && (
        <Block
          title="Ingredients with no price"
          note="Used in recipes but never priced. Give each a price, or mark it free if it really costs nothing."
          count={m.unpriced.length}
        >
          {m.unpriced.map((r) => (
            <PriceRow key={r.ingredientId} row={r}>
              <Button variant="primary" size="sm" onClick={() => setPrice(r)}>
                <Pencil className="h-3.5 w-3.5" /> Set price
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={freeMut.isPending}
                onClick={() =>
                  void askConfirm(`Mark "${r.name}" as free?\n\nIt will count as Rs 0 in every dish that uses it.`).then((ok) => {
                    if (ok) freeMut.mutate(r);
                  })
                }
              >
                <Gift className="h-3.5 w-3.5" /> Mark free
              </Button>
            </PriceRow>
          ))}
        </Block>
      )}

      {m.noRecipe.length > 0 && (
        <Block title="Food items with no recipe" note="Nothing is known about what goes into these, so they cannot be costed." count={m.noRecipe.length}>
          {m.noRecipe.map((r) => (
            <Row
              key={r.menuItemId}
              title={r.name}
              detail={`${r.categoryName}${r.soldLast28 > 0 ? ` · ${new Intl.NumberFormat('en-PK').format(r.soldLast28)} sold in the last 28 days` : ''}`}
            >
              <Button variant="primary" size="sm" onClick={() => openRecipeInInventory(navigate, { id: r.menuItemId, name: r.name })}>
                <BookOpen className="h-3.5 w-3.5" /> Open recipe
              </Button>
            </Row>
          ))}
        </Block>
      )}

      {m.guessed.length > 0 && (
        <Block title="Prices that are a guess" note="These dishes are costed, but on a guessed price. Put in the real one when you have it." count={m.guessed.length}>
          {m.guessed.map((r) => (
            <PriceRow key={r.ingredientId} row={r}>
              <Button variant="secondary" size="sm" onClick={() => setPrice(r)}>
                <Pencil className="h-3.5 w-3.5" /> Set price
              </Button>
            </PriceRow>
          ))}
        </Block>
      )}

      {m.roundedPerGram.length > 0 && (
        <Block
          title="Prices per gram rounded to whole paisa"
          note="Saved as a price per gram (or ml), which rounds to whole paisa. Re-enter it as the pack you buy, e.g. 1,000 g for Rs 375."
          count={m.roundedPerGram.length}
        >
          {m.roundedPerGram.map((r) => (
            <PriceRow key={r.ingredientId} row={r}>
              <Button variant="secondary" size="sm" onClick={() => setPrice(r)}>
                <Pencil className="h-3.5 w-3.5" /> Re-enter per kg
              </Button>
            </PriceRow>
          ))}
        </Block>
      )}

      {m.batches.length > 0 && (
        <Block
          title="Batches with inputs that have no price"
          note="A sauce, dough or mix made here is costed from what goes into it. Until every input has a price, it keeps its old price."
          count={m.batches.length}
        >
          {m.batches.map((b) => (
            <Row
              key={b.ingredientId}
              title={b.name}
              detail={
                b.loop
                  ? 'Its inputs lead back to itself, so it cannot be costed: check the batch recipe.'
                  : `No price yet: ${b.unpricedInputs.map((i) => i.name).join(', ')}`
              }
            >
              {/* The fix is a price on each input; an input deleted since can only be taken out of the recipe. */}
              {b.unpricedInputs
                .filter((i) => !i.gone)
                .map((i) => (
                  <Button
                    key={i.ingredientId}
                    variant="primary"
                    size="sm"
                    onClick={() => openIngredientInInventory(navigate, { id: i.ingredientId, name: i.name })}
                    title={`Set the price of ${i.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Set price: {i.name}
                  </Button>
                ))}
              <Button variant="secondary" size="sm" onClick={() => openBatchInInventory(navigate, b.ingredientId)}>
                <Soup className="h-3.5 w-3.5" /> Open batch recipe
              </Button>
            </Row>
          ))}
        </Block>
      )}
    </div>
  );
}

function Block({ title, note, count, children }: { title: string; note: string; count: number; children: ReactNode }) {
  return (
    <Card>
      <h2 className="flex items-center gap-2 font-semibold">
        {title}
        <span className="rounded-full bg-red-100 px-2 text-xs font-bold tabular-nums text-red-800 dark:bg-red-950 dark:text-red-200">{count}</span>
      </h2>
      <p className="mb-2 text-sm text-stone-500">{note}</p>
      <ul className="divide-y divide-stone-100 dark:divide-stone-800">{children}</ul>
    </Card>
  );
}

function Row({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-stone-500">{detail}</div>
      </div>
      <div className="flex flex-none flex-wrap justify-end gap-1.5">{children}</div>
    </li>
  );
}

/** "Used in Fajita Pizza, Veggie Lovers and 3 more · 18% of the last 28 days' sales". */
function usedIn(r: MissingPriceRow): string {
  if (r.items.length === 0) return 'Not used by any food item right now';
  const shown = r.items.slice(0, 3).join(', ');
  const more = r.items.length > 3 ? ` and ${r.items.length - 3} more` : '';
  const share = r.salesShareBps !== null && r.salesShareBps > 0 ? ` · ${formatBps(r.salesShareBps)} of the last 28 days' sales` : '';
  return `Used in ${shown}${more}${share}`;
}

function PriceRow({ row, children }: { row: MissingPriceRow; children: ReactNode }) {
  return (
    <Row title={row.name} detail={usedIn(row)}>
      {children}
    </Row>
  );
}
