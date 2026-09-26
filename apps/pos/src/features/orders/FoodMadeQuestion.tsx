import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@cheeseoclock/ui';
import { ChefHat, CupSoda, Trash2, Undo2 } from 'lucide-react';
import { drinksGoBackByDefault, foodMadeQuestion } from '@cheeseoclock/pos-domain';
import type {
  FoodMade,
  FoodMadeQuestion as Question,
  OrderSnapshot,
  OrderStatus,
  OrderStockAnswer,
  OrderStockStatus,
} from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import {
  answerFromReason,
  drinkLines,
  kitchenLine,
  lineText,
  outcomePreview,
  stockNotes,
  type AnsweredBy,
} from './stockCopy';

/**
 * "Was the food made?" — the state behind the question in the Cancel and
 * Refund dialogs. Reads the order's stock fresh when the dialog opens (never
 * from cache: the kitchen may have tapped a button since), and turns the
 * answer into what the server needs. The server checks it all again.
 */
export interface FoodMadeAnswer {
  /** Still reading the order's stock: hold the confirm button. */
  loading: boolean;
  /** Could not read it: the question is still asked (from the order's status). */
  failed: boolean;
  status: OrderStockStatus | undefined;
  /** The order's status as the question sees it (fresh when it could be read). */
  orderStatus: OrderStatus;
  /** Null when there is nothing to ask (no stock held here). */
  question: Question | null;
  answer: FoodMade | null;
  /** A tap on Made / Not made. */
  setAnswer: (a: FoodMade) => void;
  /**
   * A reason chip was picked: its answer fills the question only while
   * nobody has answered it (stockCopy answerFromReason).
   */
  pickReason: (reasons: ReadonlyArray<{ label: string; foodMade?: FoodMade }>, label: string) => void;
  /** Sealed drinks going back to the fridge although the food was made. */
  drinksBack: ReadonlySet<string>;
  toggleDrink: (ingredientId: string) => void;
  /** The question needs a tap that has not happened. */
  missing: boolean;
  /** The stock half of the request. */
  payload: () => OrderStockAnswer;
}

