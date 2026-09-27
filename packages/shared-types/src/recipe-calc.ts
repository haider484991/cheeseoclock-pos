/**
 * The recipe calculator (owner, 2026-09-27: "make it more easy if a manager
 * wants to see how much ingredients a recipe needs for making anything like
 * pizzas, burgers, sauce, dips"): pick a dish, a deal, a dip or a batch,
 * say how many (or how much), and see the batches to make first, what comes
 * straight from stock and every ingredient from scratch — with what is in
 * stock on this till and what is short.
 *
 * QUANTITIES ONLY on the inventory: channels (menu.manage): whole base units
 * (g / ml / pcs), never a rupee — no *Cents or *Mc field anywhere below
 * except in RecipeCalcCosts, which only costing:recipeCalc (COST_CAPABILITY)
 * returns. So the calculator keeps working if costs are ever hidden from
 * managers.
 */

import type { ChoiceGroupKind } from './menu.js';

/** The most of one menu item worked out at once. */
export const RECIPE_CALC_MAX_COUNT = 10_000;
/** The most of one batch (in its base unit) worked out at once: 10,000 kg. */
export const RECIPE_CALC_MAX_AMOUNT = 10_000_000;
/** The most things worked out together. */
export const RECIPE_CALC_MAX_LINES = 30;

/** How many of one choice, out of the line's count ("7 of the 10 deals get a Large: Fajita"). */
export interface RecipeCalcPortion {
  modifierId: string;
  /** 0 … the line's count (a choice is picked at most once per unit). */
  count: number;
}

/** One thing being made. */
export type RecipeCalcLineRequest =
  | {
      kind: 'item';
      menuItemId: string;
      /** How many to make, 1 … 10,000. */
      count: number;
      /**
       * The choices, as explicit counts: the screen works "the usual picks"
       * out once and sends them, so the screen, the costs and the paper can
       * never disagree. Leave-outs are not accepted (they only use less).
       */
      portions: RecipeCalcPortion[];
    }
  | {
      kind: 'batch';
      ingredientId: string;
      /** In the batch item's base unit (g / ml / pcs), 1 … 10,000,000. */
      amount: number;
    };

export interface RecipeCalcRequest {
  /** 1 … 30 things at once; each batch is made once for all of them. */
  lines: RecipeCalcLineRequest[];
}

/** An ingredient's amount with this till's stock beside it. */
export interface RecipeCalcQtyRow {
  ingredientId: string;
  name: string;
  unit: string;
  /** Whole base units needed. */
  qty: number;
  /** This till's own count (current_qty): "in stock here". */
  inStock: number;
  /** What is missing: qty − max(0, inStock), never below 0. */
  shortBy: number;
  /**
   * A real pack to count or buy in (a counted pack of more than one, or a
   * weighed pack other than the 1,000 g / ml a per-kg price is kept as), else
   * null. A size, not a price.
   */
  packSize: number | null;
}

/** One input of a batch, scaled the way "Make" will take it. */
export interface RecipeCalcTreeLine extends RecipeCalcQtyRow {
  /** How much ONE batch uses. */
  perBatchQty: number;
  /** The exact scaled amount, hundredths of a base unit (1250 = 12.5 g). */
  exactHundredths: number;
  /** A batch itself: what this amount of it takes; null for a bought-in input (or past the depth shown). */
  madeOf: RecipeCalcTree | null;
  /** It leads back to a batch above it (a loop): taken from stock as it is, never made. */
  loop: boolean;
}

/** What an amount of a batch takes, every input in whole units ("Make" rounds the same way). */
export interface RecipeCalcTree {
  ingredientId: string;
  name: string;
  unit: string;
  amount: number;
  batchYield: number;
  /** "1.08 batches", "0.25 of a batch". */
  batchesText: string;
  lines: RecipeCalcTreeLine[];
}

/**
 * A batch in it, worked out once for everything asked. `qty` is everything
 * needs of it; what is already made on this till's shelf is used first, so
 * only `toMake` is made. `shortBy` is what the recipes need of it that the
 * shelf does not have (a batch asked for by name is made, never "short").
 * `packSize` is always null: it is made here, never bought in packs.
 */
