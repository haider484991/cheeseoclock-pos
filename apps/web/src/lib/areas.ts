import {
  claimHolds,
  findFactZone,
  listWords,
  pausedZones,
  placesWords,
  renderCopy,
  shopOf,
  taxed,
  zonesFeeChip,
  type Copy,
  type CopyFacts,
  type FactZone,
  type FeeClaim,
  type SiteFacts,
} from './delivery-facts';
import { shopNameProse } from './shop-facts';

/**
 * Delivery-area data driving the programmatic local-SEO pages at
 * /delivery/[slug]. Every field that renders as page copy is hand-written and
 * genuinely different per area — Google's doorway/scaled-content policies
 * punish synonym-swapped templates, so when adding an area, write real local
 * detail (landmarks, coverage edges, real menu items) or merge it into a
 * neighbouring page instead.
 *
 * Facts only: the shop delivers in DHA and Clifton ONLY (see
 * delivery-zones.ts), opens in the hours the owner sets (Settings — the
 * {hours} / {opens} / {closes} tokens, never typed here), and takes cash on
 * delivery. Delivery times are NOT confirmed — never write a minute count
 * into this copy. Menu items named here must exist on the printed menu.
 *
 * Fees are never typed into this file: each area lists the checkout zone
 * ids it covers (`zoneIds`), `feeText` reads the chip from the delivery
 * facts, and prose names a fee with a token — {fee:dha-6}, {fee:clifton-3..9}
 * — filled from the owner's settings (lib/delivery-facts.ts fillFees). A
 * sentence that is only true while fees keep a shape ("the same fee as
 * Phase 7") says so with a claim (`when`) and steps aside, or reads its
 * `otherwise`, when the owner's fees break it. With no settings stored the
 * pages read exactly as before (site-copy.test.ts). Slugs, names, titles and
 * H1s never come from the settings: an area the owner switches off keeps its
 * page and says delivery there is paused.
 *
 * The shop's details work the same way (sweep B2 + B4, lib/delivery-facts
 * fillFees): {closes}, {waNumbers}, {street}, {nameProse}, {tax} (in taxed(),
 * with its words for food taxed at 0%),
 * {doorPayments} …, and a sentence true only for today's hours or cash only
 * carries { everyDay }, { closesAfterMidnight } or { cashOnly }.
 */

export interface DeliveryArea {
  slug: string;
  /** Short human name, e.g. "DHA Phase 6". */
  name: string;
  /** H1 on the area page. */
  h1: string;
  /** <title> (the site's title template appends the shop's name). */
  title: string;
  /** Meta description, ≤160 chars (fee tokens allowed). */
  description: Copy;
  /** Delivery area ids this page covers — drives feeText and the paused note. */
  zoneIds: string[];
  /** Hand-written intro paragraphs — the unique meat of the page (fee tokens allowed). */
  intro: Copy[];
  /**
   * Streets / commercial areas / landmarks we actually cover, in page order.
   * A plain name lies in all of the page's areas; `in` names the ones it lies
   * in. It is listed while one of them is on (`every`: only while all are),
   * so a place the owner switches off is never listed (coveredLandmarks).
   */
  landmarks: Landmark[];
  /** Real menu items to feature on this page (brand copy, links to /menu). */
  popular: Array<{ name: string; blurb: string }>;
  /** Area-specific visible FAQ (fee tokens allowed; `when`: shown only while that holds). */
  faqs: Array<{ q: Copy; a: Copy; when?: FeeClaim | readonly FeeClaim[] }>;
  /** Slugs of bordering areas for internal linking. */
  adjacent: string[];
}

/** A street or spot on an area page (DeliveryArea.landmarks). */
export type Landmark = string | { name: string; in: readonly string[]; every?: true };

/** The end of a sentence that says delivery is paused. */
const PAUSED_WA = 'message us on WhatsApp and we’ll tell you when it’s back.';

