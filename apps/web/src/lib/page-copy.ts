import { ALL_COMPILED_ZONE_IDS, type Copy } from './delivery-facts';

/**
 * Page sentences that name a delivery fee, kept here (a page file may only
 * export what Next allows) so site-copy.test.ts can check them: fee tokens,
 * filled from the owner's settings by delivery-facts renderCopy / fillFees.
 * With no settings stored each reads exactly as before.
 */

/** Home page FAQ, "Which areas do you deliver to?". */
export const HOME_FAQ_AREAS: Copy = {
  text: "DHA Phases 1–8 and Clifton Blocks 1–9, including Emaar Crescent Bay and Creek Vista. Delivery is {fee:dha-1..7,dha-2-ext,dha-7-ext,clifton-3..9} for DHA Phases 1–7 and Clifton Blocks 3–9, and {fee:dha-8,emaar,creek-vista,clifton-1,clifton-2} for DHA Phase 8, Emaar, Creek Vista and Clifton Blocks 1 & 2. We don't deliver outside DHA and Clifton.",
  // The two tiers as the rider service's card has them; once the owner's fees differ, the tiers are written from the areas.
  when: { rateCard: ALL_COMPILED_ZONE_IDS },
  otherwise:
    "DHA Phases 1–8 and Clifton Blocks 1–9, including Emaar Crescent Bay and Creek Vista. Delivery is {summary}. We don't deliver outside DHA and Clifton.",
};

/** Home hero chip. */
export const HOME_HERO_FEE: Copy = 'Delivery from {minFee}';

/** Home "how it works" stat. */
export const HOME_STAT_FEE: Copy = 'From {minFee}';

/** /delivery meta description. */
export const DELIVERY_HUB_DESCRIPTION: Copy =
  "Cheese O'Clock delivers pizza & burgers across DHA Phases 1–8 and Clifton from our Phase 6 kitchen. {fees} delivery, cash on delivery, open daily till 1 am.";

/** Late-night page FAQ, "Which areas do you cover after midnight?". */
export const LATE_NIGHT_FAQ_AREAS: Copy =
  'The same map as daytime: DHA Phases 1–8 and Clifton, at the same {fees} delivery fees. We do not deliver outside DHA and Clifton at any hour.';

/** Pizza landing page FAQ answer on fees. */
export const PIZZA_FAQ_AREAS: Copy =
  '{summary}. We deliver in DHA and Clifton only. You can follow your order’s status after checkout.';

/** Burger landing page FAQ answer on fees. */
export const BURGER_FAQ_AREAS: Copy =
  'DHA and Clifton only, from our kitchen in Rahat Commercial, Phase 6. Delivery is {summary}. You can follow your order’s status after checkout.';
