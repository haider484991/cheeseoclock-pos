/**
 * Small pure helpers behind the order ticket, kept apart from the store so
 * they can be tested without the till's IPC.
 */

interface LineLike {
  id: string;
  menuItemId: string | null;
  comboId?: string | null;
  parentOrderItemId?: string | null;
  quantity: number;
  notes: string | null;
  modifiers: ReadonlyArray<unknown>;
}

/**
 * A plain tap on an item already on the ticket as a plain line (no choices,
 * no note, not part of a deal) adds one to that line instead of a second
 * "1 × Coke" row. A line with a leave-out, an extra or an allergy note is
 * never merged into — it is that one customer's item.
 */
export function findMergeableLine<T extends LineLike>(
  items: ReadonlyArray<T>,
  menuItemId: string,
  modifierIds: ReadonlyArray<string>,
  notes: string | null | undefined,
): T | null {
  if (modifierIds.length > 0 || (notes ?? '').trim() !== '') return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const line = items[i]!;
    if (
      line.menuItemId === menuItemId &&
      line.modifiers.length === 0 &&
      !(line.notes ?? '').trim() &&
      !line.comboId &&
      !line.parentOrderItemId
    ) {
      return line;
    }
  }
  return null;
}

/** The line that is on `next` but was not on `prev` (the one just added). */
export function addedLineId(
  prev: ReadonlyArray<{ id: string }>,
  next: ReadonlyArray<{ id: string }>,
): string | null {
  const before = new Set(prev.map((l) => l.id));
  for (let i = next.length - 1; i >= 0; i--) {
    if (!before.has(next[i]!.id)) return next[i]!.id;
  }
  return null;
}

/**
 * Run async jobs one after another, in the order they were asked for. Taps on
 * the menu arrive faster than the till answers; run side by side, two quick
 * first taps each created their own order, and quick "+" taps each read the
 * same old quantity. A job that fails does not stop the ones behind it.
 * `onBusy` hears true when work starts and false when the queue empties.
 */
export function createSerialQueue(onBusy: (busy: boolean) => void) {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return function run<T>(job: () => Promise<T>): Promise<T> {
    pending += 1;
    if (pending === 1) onBusy(true);
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result.finally(() => {
      pending -= 1;
      if (pending === 0) onBusy(false);
    });
  };
}