export function useFoodMadeAnswer(snap: OrderSnapshot): FoodMadeAnswer {
  const q = useQuery({
    queryKey: ['orders', 'stock', snap.order.id],
    queryFn: () => ipc.orders.stockStatus(snap.order.id),
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });
  const [chosen, setChosen] = useState<FoodMade | null>(null);
  const [answeredBy, setAnsweredBy] = useState<AnsweredBy>(null);
  // Drinks tapped away from the default (back in the fridge, or waste).
  const [drinkFlipped, setDrinkFlipped] = useState<ReadonlySet<string>>(new Set());

  const status = q.data;
  const orderStatus = status?.status ?? snap.order.status;
  // When the stock can't be read, still ask — decided from the order's status
  // (the server refuses if the order holds no stock needing an answer anyway).
  const question: Question | null = status
    ? status.question
    : q.isError
      ? foodMadeQuestion({ status: snap.order.status, takenAt: null, now: Date.now() })
      : null;
  const answer: FoodMade | null =
    question === null ? null : question.ask === 'made_only' ? 'made' : (chosen ?? question.preselect);
  const drinks = status ? drinkLines(status) : [];
  // The same default the till applies (a dine-in table's drinks are gone).
  const backByDefault = drinksGoBackByDefault(snap.order.mode, orderStatus);
  const drinksBack = new Set(
    drinks.filter((d) => backByDefault !== drinkFlipped.has(d.ingredientId)).map((d) => d.ingredientId),
  );

  return {
    loading: q.isLoading,
    failed: q.isError,
    status,
    orderStatus,
    question,
    answer,
    setAnswer: (a) => {
      setChosen(a);
      setAnsweredBy('staff');
    },
    pickReason: (reasons, label) => {
      const next = answerFromReason(reasons, label, question, answeredBy);
      if (next.keep) return;
      setChosen(next.answer);
      setAnsweredBy(next.answer === null ? null : 'reason');
    },
    drinksBack,
    toggleDrink: (id) =>
      setDrinkFlipped((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    missing: question !== null && question.ask === 'choose' && answer === null,
    payload: () => {
      const out: OrderStockAnswer = { expectStatus: orderStatus };
      if (question === null || answer === null) return out;
      out.foodMade = answer;
      // An explicit list only when the lines were read; else the till's own
      // default (pos-domain drinksGoBackByDefault — the same one shown here).
      if (answer === 'made' && status) out.putBack = [...drinksBack];
      return out;
    },
  };
}

/**
 * The question itself: two big buttons, a hint (never an answer while the
 * order is still "sent to kitchen"), what will move, and what the kitchen
 * hears. Once the food left the shop there is nothing to choose: one line.
 */
export function FoodMadeQuestion({ fm, shortNumber }: { fm: FoodMadeAnswer; shortNumber: string }) {
  if (fm.loading) {
    return (
      <div className="rounded-xl border border-stone-200 p-3 text-xs text-stone-500 dark:border-stone-700">Checking stock…</div>
    );
  }
  const q = fm.question;
  if (!q) return null;
  const status = fm.status;
  const notes = status ? stockNotes(status) : [];
  const kitchen = kitchenLine(fm.orderStatus, status?.kitchenTicket, shortNumber);
  const preview = status ? outcomePreview(status, fm.answer, fm.drinksBack).filter((t) => !t.endsWith('goes back to the fridge')) : [];
  const drinks = status && fm.answer === 'made' ? drinkLines(status) : [];

  return (
    <section
      aria-label="Was the food made?"
      className="space-y-2 rounded-xl border border-stone-200 p-3 dark:border-stone-700"
    >
      {q.ask === 'made_only' ? (
        <div>
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Trash2 className="h-4 w-4 text-red-600" />
            The food left the shop, so it counts as waste
          </div>
          <div className="mt-0.5 text-xs text-stone-500">{q.hint}</div>
        </div>
      ) : (
        <>
          <div>
            <div className="text-sm font-semibold">Was the food made?</div>
            {q.hint && <div className="mt-0.5 text-xs text-stone-500">{q.hint}</div>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <AnswerButton
              pressed={fm.answer === 'not_made'}
              onClick={() => fm.setAnswer('not_made')}
              icon={<Undo2 className="h-4 w-4" />}
              title="Not made"
              sub="Put the stock back"
              tone="emerald"
            />
            <AnswerButton
              pressed={fm.answer === 'made'}
              onClick={() => fm.setAnswer('made')}
              icon={<ChefHat className="h-4 w-4" />}
              title="Made"
              sub="Food is gone — counts as waste"
              tone="red"
            />
          </div>
        </>
      )}

      {preview.map((t) => (
        <div key={t} className="text-xs text-stone-600 dark:text-stone-300">
          {t}
        </div>
      ))}
      {drinks.map((d) => {
        const back = fm.drinksBack.has(d.ingredientId);
        return (
          <div key={d.ingredientId} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-stone-600 dark:text-stone-300">
              <CupSoda className="h-3.5 w-3.5" />
              {lineText(d)}
            </span>
            <button
              type="button"
              aria-pressed={back}
              onClick={() => fm.toggleDrink(d.ingredientId)}
              className={cn(
                'rounded-full px-2.5 py-1 font-semibold ring-1',
                back
                  ? 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800'
                  : 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-800',
              )}
            >
              {back ? 'Back in the fridge' : 'Waste'}
            </button>
          </div>
        );
      })}
      {q.ask === 'choose' && (
        <div className="text-[11px] text-stone-500">
          Some made, some not? Choose Made, then put the unmade items back in Inventory → Stock.
        </div>
      )}
      {kitchen && <div className="text-xs font-semibold text-amber-800 dark:text-amber-200">{kitchen}</div>}
      {fm.failed && <div className="text-xs text-amber-800 dark:text-amber-200">Could not check the stock — answer anyway.</div>}
      {notes.map((n) => (
        <div key={n} className="text-xs text-stone-500">
          {n}
        </div>
      ))}
    </section>
  );
}

function AnswerButton({
  pressed,
  onClick,
  icon,
  title,
  sub,
  tone,
}: {
  pressed: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  sub: string;
  tone: 'emerald' | 'red';
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex h-16 flex-col items-start justify-center rounded-xl border-2 px-3 text-left transition-colors',
        pressed
          ? tone === 'emerald'
            ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100'
            : 'border-red-500 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100'
          : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200',
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-bold">
        {icon}
        {title}
      </span>
      <span className="text-[11px] opacity-80">{sub}</span>
    </button>
  );
}
