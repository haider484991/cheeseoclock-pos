import { BUSINESS } from './business';
import { findZone } from './delivery-zones';
import { formatCents } from './format';

/**
 * Delivery-area data driving the programmatic local-SEO pages at
 * /delivery/[slug]. Every field that renders as page copy is hand-written and
 * genuinely different per area — Google's doorway/scaled-content policies
 * punish synonym-swapped templates, so when adding an area, write real local
 * detail (landmarks, coverage edges, real menu items) or merge it into a
 * neighbouring page instead.
 *
 * Facts only: the shop delivers in DHA and Clifton ONLY (see
 * delivery-zones.ts), is open daily 12 noon – 1 am, and takes cash on
 * delivery. Delivery times are NOT confirmed — never write a minute count
 * into this copy. Menu items named here must exist on the printed menu.
 *
 * Fees are never typed into this file's structure: each area lists the
 * checkout zone ids it covers (`zoneIds`) and `feeText` reads the fee from
 * DELIVERY_ZONES, so a rate-card change moves every page's fee chip with it.
 * (Prose that names a fee — "Rs 200" — must be updated by hand.)
 */

export interface DeliveryArea {
  slug: string;
  /** Short human name, e.g. "DHA Phase 6". */
  name: string;
  /** H1 on the area page. */
  h1: string;
  /** <title> (template suffix appends " · Cheese O'Clock"). */
  title: string;
  /** Meta description, ≤160 chars. */
  description: string;
  /** DELIVERY_ZONES ids (delivery-zones.ts) this page covers — drives feeText. */
  zoneIds: string[];
  /** Hand-written intro paragraphs — the unique meat of the page. */
  intro: string[];
  /** Streets / commercial areas / landmarks we actually cover. */
  landmarks: string[];
  /** Real menu items to feature on this page (brand copy, links to /menu). */
  popular: Array<{ name: string; blurb: string }>;
  /** Area-specific visible FAQ. */
  faqs: Array<{ q: string; a: string }>;
  /** Slugs of bordering areas for internal linking. */
  adjacent: string[];
}

const WA_NUMBERS = BUSINESS.whatsappLines.map((l) => l.display).join(' or ');