export const DELIVERY_AREAS: DeliveryArea[] = [
  {
    slug: 'dha-phase-6',
    name: 'DHA Phase 6',
    h1: 'Pizza & Burger Delivery in DHA Phase 6 — From Our Kitchen Next Door',
    title: 'Pizza & Burger Delivery in DHA Phase 6, Karachi',
    description:
      '{nameProse}’s kitchen is in Rahat Commercial, Phase 6 — our shortest ride. Pizza & burgers, {fee:dha-6} delivery, cash on delivery. Open {days} till {closes}.',
    zoneIds: ['dha-6'],
    intro: [
      'Phase 6 is home turf. Our kitchen is at {street}, so Phase 6 is the shortest ride we make. Every order is fired when it comes in, boxed straight from the oven and sent out hot.',
      {
        text: 'From the Bukhari Commercial lanes to the houses off Khayaban-e-Shahbaz, delivery anywhere in Phase 6 is {fee:dha-6}. Late study session, family dinner or a midnight craving — we are open every day from {opens} until {closes}.',
        when: [{ everyDay: true }, { closesAfterMidnight: true }],
        otherwise:
          'From the Bukhari Commercial lanes to the houses off Khayaban-e-Shahbaz, delivery anywhere in Phase 6 is {fee:dha-6}. Late study session or family dinner — we are open {days}, from {opens} until {closes}.',
      },
    ],
    landmarks: [
      'Rahat Commercial',
      'Bukhari Commercial',
      'Nishat Commercial',
      'Muslim Commercial',
      'Khayaban-e-Shahbaz',
      'Khayaban-e-Ittehad',
      'Khayaban-e-Bukhari',
    ],
    popular: [
      {
        name: 'Cheesy Star',
        blurb: 'Cut like a star, built for sharing, with a Sriracha mayo dip. One of our five Signature pizzas, Large 12".',
      },
      {
        name: 'Crown Crust',
        blurb: 'Another Signature Large 12" — pair it with a Cheesy Star when there are more than two of you.',
      },
      {
        name: 'Signature Loaded Fries',
        blurb: 'Pick-up only — we do not deliver these. Living in Phase 6, you are close enough to collect them from the shop in Rahat Commercial.',
      },
    ],
    faqs: [
      {
        q: 'Is Phase 6 your quickest delivery area?',
        a: 'Yes — the kitchen is in Rahat Commercial, Phase 6, so it is the shortest ride we make. Orders are fired when they arrive and sent out hot. Delivery inside Phase 6 is {fee:dha-6}.',
      },
      {
        q: 'Do you deliver to Bukhari and Nishat Commercial offices?',
        a: 'Yes — offices, shops and apartments across all Phase 6 commercial lanes. Add your building name and floor in the order notes and keep your phone on for the rider.',
      },
      {
        q: 'How late can I order in Phase 6?',
        a: {
          text: 'We take orders every day from {opens} until {closes} — on the website, or on WhatsApp at {waNumbers}.',
          when: { everyDay: true },
          otherwise: 'We take orders {days}, from {opens} until {closes} — on the website, or on WhatsApp at {waNumbers}.',
        },
      },
      {
        q: 'How do I pay?',
        a: taxed(
          {
            text: 'Cash on delivery — pay the rider when your food arrives. Your bill is the menu total plus {tax} and the {fee:dha-6} delivery fee. No card or app required.',
            when: { cashOnly: true },
            otherwise:
              '{DoorPayments} on delivery — pay the rider when your food arrives. Your bill is the menu total plus {tax} and the {fee:dha-6} delivery fee.',
          },
          {
            text: 'Cash on delivery — pay the rider when your food arrives. Your bill is the menu total plus the {fee:dha-6} delivery fee. No card or app required.',
            when: { cashOnly: true },
            otherwise: '{DoorPayments} on delivery — pay the rider when your food arrives. Your bill is the menu total plus the {fee:dha-6} delivery fee.',
          },
        ),
      },
    ],
    adjacent: ['dha-phase-7', 'dha-phase-5', 'dha-phase-8'],
  },
  {
    slug: 'dha-phase-7',
    name: 'DHA Phase 7',
    h1: 'Pizza & Burger Delivery in DHA Phase 7, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 7, Karachi',
    description: {
      text: 'Pizza & crispy chicken burger delivery to DHA Phase 7 and Phase 7 Ext from our Phase 6 kitchen next door. {fee:dha-7,dha-7-ext} delivery, cash on delivery.',
      // Names both as delivered to: only while both are (else renderArea's description of what is on and paused).
      when: { on: ['dha-7', 'dha-7-ext'] },
    },
    zoneIds: ['dha-7', 'dha-7-ext'],
    intro: [
      'Phase 7 sits right next to our Phase 6 kitchen, so your order is on its way while the cheese is still moving. Every pizza and burger is fired when the ticket comes in.',
      'We cover the whole phase — the residential streets off Khayaban-e-Sehar, Sehar and Jami Commercial, and Phase 7 Extension — for {fee:dha-7,dha-7-ext}. If you are unsure about your street, send us a WhatsApp before you order.',
    ],
    landmarks: [
      { name: 'Khayaban-e-Sehar', in: ['dha-7'] },
      { name: 'Sehar Commercial', in: ['dha-7'] },
      { name: 'Jami Commercial', in: ['dha-7'] },
      { name: 'Phase 7 Extension', in: ['dha-7-ext'] },
    ],
    popular: [
      {
        name: 'Shawarma Pizza',
        blurb: 'A Signature Large 12" — shawarma night and pizza night, settled in one box.',
      },
      {
        name: 'Nashville Authentic (Hot)',
        blurb: 'A thigh-marinated crispy chicken fillet in a brioche bun, Nashville-style and properly hot. Add cheese to any burger.',
      },
      {
        name: 'Baked Wings',
        blurb: 'Six oven-baked wings with a dip — baked, not fried.',
      },
    ],
    faqs: [
      {
        q: 'Do you deliver to Phase 7 Extension?',
        a: {
          text: 'Yes — Phase 7 Extension has its own option at checkout, at the same {fee:dha-7-ext} fee as Phase 7.',
          // Phase 7's fee is named too: only while Phase 7 is delivered to.
          when: [{ sameFee: ['dha-7', 'dha-7-ext'] }, { on: ['dha-7'] }],
          otherwise: 'Yes — Phase 7 Extension has its own option at checkout, with its own {fee:dha-7-ext} fee.',
        },
      },
      {
        q: 'Which area do I pick at checkout?',
        a: {
          text: 'DHA Phase 7, or DHA Phase 7 Extension if you are in Ext. If your street sits on the Phase 6 border, either is fine — the fee is {fee:dha-6,dha-7} both ways.',
          when: [{ sameFee: ['dha-6', 'dha-7'] }, { on: ['dha-6', 'dha-7'] }],
          otherwise: {
            text: 'DHA Phase 7, or DHA Phase 7 Extension if you are in Ext. If your street sits on the Phase 6 border, pick the phase your address is in — Phase 6 is {fee:dha-6}, Phase 7 is {fee:dha-7}.',
            when: { delivering: true },
            // A phase switched off: its fee is not named.
            otherwise:
              'DHA Phase 7, or DHA Phase 7 Extension if you are in Ext. If your street sits on the Phase 6 border, pick the phase your address is in.',
          },
        },
      },
      {
        q: 'Is there a minimum order for Phase 7?',
        a: taxed(
          {
            text: 'No minimum on the website. You pay {doorPayments} on delivery: the menu total plus {tax} and the {fee:dha-7,dha-7-ext} delivery fee.',
            // The owner's smallest website delivery order (Settings → Online orders on the till).
            when: { noMinimum: true },
            otherwise:
              'For delivery, yes: {minOrder} of food, before tax and the delivery fee — pick-up has no minimum. You pay {doorPayments} on delivery: the menu total plus {tax} and the {fee:dha-7,dha-7-ext} delivery fee.',
          },
          {
            text: 'No minimum on the website. You pay {doorPayments} on delivery: the menu total plus the {fee:dha-7,dha-7-ext} delivery fee.',
            when: { noMinimum: true },
            otherwise:
              'For delivery, yes: {minOrder} of food, before the delivery fee — pick-up has no minimum. You pay {doorPayments} on delivery: the menu total plus the {fee:dha-7,dha-7-ext} delivery fee.',
          },
        ),
      },
    ],
    adjacent: ['dha-phase-6', 'dha-phase-8'],
  },
  {
    slug: 'dha-phase-8',
    name: 'DHA Phase 8',
    h1: 'Pizza & Burger Delivery in DHA Phase 8, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 8, Karachi',
    description: {
      text: 'Pizza & burgers delivered across DHA Phase 8 — Do Darya side, Emaar Crescent Bay & Creek Vista included. {fee:dha-8,emaar,creek-vista} delivery, cash on delivery, till {closes}.',
      // "… included": only for the areas delivered to now (Phase 8 itself paused: renderArea's description).
      when: { on: ['dha-8', 'emaar', 'creek-vista'] },
      otherwise: {
        text: 'Pizza & burgers delivered across DHA Phase 8 — Do Darya side & Creek Vista included. {fee:dha-8,creek-vista} delivery, cash on delivery, till {closes}.',
        when: { on: ['dha-8', 'creek-vista'] },
        otherwise: {
          text: 'Pizza & burgers delivered across DHA Phase 8 — Do Darya side & Emaar Crescent Bay included. {fee:dha-8,emaar} delivery, cash on delivery, till {closes}.',
          when: { on: ['dha-8', 'emaar'] },
          otherwise: {
            text: 'Pizza & burgers delivered across DHA Phase 8 — Do Darya side included. {fee:dha-8} delivery, cash on delivery, till {closes}.',
            when: { on: ['dha-8'] },
          },
        },
      },
    },
    zoneIds: ['dha-8', 'emaar', 'creek-vista'],
    intro: [
      'Phase 8 runs wide — from the Zulfiqar and Al-Murtaza commercial strips out to the sea at Do Darya — and we deliver across all of it. Orders leave our Phase 6 kitchen boxed straight from the oven.',
      {
        text: 'Delivery is {fee:dha-8} across Phase 8, the same for Emaar Crescent Bay and Creek Vista, which are their own zones at checkout. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider {doorPayments}.',
        // It names Emaar's and Creek Vista's fee as Phase 8's: only while both are delivered to.
        when: [{ sameFee: ['dha-8', 'emaar', 'creek-vista'] }, { on: ['emaar', 'creek-vista'] }],
        // Each fee named only for an area that is on (a {fee:…} of a switched-off area can't print).
        otherwise: {
          text: 'Delivery is {fee:dha-8} across Phase 8; Emaar Crescent Bay ({fee:emaar}) and Creek Vista ({fee:creek-vista}) are their own zones at checkout. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider {doorPayments}.',
          when: { delivering: true },
          otherwise: {
            text: 'Delivery is {fee:dha-8} across Phase 8; Creek Vista ({fee:creek-vista}) is its own zone at checkout. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider {doorPayments}.',
            when: { delivering: true },
            otherwise: {
              text: 'Delivery is {fee:dha-8} across Phase 8; Emaar Crescent Bay ({fee:emaar}) is its own zone at checkout. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider {doorPayments}.',
              when: { delivering: true },
              otherwise:
                'Delivery is {fee:dha-8} across Phase 8. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider {doorPayments}.',
            },
          },
        },
      },
    ],
    landmarks: [
      { name: 'Zulfiqar Commercial', in: ['dha-8'] },
      { name: 'Al-Murtaza Commercial', in: ['dha-8'] },
      { name: 'Do Darya side', in: ['dha-8'] },
      { name: 'Emaar Crescent Bay', in: ['emaar'] },
      { name: 'Creek Vista', in: ['creek-vista'] },
      { name: 'Khayaban-e-Shaheen', in: ['dha-8'] },
    ],
    popular: [
      {
        name: 'Big Two value deal',
        blurb: 'Two Large 12" regular-menu pizzas and a 1 litre soft drink — the value deal for a full house.',
      },
      {
        name: 'Meat Lovers',
        blurb: 'A Signature Large 12" for the meat-first crowd.',
      },
      {
        name: 'Nuggets',
        blurb: 'Five nuggets with fries and a dip — a side that is nearly a meal.',
      },
    ],
    faqs: [
      {
        q: 'Do you deliver near Do Darya?',
        a: 'Yes — the Do Darya side is covered at the Phase 8 fee of {fee:dha-8}.',
      },
      {
        q: 'Why is delivery to Phase 8 {fee:dha-8}?',
        a: 'Phase 8 — with Emaar Crescent Bay and Creek Vista — is {fee:dha-8,emaar,creek-vista} on our rider service’s rate card, instead of the {fee:dha-1..7,dha-2-ext,dha-7-ext} for Phases 1–7. Pick your area at checkout and the right fee is added for you.',
        // It explains the fee by the rider service's card: only while the fees are the card's, and
        // it names Emaar's and Creek Vista's with Phase 8's: only while all three are delivered to.
        when: [{ rateCard: ['dha-1..8', 'dha-2-ext', 'dha-7-ext', 'emaar', 'creek-vista'] }, { on: ['dha-8', 'emaar', 'creek-vista'] }],
      },
      {
        q: 'Will the food still be hot in Phase 8?',
        a: 'Orders are boxed straight from the oven and sent out as soon as they are ready. If anything is not right when it arrives, message us on WhatsApp.',
      },
      {
        q: 'Can I order late at night in Phase 8?',
        a: {
          text: 'Yes — we take Phase 8 orders every day until {closes}.',
          when: { everyDay: true },
          otherwise: 'Yes — we take Phase 8 orders {days} until {closes}.',
        },
      },
    ],
    adjacent: ['dha-phase-6', 'dha-phase-7'],
  },
  {
    slug: 'dha-phase-5',
    name: 'DHA Phase 5',
    h1: 'Pizza & Burger Delivery in DHA Phase 5, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 5, Karachi',
    description:
      'Pizza & crispy chicken burgers delivered across DHA Phase 5 — Khadda Market, 26th Street, Badar Commercial. {fee:dha-5} delivery, cash on delivery.',
    zoneIds: ['dha-5'],
    intro: [
      'Phase 5 neighbours our Phase 6 kitchen, so the ride from oven to gate is a short one — from the Khadda Market lanes to the quieter streets off Khayaban-e-Tanzeem. Delivery anywhere in Phase 5 is {fee:dha-5}.',
      {
        text: 'Phase 5 has plenty of food, but most of it means going out. We bring it home instead: crispy chicken burgers in brioche buns, Medium or Large pizzas with a proper cheese pull, and masala fries — all paid in cash at your door.',
        when: { cashOnly: true },
        otherwise:
          'Phase 5 has plenty of food, but most of it means going out. We bring it home instead: crispy chicken burgers in brioche buns, Medium or Large pizzas with a proper cheese pull, and masala fries — all paid at your door.',
      },
    ],
    landmarks: [
      'Khadda Market',
      '26th Street',
      'Tauheed Commercial',
      'Badar Commercial',
      'Khayaban-e-Tanzeem',
      'Khayaban-e-Bahria',
    ],
    popular: [
      {
        name: 'Classic Crispy Chicken',
        blurb: 'A thigh-marinated crispy chicken fillet in a brioche bun — the straightforward one. Add cheese if you like.',
      },
      {
        name: 'Chicken Tikka Pizza',
        blurb: 'From the regular menu, in Medium 9" or Large 12".',
      },
      {
        name: 'Signature Masala Fries',
        blurb: 'A Large portion of fries in our masala — the side that goes with everything.',
      },
    ],
    faqs: [
      {
        q: 'Do you deliver around Khadda Market?',
        a: 'Yes — Khadda Market and the lanes around it are covered at the standard Phase 5 fee of {fee:dha-5}.',
      },
      {
        q: 'Do you cover all of 26th Street?',
        a: 'Yes, the full stretch. For apartment buildings, add the building name in your order notes and keep your phone on for the rider.',
      },
      {
        q: 'Can I pay by card?',
        a: taxed(
          {
            text: 'Not at the moment — every order is cash on delivery. The bill is the menu total plus {tax} and the {fee:dha-5} delivery fee.',
            when: { cashOnly: true },
            otherwise: 'The rider takes {doorPayments}. The bill is the menu total plus {tax} and the {fee:dha-5} delivery fee.',
          },
          {
            text: 'Not at the moment — every order is cash on delivery. The bill is the menu total plus the {fee:dha-5} delivery fee.',
            when: { cashOnly: true },
            otherwise: 'The rider takes {doorPayments}. The bill is the menu total plus the {fee:dha-5} delivery fee.',
          },
        ),
      },
    ],
    adjacent: ['dha-phase-6', 'dha-phase-4', 'clifton'],
  },
  {
    slug: 'dha-phase-4',
    name: 'DHA Phase 4',
    h1: 'Pizza & Burger Delivery in DHA Phase 4, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 4, Karachi',
    description: {
      text: 'Pizza & crispy chicken burgers delivered to DHA Phase 4 and Phase 3 — 9th Commercial, Sunset side and the residential lanes. {fee:dha-4,dha-3}, cash on delivery.',
      // Names both as delivered to: only while both are (else renderArea's description of what is on and paused).
      when: { on: ['dha-4', 'dha-3'] },
    },
    zoneIds: ['dha-4', 'dha-3'],
    intro: [
      'Phase 4 sits between our kitchen and the older phases, and we deliver across all of it — the Sunset Boulevard side, the 9th Commercial strip and the residential lanes in between. Phase 3 next door is covered too. Delivery to either is {fee:dha-4,dha-3}.',
      'Order on the website in under a minute, or WhatsApp your order and street to {waNumbers} — both land in the same kitchen, and both are cash on delivery.',
    ],
    landmarks: [
      { name: '9th Commercial Street', in: ['dha-4'] },
      { name: 'Sunset Boulevard side', in: ['dha-4'] },
      { name: 'Phase 4 residential lanes', in: ['dha-4'] },
      { name: 'DHA Phase 3', in: ['dha-3'] },
    ],
    popular: [
      {
        name: 'Classic Pepperoni',
        blurb: 'Pepperoni on rich tomato sauce, from the regular menu in Medium 9" or Large 12".',
      },
      {
        name: 'Crispy Signature',
        blurb: 'A thigh-marinated crispy chicken fillet in a brioche bun — one step up from the Classic.',
      },
      {
        name: 'Veggie Lovers',
        blurb: 'Choose any five veggies — for the one person in the group who is not feeling meat.',
      },
    ],
    faqs: [
      {
        q: 'Do you deliver to DHA Phase 3?',
        a: {
          text: 'Yes — pick DHA Phase 3 at checkout. It is {fee:dha-3}, the same as Phase 4.',
          when: [{ sameFee: ['dha-3', 'dha-4'] }, { on: ['dha-4'] }],
          otherwise: {
            text: 'Yes — pick DHA Phase 3 at checkout. It is {fee:dha-3}; Phase 4 is {fee:dha-4}.',
            when: { delivering: true },
            otherwise: 'Yes — pick DHA Phase 3 at checkout. It is {fee:dha-3}.',
          },
        },
      },
      {
        q: 'Do you deliver to offices in 9th Commercial?',
        a: {
          text: 'Yes — lunch and dinner, from {opens}. Put the office name and floor in the order notes, and keep your phone close for the rider’s call.',
          when: { opensBy: '13:00' },
          otherwise: 'Yes — from {opens}. Put the office name and floor in the order notes, and keep your phone close for the rider’s call.',
        },
      },
      {
        q: 'Is WhatsApp ordering available for Phase 4?',
        a: 'Yes. Message your order and address to {waNumbers} and we will confirm the total right away.',
      },
    ],
    adjacent: ['dha-phase-5', 'dha-phase-1-2'],
  },
  {
    slug: 'dha-phase-1-2',
    name: 'DHA Phase 1 & 2',
    h1: 'Pizza & Burger Delivery in DHA Phase 1 & 2, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 1 & 2, Karachi',
    description: {
      text: 'Pizza & burger delivery to DHA Phase 1, Phase 2 and Phase 2 Ext from our Phase 6 kitchen. {fee:dha-1,dha-2,dha-2-ext} delivery, cash on delivery — order online or WhatsApp.',
      // Names all three as delivered to: only while they are (else renderArea's description of what is on and paused).
      when: { on: ['dha-1', 'dha-2', 'dha-2-ext'] },
    },
    zoneIds: ['dha-1', 'dha-2', 'dha-2-ext'],
    intro: [
      {
        text: 'Phase 1 and Phase 2 are the longest ride from our Phase 6 kitchen, and we will not pretend otherwise. What does not change is how the food leaves: fired to order, boxed straight from the oven and sent out hot — for the same {fee:dha-1,dha-2,dha-2-ext} as Phases 3 to 7.',
        when: [{ sameFee: ['dha-1..7', 'dha-2-ext', 'dha-7-ext'] }, { on: ['dha-1..7', 'dha-2-ext', 'dha-7-ext'] }],
        otherwise:
          'Phase 1 and Phase 2 are the longest ride from our Phase 6 kitchen, and we will not pretend otherwise. What does not change is how the food leaves: fired to order, boxed straight from the oven and sent out hot. Delivery here is {fee:dha-1,dha-2,dha-2-ext}.',
      },
      'We cover Phase 1, Phase 2 and Phase 2 Extension: the Korangi Road side, Defence Mor and the Phase 2 Ext lanes. If your street sits right on the boundary, send a WhatsApp and we will confirm before you order.',
    ],
    landmarks: [
      'Korangi Road stretch',
      { name: 'Defence Mor', in: ['dha-1', 'dha-2'] },
      { name: 'Phase 2 commercial lanes', in: ['dha-2'] },
      { name: 'Phase 2 Extension', in: ['dha-2-ext'] },
    ],
    popular: [
      {
        name: 'Family Feast value deal',
        blurb: 'One Medium and one Large regular-menu pizza with a 1 litre soft drink — makes the longer ride worth it.',
      },
      {
        name: 'Signature Cheese Dipped',
        blurb: 'A thigh-marinated crispy chicken fillet, dipped in cheese, in a brioche bun.',
      },
      {
        name: 'Fajita Pizza',
        blurb: 'A regular-menu pizza in Medium 9" or Large 12" — it fits in the Family Feast too.',
      },
    ],
    faqs: [
      {
        q: 'Do you really deliver this far from Phase 6?',
        a: {
          text: 'Yes. Phase 1, Phase 2 and Phase 2 Extension are all on our delivery map at the {fee:dha-1..7,dha-2-ext,dha-7-ext} fee for DHA Phases 1–7. It is the longest ride we make, so order a little ahead if you are feeding people at a set time.',
          when: [{ sameFee: ['dha-1..7', 'dha-2-ext', 'dha-7-ext'] }, { on: ['dha-1..7', 'dha-2-ext', 'dha-7-ext'] }],
          otherwise:
            'Yes. Phase 1, Phase 2 and Phase 2 Extension are all on our delivery map, at {fee:dha-1,dha-2,dha-2-ext}. It is the longest ride we make, so order a little ahead if you are feeding people at a set time.',
        },
      },
      {
        q: 'Do you deliver to Phase 2 Extension?',
        a: {
          text: 'Yes, Phase 2 Ext has its own option at checkout. We deliver in DHA and Clifton only, so for boundary streets near Korangi Road, drop us a WhatsApp first and we will confirm your address is in zone.',
          when: { areasAsBuilt: true },
          otherwise:
            'Yes, Phase 2 Ext has its own option at checkout. We deliver in {where} only, so for boundary streets near Korangi Road, drop us a WhatsApp first and we will confirm your address is in zone.',
        },
      },
      {
        q: 'Is it still cash on delivery this far out?',
        a: taxed(
          'Always — same as every zone. Pay the rider when the food arrives: the menu total plus {tax} and the {fee:dha-1,dha-2,dha-2-ext} delivery fee.',
          'Always — same as every zone. Pay the rider when the food arrives: the menu total plus the {fee:dha-1,dha-2,dha-2-ext} delivery fee.',
        ),
      },
    ],
    adjacent: ['dha-phase-4'],
  },
  {
    slug: 'clifton',
    name: 'Clifton',
    h1: 'Pizza & Burger Delivery in Clifton, Karachi',
    title: 'Pizza & Burger Delivery in Clifton, Karachi',
    description: {
      text: 'Pizza & burgers delivered to Clifton Blocks 1–9 — Boat Basin, Schon Circle and beyond. {fee:clifton-3..9} (Blocks 1 & 2: {fee:clifton-1,clifton-2}). Cash on delivery, open till {closes}.',
      // "Blocks 1–9": only while all nine are delivered to. Blocks switched off: renderArea's
      // description names the blocks that are on, their fee, and the ones paused.
      when: { on: ['clifton-1..9'] },
    },
    zoneIds: [
      'clifton-1',
      'clifton-2',
      'clifton-3',
      'clifton-4',
      'clifton-5',
      'clifton-6',
      'clifton-7',
      'clifton-8',
      'clifton-9',
    ],
    intro: [
      {
        text: 'Clifton has no shortage of food streets — what it lacks at midnight is a kitchen still answering. We deliver across Clifton from our DHA Phase 6 kitchen every day until {closes}, cash on delivery.',
        when: [{ closesAfterMidnight: true }, { everyDay: true }],
        otherwise:
          'Clifton has no shortage of food streets. We deliver across Clifton from our DHA Phase 6 kitchen {days} until {closes}, cash on delivery.',
      },
      {
        text: 'Coverage runs across all nine blocks, from Boat Basin and Schon Circle to Bilawal Chowrangi and the Sea View side. Delivery is {fee:clifton-3..9} for Blocks 3–9 and {fee:clifton-1,clifton-2} for Blocks 1 and 2.',
        when: { delivering: true },
        // Blocks switched off: the fee of the blocks that are on only.
        otherwise: {
          text: 'Coverage runs from Boat Basin and Schon Circle to Bilawal Chowrangi and the Sea View side. Delivery is {fee:clifton-3..9} for Blocks 3–9.',
          when: { delivering: true },
          otherwise: {
            text: 'Delivery to Clifton Blocks 1 and 2 is {fee:clifton-1,clifton-2}.',
            when: { delivering: true },
          },
        },
      },
    ],
    landmarks: [
      { name: 'Boat Basin', in: ['clifton-5'] },
      'Schon Circle',
      'Bilawal Chowrangi',
      // Names all nine blocks: listed only while every one is on.
      {
        name: 'Clifton Blocks 1–9',
        in: ['clifton-1', 'clifton-2', 'clifton-3', 'clifton-4', 'clifton-5', 'clifton-6', 'clifton-7', 'clifton-8', 'clifton-9'],
        every: true,
      },
      'Sea View apartments side',
    ],
    popular: [
      {
        name: 'Cheetos',
        blurb: 'A Signature Large 12" — fajita chicken and jalapeño with creamy cheese and a hot, tangy red spice, with ranch dip.',
      },
      {
        name: 'Perfect Pair value deal',
        blurb: 'Two Medium 9" regular-menu pizzas and a 1 litre soft drink — right-sized for two.',
      },
      {
        name: 'Chicken Tikka Malai',
        blurb: 'The creamy side of tikka, from the regular menu in Medium 9" or Large 12".',
      },
    ],
    faqs: [
      {
        q: 'Which Clifton blocks do you deliver to?',
        a: {
          text: 'All of them — Blocks 1 to 9, including Boat Basin and Schon Circle. Delivery is {fee:clifton-3..9} for Blocks 3–9 and {fee:clifton-1,clifton-2} for Blocks 1 and 2.',
          // Blocks switched off: not "all of them", and no fee for them.
          when: { on: ['clifton-1..9'] },
        },
      },
      {
        // True only while the areas are today's: with an area added or switched off, left out.
        q: 'Do you deliver beyond Clifton?',
        a: 'No — we deliver in DHA and Clifton only, and the checkout will not take an address outside those zones.',
        when: { areasAsBuilt: true },
      },
      {
        q: 'Do you deliver to apartment towers?',
        a: 'Yes. Add the tower name and apartment number in the order notes, and keep your phone on for the rider.',
      },
    ],
    adjacent: ['dha-phase-5'],
  },
];

