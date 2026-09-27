/**
 * The Dashboard's "Do this" list (costing spec 4.17, Phase 7): ONE ranked
 * list of what to fix, each line with what it costs per week.
 *
 *  - A key ingredient at or under its low-stock level is pinned first (at
 *    most two such lines: more rank with the rest, see DO_THIS_MAX_PINNED).
 *  - Everything else by rupees per week, most first.
 *  - At most five lines.
 *  - A line that carries costs is only for a login that may see costs
 *    (COST_CAPABILITY): its check does not even run for anyone else.
 *
 * The lines come from SOURCES, one per kind of problem. Phase 7 registers
 * low stock, items over target, missing costs and price alerts
 * (services/analytics/owner-week.ts); later phases add their own source to
 * that list — stock variance (Phase 8), leakage flags (Phase 10) — and the
 * ranking here takes them as they come. Pure, so the ranking is tested alone.
 */
/** What the ranking needs of a line. */
export interface DoThisCandidate {
  kind: string;
  key: string;
  /** Rupees (paisa) per week; null when the line has none (it then ranks after every line that has). */
  weekCents: number | null;
  pinned: boolean;
  /** Carries costs (COST_CAPABILITY only). */
  cost: boolean;
}

/** At most this many lines on the card (costing spec D15). */
export const DO_THIS_CAP = 5;

/** Pinned lines take at most this many of those places. */
export const DO_THIS_MAX_PINNED = 2;

/** One kind of problem the list looks for. */
export interface DoThisSource<Ctx, T extends DoThisCandidate = DoThisCandidate> {
  kind: string;
  /** Its lines carry costs: it runs only for a login that may see costs. */
  cost: boolean;
  collect(ctx: Ctx): readonly T[];
}

export interface DoThisList<T> {
  items: T[];
  /** Lines left off below the cap. */
  more: number;
  /** Sources whose check threw (their kinds): the list is shown without them, and says so. */
  failed: string[];
}

/**
 * The list in order: pinned lines first, then the most rupees a week (a line
 * with no rupee figure after every line that has one), then by key so the
 * order never shuffles between two reads. Cost lines are dropped for a login
 * without costs, whatever their source said.
 */
export function rankDoThis<T extends DoThisCandidate>(
  items: readonly T[],
  opts: { canSeeCosts: boolean; cap?: number },
): { items: T[]; more: number } {
  const cap = Math.max(0, opts.cap ?? DO_THIS_CAP);
  const shown = items.filter((i) => opts.canSeeCosts || !i.cost);
  const byWeek = (a: T, b: T) =>
    (b.weekCents ?? -1) - (a.weekCents ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const pinned = shown.filter((i) => i.pinned).sort(byWeek);
  // Pins beyond the first few rank with everything else, so a till whose
  // stock was never counted (every key ingredient "out") still shows what
  // costs the shop money.
  const sorted = [
    ...pinned.slice(0, DO_THIS_MAX_PINNED),
    ...[...shown.filter((i) => !i.pinned), ...pinned.slice(DO_THIS_MAX_PINNED)].sort(byWeek),
  ];
  return { items: sorted.slice(0, cap), more: Math.max(0, sorted.length - cap) };
}

/**
 * Run every source this login may see, and rank what they found. A source
 * that throws is left out (named in `failed`) rather than costing the owner
 * the whole card.
 */
export function collectDoThis<Ctx, T extends DoThisCandidate>(
  sources: ReadonlyArray<DoThisSource<Ctx, T>>,
  ctx: Ctx,
  opts: { canSeeCosts: boolean; cap?: number },
): DoThisList<T> {
  const found: T[] = [];
  const failed: string[] = [];
  for (const source of sources) {
    if (source.cost && !opts.canSeeCosts) continue;
    try {
      found.push(...source.collect(ctx));
    } catch {
      failed.push(source.kind);
    }
  }
  return { ...rankDoThis(found, opts), failed };
}

/**
 * What a dish over its target costs per week (costing spec 4.17):
 * n̄_week × (TPC − T × TP), with n̄_week a quarter of the last 28 days'
 * units, TPC and TP the typical plate cost and price (millicents) and T the
 * category target (basis points). 0 when it did not sell or is not over.
 * Rounded once, to the paisa.
 */
export function redItemWeekCents(unitsLast28: number, typicalCostMc: number, typicalPriceMc: number, targetBps: number): number {
  if (!(unitsLast28 > 0)) return 0;
  // units × (TPC × 10,000 − T × TP) ÷ (4 weeks × 10,000 bps × 1,000 mc), in BigInt: no step through a float.
  const over = BigInt(typicalCostMc) * 10_000n - BigInt(targetBps) * BigInt(typicalPriceMc);
  if (over <= 0n) return 0;
  return halfUp(BigInt(unitsLast28) * over, 4n * 10_000n * 1000n);
}

/** round(num ÷ den) half up, for num ≥ 0 and den > 0. */
function halfUp(num: bigint, den: bigint): number {
  return Number((num * 2n + den) / (den * 2n));
}

/**
 * The proxy for missing costs (costing spec 4.17): the weekly sales of the
 * dishes a missing cost touches × each dish's category target — about what
 * those sales cost, which the till cannot see yet. Sales over the last 28
 * days, so a week is a quarter. Rounded once, to the paisa.
 */
export function missingCostsWeekCents(lines: ReadonlyArray<{ salesLast28Cents: number; targetBps: number }>): number {
  let num = 0n;
  for (const l of lines) {
    if (!(l.salesLast28Cents > 0) || !(l.targetBps > 0)) continue;
    num += BigInt(l.salesLast28Cents) * BigInt(l.targetBps);
  }
  // ÷ (4 weeks × 10,000 bps).
  return num === 0n ? 0 : halfUp(num, 40_000n);
}
