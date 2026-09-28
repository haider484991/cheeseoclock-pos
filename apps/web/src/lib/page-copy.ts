import { ALL_COMPILED_ZONE_IDS, type Copy } from './delivery-facts';

/**
 * Page sentences that name a delivery fee or where the shop delivers, kept
 * here (a page file may only export what Next allows) so site-copy.test.ts
 * can check them: fee tokens, filled from the owner's settings by
 * delivery-facts renderCopy / fillFees. With no settings stored each reads
 * exactly as before. A sentence that names the areas by hand ("DHA and
 * Clifton") holds only while the areas delivered to are today's 21
 * (areasAsBuilt); once the owner adds or pauses one, the {where} / {places}
 * wording takes over, so the site never says "we don't deliver outside DHA
 * and Clifton" while it takes orders for PECHS.
 */

/** The line that takes a fee sentence's place while every area is switched off (no fee is named for one). */
const PAUSED_LINE = 'Delivery is paused right now — message us on WhatsApp and we’ll tell you when it’s back.';

/** Home page FAQ, "Which areas do you deliver to?". */
export const HOME_FAQ_AREAS: Copy = {
  text: "DHA Phases 1–8 and Clifton Blocks 1–9, including Emaar Crescent Bay and Creek Vista. Delivery is {fee:dha-1..7,dha-2-ext,dha-7-ext,clifton-3..9} for DHA Phases 1–7 and Clifton Blocks 3–9, and {fee:dha-8,emaar,creek-vista,clifton-1,clifton-2} for DHA Phase 8, Emaar, Creek Vista and Clifton Blocks 1 & 2. We don't deliver outside DHA and Clifton.",
  // The two tiers as the rider service's card has them; once the owner's fees differ, the tiers are written from the areas.
  when: [{ rateCard: ALL_COMPILED_ZONE_IDS }, { areasAsBuilt: true }],
  otherwise: {
    text: "DHA Phases 1–8 and Clifton Blocks 1–9, including Emaar Crescent Bay and Creek Vista. Delivery is {summary}. We don't deliver outside DHA and Clifton.",
    when: { areasAsBuilt: true },
    otherwise: {
      text: "We deliver to {places}. Delivery is {summary}. We don't deliver outside {where}.",
      when: { delivering: true },
      // Every area switched off: no fee is named for one.
      otherwise: PAUSED_LINE,
    },
  },
};

/** Home page, the delivery section's line under "All over DHA & Clifton". */
export const HOME_DELIVERY_NOTE: Copy = {
  text: 'Our kitchen is in Rahat Commercial Area, DHA Phase 6. Pick your area at checkout and the delivery charge is added for you — we don’t take online orders outside DHA and Clifton.',
  when: { areasAsBuilt: true },
  otherwise:
    'Our kitchen is in Rahat Commercial Area, DHA Phase 6. Pick your area at checkout and the delivery charge is added for you — we don’t take online orders outside {where}.',
};

/** Home hero chip. */
export const HOME_HERO_FEE: Copy = { text: 'Delivery from {minFee}', when: { delivering: true }, otherwise: 'Delivery paused right now' };

/** Home "how it works" stat. */
export const HOME_STAT_FEE: Copy = { text: 'From {minFee}', when: { delivering: true }, otherwise: 'Paused right now' };

/** /delivery meta description. */
export const DELIVERY_HUB_DESCRIPTION: Copy = {
  text: "Cheese O'Clock delivers pizza & burgers across DHA Phases 1–8 and Clifton from our Phase 6 kitchen. {fees} delivery, cash on delivery, open daily till 1 am.",
  when: { areasAsBuilt: true },
  otherwise: {
    text: "Cheese O'Clock delivers pizza & burgers across {where} from our Phase 6 kitchen. {fees} delivery, cash on delivery, open daily till 1 am.",
    when: { delivering: true },
    otherwise: "Cheese O'Clock delivers pizza & burgers from our Phase 6 kitchen. " + PAUSED_LINE,
  },
};

/** /delivery, the paragraph under the heading. */
export const DELIVERY_HUB_INTRO: Copy = {
  text: 'Every order fires from our kitchen in DHA Phase 6 — daily from 12 noon to 1 am, always cash on delivery. We deliver in DHA and Clifton only: {summary}. Pick your area below for the streets we cover and answers to the questions your area actually asks.',
  when: { areasAsBuilt: true },
  otherwise: {
    text: 'Every order fires from our kitchen in DHA Phase 6 — daily from 12 noon to 1 am, always cash on delivery. We deliver in {where} only: {summary}. Pick your area below for the streets we cover and answers to the questions your area actually asks.',
    when: { delivering: true },
    otherwise: 'Every order fires from our kitchen in DHA Phase 6 — daily from 12 noon to 1 am, always cash on delivery. ' + PAUSED_LINE,
  },
};

/** Late-night page FAQ, "Which areas do you cover after midnight?". */
export const LATE_NIGHT_FAQ_AREAS: Copy = {
  text: 'The same map as daytime: DHA Phases 1–8 and Clifton, at the same {fees} delivery fees. We do not deliver outside DHA and Clifton at any hour.',
  when: { areasAsBuilt: true },
  otherwise: {
    text: 'The same map as daytime — {places} — at the same {fees} delivery fees. We do not deliver outside {where} at any hour.',
    when: { delivering: true },
    otherwise: PAUSED_LINE,
  },
};

/** Pizza landing page FAQ answer on fees. */
export const PIZZA_FAQ_AREAS: Copy = {
  text: '{summary}. We deliver in DHA and Clifton only. You can follow your order’s status after checkout.',
  when: { areasAsBuilt: true },
  otherwise: {
    text: '{summary}. We deliver in {where} only. You can follow your order’s status after checkout.',
    when: { delivering: true },
    otherwise: PAUSED_LINE,
  },
};

/** Burger landing page FAQ answer on fees. */
export const BURGER_FAQ_AREAS: Copy = {
  text: 'DHA and Clifton only, from our kitchen in Rahat Commercial, Phase 6. Delivery is {summary}. You can follow your order’s status after checkout.',
  when: { areasAsBuilt: true },
  otherwise: {
    text: '{where} only, from our kitchen in Rahat Commercial, Phase 6. Delivery is {summary}. You can follow your order’s status after checkout.',
    when: { delivering: true },
    otherwise: PAUSED_LINE,
  },
};