export function getArea(slug: string): DeliveryArea | undefined {
  return DELIVERY_AREAS.find((a) => a.slug === slug);
}

/**
 * The page's delivery-fee chip: "Rs N delivery" when every area on the
 * page that is on costs the same, "Rs N–M delivery" when not, "Delivery
 * paused" when the owner has switched every one off. Throws on an unknown
 * zone id so a typo fails the build instead of shipping a wrong fee.
 */
export function feeText(area: DeliveryArea, facts: SiteFacts): string {
  return zonesFeeChip(`areas.ts: "${area.slug}"`, area.zoneIds, facts);
}

/** A landmark's name, the page's areas it lies in, and whether it needs all of them on. */
export function landmarkOf(area: DeliveryArea, l: Landmark): { name: string; in: readonly string[]; every: boolean } {
  return typeof l === 'string' ? { name: l, in: area.zoneIds, every: false } : { name: l.name, in: l.in, every: !!l.every };
}

/**
 * The page's streets and spots the shop delivers to now: a place is listed
 * while an area of the page it lies in is on (all of them, for one that names
 * several), so a place the owner switched off is never listed as covered —
 * on the page ("Streets & spots we cover") or its /delivery card. Every area
 * on (no block stored): the list as written.
 */
export function coveredLandmarks(area: DeliveryArea, facts: SiteFacts): string[] {
  const off = new Set(pausedZones(area.zoneIds, facts).map((z) => z.id));
  return area.landmarks.flatMap((l) => {
    const place = landmarkOf(area, l);
    const on = place.every ? place.in.every((id) => !off.has(id)) : place.in.some((id) => !off.has(id));
    return on ? [place.name] : [];
  });
}