export interface RecipeCalcBatchRow extends RecipeCalcQtyRow {
  batchYield: number;
  /** Of `qty`, what the recipes asked use of it themselves (the rest goes into other batches). */
  direct: number;
  /** Of `qty`, asked for by name ("2 kg Pizza Sauce"): made in full, whatever is on the shelf. */
  asked: number;
  /** Of `qty`, taken from what is already made on this till's shelf. */
  fromShelf: number;
  /** What to make: `asked` + `shortBy`. 0 = enough on the shelf, no need to make. */
  toMake: number;
  /** `toMake` as batches ("1.08 batches"); null when there is nothing to make. */
  batchesText: string | null;
  /** The most one "Make" takes (100 batches). */
  maxAmount: number;
  /** How many goes `toMake` takes at that limit (1 for most). */
  goes: number;
  /** What `toMake` takes, input by input; null when there is nothing to make. */
  tree: RecipeCalcTree | null;
}

/** A choice counted on a line, named. */
export interface RecipeCalcPick {
  modifierId: string;
  name: string;
  groupName: string;
  count: number;
}

/** One line asked, as understood. */
export interface RecipeCalcLineView {
  kind: 'item' | 'batch';
  /** The menu item or the batch ingredient. */
  id: string;
  name: string;
  /** Items: how many. Batches: the amount in `unit`. */
  count: number;
  /** Batches: the base unit; items: null. */
  unit: string | null;
  /** Batches: "2.5 batches"; items: null. */
  batchesText: string | null;
  picks: RecipeCalcPick[];
  /** Plain words: picks that do not cover the count, no recipe yet… */
  warnings: string[];
  hasRecipe: boolean;
  /** What goes into this line itself (first level: a batch here is not opened up). */
  uses: Array<{ ingredientId: string; name: string; unit: string; qty: number; madeInHouse: boolean }>;
}

/** The answer of inventory:recipeCalc: quantities only. */
export interface RecipeCalc {
  lines: RecipeCalcLineView[];
  /**
   * Batches in it, in the order to make them: a batch after the batches it
   * is made from. One with enough on the shelf is listed with toMake 0.
   */
  batches: RecipeCalcBatchRow[];
  /** Bought-in ingredients the recipes use as they are (all lines together). */
  fromStock: RecipeCalcQtyRow[];
  /**
   * Every bought-in ingredient, through every batch still to make (each made
   * once; what is already made on the shelf is used first).
   */
  fromScratch: RecipeCalcQtyRow[];
  /** Plain words about the whole answer (a batch that uses itself…). */
  warnings: string[];
}

/** What it costs (costing:recipeCalc only, COST_CAPABILITY). Paisa. */
export interface RecipeCalcCosts {
  /** Every line together: each first-level line at today's price (a batch at its rolled-up price). */
  totalCostCents: number;
  complete: boolean;
  /** Ingredients with no price (they count as Rs 0), each once. */
  unpriced: string[];
  /** Ingredients priced with a guess. */
  estimates: string[];
  /** Per line asked, in order. */
  perLine: Array<{
    costCents: number;
    /** Items: the cost of one; batches: the cost of 1 kg / litre (or 1 unit). */
    eachCents: number | null;
    complete: boolean;
    unpriced: string[];
  }>;
  /**
   * Per ingredient id, for the batch and straight-from-stock rows: what the
   * recipes' own use of it costs — a batch at `direct` (what goes into other
   * batches is already in their price), a straight-from-stock row at `qty` —
   * so the column adds up to `totalCostCents` (to the paisa's rounding).
   * A batch that only goes into other batches has no entry.
   */
  perRow: Record<string, { costCents: number; complete: boolean }>;
}

export type CostedRecipeCalc = RecipeCalc & { costs: RecipeCalcCosts };

/** A menu item's choices and the customers' picks, for "the usual picks" (sale counts only). */
export interface TypicalPicksView {
  menuItemId: string;
  name: string;
  /** In the order the till asks them (orderChoiceGroups). */
  groups: Array<{
    groupId: string;
    /** As customers see it ("Choose up to 5 veggies"). */
    name: string;
    kind: ChoiceGroupKind;
    selectionType: 'single' | 'multi';
    minSelect: number;
    maxSelect: number;
    isRequired: boolean;
    options: Array<{
      modifierId: string;
      name: string;
      /** "No onion": takes an ingredient off. Not counted by the calculator. */
      leaveOut: boolean;
      /** It brings recipe lines of its own. */
      hasLines: boolean;
    }>;
  }>;
  /** The last 28 days on this till: units sold, per choice the units that had it, per group the units that picked in it. */
  mix: {
    units: number;
    picks: Record<string, number>;
    groupUnits: Record<string, number>;
  };
}