export const DELIVERY_AREAS: DeliveryArea[] = [
  {
    slug: 'dha-phase-6',
    name: 'DHA Phase 6',
    h1: 'Pizza & Burger Delivery in DHA Phase 6 — From Our Kitchen Next Door',
    title: 'Pizza & Burger Delivery in DHA Phase 6, Karachi',
    description:
      'Cheese O’Clock’s kitchen is in Rahat Commercial, Phase 6 — our shortest ride. Pizza & burgers, Rs 200 delivery, cash on delivery. Open daily till 1 am.',
    zoneIds: ['dha-6'],
    intro: [
      `Phase 6 is home turf. Our kitchen is at ${BUSINESS.streetAddress}, so Phase 6 is the shortest ride we make. Every order is fired when it comes in, boxed straight from the oven and sent out hot.`,
      'From the Bukhari Commercial lanes to the houses off Khayaban-e-Shahbaz, delivery anywhere in Phase 6 is Rs 200. Late study session, family dinner or a midnight craving — we are open every day from 12 noon until 1 am.',
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
        a: 'Yes — the kitchen is in Rahat Commercial, Phase 6, so it is the shortest ride we make. Orders are fired when they arrive and sent out hot. Delivery inside Phase 6 is Rs 200.',
      },
      {
        q: 'Do you deliver to Bukhari and Nishat Commercial offices?',
        a: 'Yes — offices, shops and apartments across all Phase 6 commercial lanes. Add your building name and floor in the order notes and keep your phone on for the rider.',
      },
      {
        q: 'How late can I order in Phase 6?',
        a: `We take orders every day from 12 noon until 1 am — on the website, or on WhatsApp at ${WA_NUMBERS}.`,
      },
      {
        q: 'How do I pay?',
        a: 'Cash on delivery — pay the rider when your food arrives. Your bill is the menu total plus 15% tax and the Rs 200 delivery fee. No card or app required.',
      },
    ],
    adjacent: ['dha-phase-7', 'dha-phase-5', 'dha-phase-8'],
  },
  {
    slug: 'dha-phase-7',
    name: 'DHA Phase 7',
    h1: 'Pizza & Burger Delivery in DHA Phase 7, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 7, Karachi',
    description:
      'Pizza & crispy chicken burger delivery to DHA Phase 7 and Phase 7 Ext from our Phase 6 kitchen next door. Rs 200 delivery, cash on delivery.',
    zoneIds: ['dha-7', 'dha-7-ext'],
    intro: [
      'Phase 7 sits right next to our Phase 6 kitchen, so your order is on its way while the cheese is still moving. Every pizza and burger is fired when the ticket comes in.',
      'We cover the whole phase — the residential streets off Khayaban-e-Sehar, Sehar and Jami Commercial, and Phase 7 Extension — for Rs 200. If you are unsure about your street, send us a WhatsApp before you order.',
    ],
    landmarks: [
      'Khayaban-e-Sehar',
      'Sehar Commercial',
      'Jami Commercial',
      'Phase 7 Extension',
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
        a: 'Yes — Phase 7 Extension has its own option at checkout, at the same Rs 200 fee as the rest of DHA.',
      },
      {
        q: 'Which area do I pick at checkout?',
        a: 'DHA Phase 7, or DHA Phase 7 Extension if you are in Ext. If your street sits on the Phase 6 border, either is fine — the fee is Rs 200 both ways.',
      },
      {
        q: 'Is there a minimum order for Phase 7?',
        a: 'No minimum on the website. You pay cash on delivery: the menu total plus 15% tax and the Rs 200 delivery fee.',
      },
    ],
    adjacent: ['dha-phase-6', 'dha-phase-8'],
  },
  {
    slug: 'dha-phase-8',
    name: 'DHA Phase 8',
    h1: 'Pizza & Burger Delivery in DHA Phase 8, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 8, Karachi',
    description:
      'Pizza & burgers delivered across DHA Phase 8 — Do Darya side included. Rs 200; Emaar Crescent Bay & Creek Vista Rs 250. Cash on delivery, till 1 am.',
    zoneIds: ['dha-8', 'emaar', 'creek-vista'],
    intro: [
      'Phase 8 runs wide — from the Zulfiqar and Al-Murtaza commercial strips out to the sea at Do Darya — and we deliver across all of it. Orders leave our Phase 6 kitchen boxed straight from the oven.',
      'Delivery is Rs 200 across Phase 8, and Rs 250 for Emaar Crescent Bay and Creek Vista, which are their own zones at checkout. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider cash.',
    ],
    landmarks: [
      'Zulfiqar Commercial',
      'Al-Murtaza Commercial',
      'Do Darya side',
      'Emaar Crescent Bay',
      'Creek Vista',
      'Khayaban-e-Shaheen',
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
        a: 'Yes — the Do Darya side is covered at the standard Phase 8 fee of Rs 200.',
      },
      {
        q: 'Why is delivery to Emaar or Creek Vista Rs 250?',
        a: 'They are priced as separate zones on our rider service’s rate card — Rs 250 instead of the Rs 200 for the rest of DHA. Pick Emaar Crescent Bay or Creek Vista at checkout and the right fee is added for you.',
      },
      {
        q: 'Will the food still be hot in Phase 8?',
        a: 'Orders are boxed straight from the oven and sent out as soon as they are ready. If anything is not right when it arrives, message us on WhatsApp.',
      },
      {
        q: 'Can I order late at night in Phase 8?',
        a: 'Yes — we take Phase 8 orders every day until 1 am.',
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
      'Pizza & crispy chicken burgers delivered across DHA Phase 5 — Khadda Market, 26th Street, Badar Commercial. Rs 200 delivery, cash on delivery.',
    zoneIds: ['dha-5'],
    intro: [
      'Phase 5 neighbours our Phase 6 kitchen, so the ride from oven to gate is a short one — from the Khadda Market lanes to the quieter streets off Khayaban-e-Tanzeem. Delivery anywhere in Phase 5 is Rs 200.',
      'Phase 5 has plenty of food, but most of it means going out. We bring it home instead: crispy chicken burgers in brioche buns, Medium or Large pizzas with a proper cheese pull, and masala fries — all paid in cash at your door.',
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
        a: 'Yes — Khadda Market and the lanes around it are covered at the standard Phase 5 fee of Rs 200.',
      },
      {
        q: 'Do you cover all of 26th Street?',
        a: 'Yes, the full stretch. For apartment buildings, add the building name in your order notes and keep your phone on for the rider.',
      },
      {
        q: 'Can I pay by card?',
        a: 'Not at the moment — every order is cash on delivery. The bill is the menu total plus 15% tax and the Rs 200 delivery fee.',
      },
    ],
    adjacent: ['dha-phase-6', 'dha-phase-4', 'clifton'],
  },
  {
    slug: 'dha-phase-4',
    name: 'DHA Phase 4',
    h1: 'Pizza & Burger Delivery in DHA Phase 4, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 4, Karachi',
    description:
      'Pizza & crispy chicken burgers delivered to DHA Phase 4 and Phase 3 — 9th Commercial, Sunset side and the residential lanes. Rs 200, cash on delivery.',
    zoneIds: ['dha-4', 'dha-3'],
    intro: [
      'Phase 4 sits between our kitchen and the older phases, and we deliver across all of it — the Sunset Boulevard side, the 9th Commercial strip and the residential lanes in between. Phase 3 next door is covered too. Delivery to either is Rs 200.',
      `Order on the website in under a minute, or WhatsApp your order and street to ${WA_NUMBERS} — both land in the same kitchen, and both are cash on delivery.`,
    ],
    landmarks: [
      '9th Commercial Street',
      'Sunset Boulevard side',
      'Phase 4 residential lanes',
      'DHA Phase 3',
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
        a: 'Yes — pick DHA Phase 3 at checkout. It is Rs 200, the same as Phase 4 and the rest of DHA.',
      },
      {
        q: 'Do you deliver to offices in 9th Commercial?',
        a: 'Yes — lunch and dinner, from 12 noon. Put the office name and floor in the order notes, and keep your phone close for the rider’s call.',
      },
      {
        q: 'Is WhatsApp ordering available for Phase 4?',
        a: `Yes. Message your order and address to ${WA_NUMBERS} and we will confirm the total right away.`,
      },
    ],
    adjacent: ['dha-phase-5', 'dha-phase-1-2'],
  },
  {
    slug: 'dha-phase-1-2',
    name: 'DHA Phase 1 & 2',
    h1: 'Pizza & Burger Delivery in DHA Phase 1 & 2, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 1 & 2, Karachi',
    description:
      'Pizza & burger delivery to DHA Phase 1, Phase 2 and Phase 2 Ext from our Phase 6 kitchen. Rs 200 delivery, cash on delivery — order online or WhatsApp.',
    zoneIds: ['dha-1', 'dha-2', 'dha-2-ext'],
    intro: [
      'Phase 1 and Phase 2 are the longest ride from our Phase 6 kitchen, and we will not pretend otherwise. What does not change is how the food leaves: fired to order, boxed straight from the oven and sent out hot — for the same Rs 200 as the rest of DHA.',
      'We cover Phase 1, Phase 2 and Phase 2 Extension: the Korangi Road side, Defence Mor and the Phase 2 Ext lanes. If your street sits right on the boundary, send a WhatsApp and we will confirm before you order.',
    ],
    landmarks: [
      'Korangi Road stretch',
      'Defence Mor',
      'Phase 2 commercial lanes',
      'Phase 2 Extension',
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
        a: 'Yes. Phase 1, Phase 2 and Phase 2 Extension are all on our delivery map at the standard DHA fee of Rs 200. It is the longest ride we make, so order a little ahead if you are feeding people at a set time.',
      },
      {
        q: 'Do you deliver to Phase 2 Extension?',
        a: 'Yes, Phase 2 Ext has its own option at checkout. We deliver in DHA and Clifton only, so for boundary streets near Korangi Road, drop us a WhatsApp first and we will confirm your address is in zone.',
      },
      {
        q: 'Is it still cash on delivery this far out?',
        a: 'Always — same as every zone. Pay the rider when the food arrives: the menu total plus 15% tax and the Rs 200 delivery fee.',
      },
    ],
    adjacent: ['dha-phase-4'],
  },
  {
    slug: 'clifton',
    name: 'Clifton',
    h1: 'Pizza & Burger Delivery in Clifton, Karachi',
    title: 'Pizza & Burger Delivery in Clifton, Karachi',
    description:
      'Pizza & burgers delivered to Clifton Blocks 1–9 — Boat Basin, Schon Circle and beyond. Rs 200 (Blocks 1 & 2: Rs 250). Cash on delivery, open till 1 am.',
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
      'Clifton has no shortage of food streets — what it lacks at midnight is a kitchen still answering. We deliver across Clifton from our DHA Phase 6 kitchen every day until 1 am, cash on delivery.',
      'Coverage runs across all nine blocks, from Boat Basin and Schon Circle to Bilawal Chowrangi and the Sea View side. Delivery is Rs 200 for Blocks 3–9 and Rs 250 for Blocks 1 and 2.',
    ],
    landmarks: [
      'Boat Basin',
      'Schon Circle',
      'Bilawal Chowrangi',
      'Clifton Blocks 1–9',
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
        a: 'All of them — Blocks 1 to 9, including Boat Basin and Schon Circle. Delivery is Rs 200 for Blocks 3–9 and Rs 250 for Blocks 1 and 2.',
      },
      {
        q: 'Do you deliver beyond Clifton?',
        a: 'No — we deliver in DHA and Clifton only, and the checkout will not take an address outside those zones.',
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
 * The page's delivery-fee label, read from DELIVERY_ZONES: "Rs 200 delivery"
 * when every zone on the page costs the same, "Rs 200–250 delivery" when not.
 * Throws on an unknown zone id so a typo fails the build instead of shipping
 * a wrong fee.
 */
export function feeText(area: DeliveryArea): string {
  const fees = area.zoneIds.map((id) => {
    const zone = findZone(id);
    if (!zone) throw new Error(`areas.ts: "${area.slug}" lists unknown delivery zone "${id}"`);
    return zone.feeCents;
  });
  if (fees.length === 0) throw new Error(`areas.ts: "${area.slug}" lists no delivery zones`);
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  if (min === max) return `${formatCents(min)} delivery`;
  return `${formatCents(min)}–${formatCents(max).replace(/^Rs\s*/, '')} delivery`;
}