/** An area page's words for these facts: fees filled in, sentences whose claim no longer holds left out. */
export interface RenderedArea {
  slug: string;
  name: string;
  h1: string;
  title: string;
  description: string;
  intro: string[];
  /** The streets and spots listed as covered now (coveredLandmarks). */
  landmarks: string[];
  popular: Array<{ name: string; blurb: string }>;
  faqs: Array<{ q: string; a: string }>;
  adjacent: string[];
  /** The fee chip (feeText). */
  fee: string;
  /** The page's areas the owner has switched off; empty normally. */
  paused: FactZone[];
  /** Every one of the page's areas is switched off. */
  allPaused: boolean;
  /** The page's "delivery is paused" note (the page, its slug and its words stay), or null. */
  pausedNote: string | null;
}

export function renderArea(area: DeliveryArea, facts: CopyFacts): RenderedArea {
  const paused = pausedZones(area.zoneIds, facts);
  const allPaused = paused.length === area.zoneIds.length;
  let description = renderCopy(area.description, facts);
  if (description === null) {
    // No wording holds: an area it names is switched off (a fee is never printed for one, and an
    // area is never named as delivered to). It says what is paused — the whole page, or those areas.
    if (paused.length === 0) throw new Error(`areas.ts: "${area.slug}" has no description for these fees`);
    if (allPaused) {
      description = `Pizza & burgers from ${shopNameProse(shopOf(facts))}’s DHA Phase 6 kitchen. Delivery to ${area.name} is paused right now — ${PAUSED_WA}`;
    } else {
      const on = area.zoneIds
        .map((id) => findFactZone(facts, id))
        .filter((z): z is NonNullable<typeof z> => !!z && z.active);
      // Numbered places as the fee summary words them ("Clifton Blocks 1–4 & 6–9"); named ones by
      // their short names ("Emaar and Creek Vista").
      const words = (zones: readonly FactZone[]) =>
        zones.some((z) => /\d/.test(z.shortName))
          ? placesWords(zones).split(' · ').join(', ')
          : listWords(zones.map((z) => z.shortName));
      description = `Pizza & burgers from ${shopNameProse(shopOf(facts))}’s Phase 6 kitchen to ${words(on)}: ${feeText(area, facts)}, cash on delivery. ${words(paused)}: paused right now.`;
    }
  }
  return {
    slug: area.slug,
    name: area.name,
    h1: area.h1,
    title: area.title,
    description,
    intro: area.intro.map((c) => renderCopy(c, facts)).filter((p): p is string => p !== null),
    landmarks: coveredLandmarks(area, facts),
    popular: area.popular.map((p) => ({ ...p })),
    faqs: area.faqs.flatMap((f) => {
      if (f.when && !claimHolds(f.when, facts)) return [];
      const q = renderCopy(f.q, facts);
      const a = renderCopy(f.a, facts);
      return q === null || a === null ? [] : [{ q, a }];
    }),
    adjacent: [...area.adjacent],
    fee: feeText(area, facts),
    paused,
    allPaused,
    pausedNote:
      paused.length === 0
        ? null
        : `Delivery to ${allPaused ? area.name : paused.map((z) => z.name).join(', ')} is paused right now — the checkout can’t take orders ${allPaused ? 'here' : 'there'} for the moment. Message us on WhatsApp and we’ll tell you when it’s back.`,
  };
}
