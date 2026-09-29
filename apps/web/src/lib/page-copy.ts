import { ALL_COMPILED_ZONE_IDS, taxed, type Copy } from './delivery-facts';

/**
 * Page sentences that name a delivery fee or where the shop delivers — and
 * (sweep B2 + B4) the shop's name, hours, numbers and what the rider takes —
 * kept here (a page file may only export what Next allows) so the tests can
 * check them: tokens, filled from the owner's settings by delivery-facts
 * renderCopy / fillFees. With no settings stored each reads exactly as
 * before. A sentence that names the areas by hand ("DHA and
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
  text: '{name} delivers pizza & burgers across DHA Phases 1–8 and Clifton from our Phase 6 kitchen. {fees} delivery, cash on delivery, open {days} till {closes}.',
  when: { areasAsBuilt: true },
  otherwise: {
    text: '{name} delivers pizza & burgers across {where} from our Phase 6 kitchen. {fees} delivery, cash on delivery, open {days} till {closes}.',
    when: { delivering: true },
    otherwise: '{name} delivers pizza & burgers from our Phase 6 kitchen. ' + PAUSED_LINE,
  },
};

/** /delivery, the paragraph under the heading. */
export const DELIVERY_HUB_INTRO: Copy = {
  text: 'Every order fires from our kitchen in DHA Phase 6 — {days} from {opens} to {closes}, always cash on delivery. We deliver in DHA and Clifton only: {summary}. Pick your area below for the streets we cover and answers to the questions your area actually asks.',
  when: { areasAsBuilt: true },
  otherwise: {
    text: 'Every order fires from our kitchen in DHA Phase 6 — {days} from {opens} to {closes}, always cash on delivery. We deliver in {where} only: {summary}. Pick your area below for the streets we cover and answers to the questions your area actually asks.',
    when: { delivering: true },
    otherwise: 'Every order fires from our kitchen in DHA Phase 6 — {days} from {opens} to {closes}, always cash on delivery. ' + PAUSED_LINE,
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

// ---------------------------------------------------------------------------
// The shop's details in the pages' words (sweep B2 + B4). Tokens and claims:
// lib/delivery-facts.ts fillFees / CopyClaim. With nothing saved on the till
// every line reads exactly as v0.7.30 (pages-golden.test.ts). What they rest
// on:
//  - the hours are DISPLAY ONLY (ordering follows the till's shift): {hours},
//    {opens}, {closes}, {days}, {hoursLine}; "every day" / "every night" only
//    while the shop opens all seven days ({ everyDay }); "past midnight"
//    only while it closes after midnight ({ closesAfterMidnight });
//  - cash is always taken (v1): "Cash on delivery" stays true everywhere; a
//    sentence that says ONLY cash is claimed ({ cashOnly } / {
//    pickupCashOnly }) or names what the rider takes ({DoorPayments});
//  - the name: {name} / {nameProse}; a line built on its pun ("It's always
//    …") prints only while the name is today's ({ nameIsDefault }), else
//    plain words;
//  - tax: {tax} / {Tax} — the food's one rate, or no number; every sentence
//    that names tax is taxed(…, its words for food taxed at 0%).
// ---------------------------------------------------------------------------

/** The root layout: the site's title, and the template every page's title goes into. */
export const SITE_TITLE: Copy = 'Pizza & Burger Delivery in DHA Karachi | {name}';
export const SITE_TITLE_TEMPLATE: Copy = '%s · {name}';
/** The root layout's Open Graph and Twitter title. */
export const SITE_SHARE_TITLE: Copy = '{name} — Pizza & Burger Delivery in DHA Karachi';
/** The root layout's meta description. */
export const SITE_DESCRIPTION: Copy =
  'Signature pizzas, crispy chicken burgers and fries delivered across DHA Phases 1–8 and Clifton. Cash on delivery, open {days} {hours}. Order online or on WhatsApp.';
/** The root layout's Open Graph description. */
export const SITE_OG_DESCRIPTION: Copy =
  'Five signature pizzas, crispy chicken burgers and fries, fired to order in DHA Phase 6. Cash on delivery across DHA & Clifton, open {hours}.';
/** The root layout's Twitter description, and the app manifest's. */
export const SITE_SHORT_DESCRIPTION: Copy =
  'Signature pizzas, crispy chicken burgers and fries delivered across DHA & Clifton. Cash on delivery, open {hours}.';
/** The app manifest's name. */
export const MANIFEST_NAME: Copy = '{name} — Pizza & Burger Delivery';

/** The root share image's headline (upper-cased): the name's pun, else the name. */
export const OG_TITLE: Copy = { text: "IT'S ALWAYS {name}.", when: { nameIsDefault: true }, otherwise: '{name}.' };

/** The page-specific WhatsApp messages: their own words, with the shop's name. */
export const WA_PIZZA: Copy = "Hi {name}! I'd like to order pizza. ";
export const WA_BURGERS: Copy = "Hi {name}! I'd like to order burgers. ";
export const WA_LATE_NIGHT: Copy = 'Hi {name}! Late night order please: ';
export const WA_HUB: Copy = 'Hi {name}! Do you deliver to my area? My address is: ';

/** Footer: the chip under the tagline. */
export const FOOTER_PAY_CHIP: Copy = taxed('Cash on delivery · {tax} on the bill', 'Cash on delivery');
/** Footer: the late-night page's link (the page is always there; its title follows the closing time). */
export const FOOTER_LATE_LINK: Copy = 'Late-night delivery (till {closes})';

// --- Home ----------------------------------------------------------------------

/** Home hero, under the tagline. */
export const HOME_HERO_TEXT: Copy =
  'Five signature pizzas, crispy chicken burgers and fries — made to order in DHA Phase 6. Pay {doorPayments} at your door.';
/** Home hero chip with the hours. */
export const HOME_HERO_HOURS: Copy = { text: '{hours} daily', when: { everyDay: true }, otherwise: '{hours} · {days}' };
/** The ticker's words after the tagline, in order (upper-cased; a line that can't print is left out). */
export const HOME_MARQUEE: Copy[] = [
  'WE DELIVER ALL OVER DHA & CLIFTON',
  'OPEN {hours}',
  'CASH ON DELIVERY',
  'FIVE SIGNATURE PIZZAS',
  { text: "IT'S ALWAYS {name}", when: { nameIsDefault: true } },
];
/** "How it works", step 3's title. */
export const HOME_STEP_PAY: Copy = { text: 'Pay cash at your door', when: { cashOnly: true }, otherwise: 'Pay at your door' };
/** "How it works": the hours stat (big, small). */
export const HOME_STAT_HOURS: Copy = '{hours}';
export const HOME_STAT_DAYS: Copy = { text: 'open every day', when: { everyDay: true }, otherwise: 'open {days}' };
/** Home FAQ, "What are your hours?". */
export const HOME_FAQ_HOURS: Copy = { text: 'Every day from {opens} to {closes}.', when: { everyDay: true }, otherwise: '{days} from {opens} to {closes}.' };
/** Home FAQ, "How do I pay?". */
export const HOME_FAQ_PAY: Copy = taxed(
  '{DoorPayments} on delivery. {Tax} is added on the bill, and the printed receipt from the kitchen is the final amount.',
  '{DoorPayments} on delivery. The printed receipt from the kitchen is the final amount.',
);
/** Home FAQ, "Can I order on WhatsApp instead?". */
export const HOME_FAQ_WHATSAPP: Copy =
  "Yes — message {waNumbers} with your order and address, and we'll confirm the total. Same kitchen, same prices.";
/** Home, the last band's heading. */
export const HOME_FINAL_HEADING: Copy = { text: 'Hungry? It’s {nameProse}.', when: { nameIsDefault: true }, otherwise: 'Hungry? Order now.' };
/** Home, the map card's title (once the map is shown). */
export const HOME_MAP_TITLE: Copy = '{name}, {areaLine} on Google Maps';

// --- Pizza landing ---------------------------------------------------------------

export const PIZZA_DESCRIPTION: Copy =
  'Order pizza online for delivery across DHA Phases 1–8 and Clifton — Signature pies and regular pizzas in Medium 9" or Large 12". Cash on delivery, till {closes}.';
export const PIZZA_INTRO: Copy = {
  text: 'Craving pizza in DHA? Ours bakes in our Phase 6 kitchen and rides out across every DHA phase and Clifton — Signature pies and regular pizzas in Medium 9" or Large 12", fired to order and paid in cash at your door. Order on the website in under a minute, or send your order on WhatsApp; both land straight in the kitchen.',
  when: { cashOnly: true },
  otherwise:
    'Craving pizza in DHA? Ours bakes in our Phase 6 kitchen and rides out across every DHA phase and Clifton — Signature pies and regular pizzas in Medium 9" or Large 12", fired to order and paid at your door. Order on the website in under a minute, or send your order on WhatsApp; both land straight in the kitchen.',
};
/** Under the intro: nothing to install, nothing to pay online — while the rider takes cash only (a wallet or a bank transfer at the door is paid online). */
export const PIZZA_NO_APP: Copy = {
  text: 'No app downloads, no online payments: the box goes from the oven to the rider and is opened by you. If a pizza ever arrives in a state we would not serve, message us on WhatsApp.',
  when: { cashOnly: true },
  otherwise:
    'No app downloads, nothing to pay before it arrives: the box goes from the oven to the rider and is opened by you. If a pizza ever arrives in a state we would not serve, message us on WhatsApp.',
};
export const PIZZA_FAQ_LATE: Copy = {
  text: 'Yes — we take orders every day from {opens} until {closes}, on the website and on WhatsApp.',
  when: { everyDay: true },
  otherwise: 'Yes — we take orders {days}, from {opens} until {closes}, on the website and on WhatsApp.',
};
export const PIZZA_FAQ_PAY: Copy = taxed(
  '{DoorPayments} on delivery on every order. The bill is the menu total plus {tax} and your area’s delivery fee.',
  '{DoorPayments} on delivery on every order. The bill is the menu total plus your area’s delivery fee.',
);
/** The order band's heading (upper-cased). */
export const PIZZA_CTA: Copy = { text: "PIZZA CRAVING? IT'S {name}.", when: { nameIsDefault: true }, otherwise: 'PIZZA CRAVING? ORDER UP.' };
/** The page's JSON-LD WebPage description. */
export const PIZZA_PAGE_DESCRIPTION: Copy =
  'Signature and regular pizzas delivered across DHA Karachi and Clifton — cash on delivery, open till {closes}.';

// --- Burger landing --------------------------------------------------------------

export const BURGER_DESCRIPTION: Copy =
  'Crispy chicken burgers — thigh-marinated fillets in brioche buns — delivered across DHA Phases 1–8 and Clifton. Cash on delivery, open {days} till {closes}.';
export const BURGER_INTRO_ORDER: Copy = {
  text: 'Order online in under a minute or send a WhatsApp — both are cash on delivery, every day from {opens} to {closes}.',
  when: { everyDay: true },
  otherwise: 'Order online in under a minute or send a WhatsApp — both are cash on delivery, {days}, from {opens} to {closes}.',
};
export const BURGER_FAQ_PAY: Copy = taxed(
  {
    text: 'Cash on delivery on every order — no cards or wallets needed. The bill is the menu total plus {tax} and your area’s delivery fee.',
    when: { cashOnly: true },
    otherwise: 'No — the rider takes {doorPayments}. The bill is the menu total plus {tax} and your area’s delivery fee.',
  },
  {
    text: 'Cash on delivery on every order — no cards or wallets needed. The bill is the menu total plus your area’s delivery fee.',
    when: { cashOnly: true },
    otherwise: 'No — the rider takes {doorPayments}. The bill is the menu total plus your area’s delivery fee.',
  },
);
/** The order band's heading (upper-cased). */
export const BURGER_CTA: Copy = { text: "BURGER MOOD? IT'S {name}.", when: { nameIsDefault: true }, otherwise: 'BURGER MOOD? ORDER UP.' };
/** The page's JSON-LD WebPage description. */
export const BURGER_PAGE_DESCRIPTION: Copy =
  'Crispy chicken burgers in brioche buns, delivered across DHA Karachi and Clifton — cash on delivery, open till {closes}.';

// --- Late-night landing (its slug stays, whatever the hours) ----------------------

export const LATE_NIGHT_TITLE: Copy = 'Late-Night Food Delivery in DHA Karachi — Open Till {closes}';
export const LATE_NIGHT_DESCRIPTION: Copy =
  'Kitchen open {days} till {closes} — pizza, crispy chicken burgers, masala fries & baked wings delivered late across DHA and Clifton. Cash on delivery.';
/** The H1 (upper-cased). */
export const LATE_NIGHT_H1: Copy = 'LATE-NIGHT FOOD DELIVERY IN DHA KARACHI — OPEN TILL {closes}';
export const LATE_NIGHT_INTRO: Copy = {
  text: 'It is past midnight, half of DHA’s kitchens went dark hours ago, and the delivery apps are showing you sad leftovers. Ours is the kitchen still glowing in Phase 6: pizzas baking, crispy chicken burgers coming together and riders rolling out across DHA and Clifton until {closes} — every night, not just weekends.',
  when: [{ closesAfterMidnight: true }, { everyDay: true }],
  otherwise: {
    text: 'It is past midnight, half of DHA’s kitchens went dark hours ago, and the delivery apps are showing you sad leftovers. Ours is the kitchen still glowing in Phase 6: pizzas baking, crispy chicken burgers coming together and riders rolling out across DHA and Clifton until {closes}.',
    when: { closesAfterMidnight: true },
    otherwise:
      'It is late, half of DHA’s kitchens have gone dark, and the delivery apps are showing you sad leftovers. Ours is the kitchen still glowing in Phase 6: pizzas baking, crispy chicken burgers coming together and riders rolling out across DHA and Clifton until {closes}.',
  },
};
export const LATE_NIGHT_INTRO_ORDER: Copy = {
  text: 'Night orders are honestly our favourite. Order before {closes} on the website or WhatsApp, add a note if the house is asleep, and pay the rider in cash at the gate.',
  when: { cashOnly: true },
  otherwise:
    'Night orders are honestly our favourite. Order before {closes} on the website or WhatsApp, add a note if the house is asleep, and pay the rider at the gate.',
};
export const LATE_NIGHT_PICKS_HEADING: Copy = {
  text: 'WHAT DHA ORDERS AFTER MIDNIGHT',
  when: { closesAfterMidnight: true },
  otherwise: 'WHAT DHA ORDERS AT NIGHT',
};
export const LATE_NIGHT_PICK_BIG: Copy = 'Till {closes}';
export const LATE_NIGHT_PICK_SMALL: Copy = { text: 'Ovens on every night', when: { everyDay: true }, otherwise: 'Ovens on {days}' };
export const LATE_NIGHT_PICK_TITLE: Copy = { text: 'The midnight pizza', when: { closesAfterMidnight: true }, otherwise: 'The late pizza' };
export const LATE_NIGHT_WINGS_BODY: Copy = {
  text: 'Six oven-baked wings with a dip, somehow always justified at midnight. Add a cold drink to the order — you know you want to.',
  when: { closesAfterMidnight: true },
  otherwise: 'Six oven-baked wings with a dip, somehow always justified late at night. Add a cold drink to the order — you know you want to.',
};
export const LATE_NIGHT_PICK_BODY: Copy =
  'The star-cut Cheesy Star, built for sharing — or a Classic Pepperoni in Medium 9" or Large 12". The ovens stay on until we close at {closes}.';
export const LATE_NIGHT_COVERAGE: Copy = 'Same delivery map and fees all night — DHA and Clifton, until {closes}.';
export const LATE_NIGHT_FAQ_HOW_LATE: Copy = {
  text: 'The kitchen takes orders every single day until {closes} — website and WhatsApp both — and opens again at {opens}.',
  when: { everyDay: true },
  otherwise: 'The kitchen takes orders {days} until {closes} — website and WhatsApp both — and opens at {opens}.',
};
export const LATE_NIGHT_FAQ_WHATSAPP: Copy = 'Yes — until {closes} on {waNumbers}. Send your order and address and we will confirm the total.';
export const LATE_NIGHT_FAQ_AREAS_Q: Copy = {
  text: 'Which areas do you cover after midnight?',
  when: { closesAfterMidnight: true },
  otherwise: 'Which areas do you cover late at night?',
};
export const LATE_NIGHT_FAQ_PAY: Copy = taxed(
  '{DoorPayments} on delivery, same as always — the menu total plus {tax} and your area’s delivery fee. If the house is asleep, say so in the order notes and keep your phone on for the rider.',
  '{DoorPayments} on delivery, same as always — the menu total plus your area’s delivery fee. If the house is asleep, say so in the order notes and keep your phone on for the rider.',
);
/** The order band's heading (upper-cased). */
export const LATE_NIGHT_CTA: Copy = {
  text: 'MIDNIGHT CRAVING? STILL {name}.',
  when: [{ nameIsDefault: true }, { closesAfterMidnight: true }],
  otherwise: { text: 'LATE CRAVING? STILL {name}.', when: { nameIsDefault: true }, otherwise: 'LATE CRAVING? ORDER UP.' },
};
/** The page's JSON-LD WebPage description. */
export const LATE_NIGHT_PAGE_DESCRIPTION: Copy = {
  text: 'Pizza, crispy chicken burgers, fries and baked wings delivered across DHA Karachi and Clifton until {closes} every night — cash on delivery.',
  when: { everyDay: true },
  otherwise:
    'Pizza, crispy chicken burgers, fries and baked wings delivered across DHA Karachi and Clifton until {closes}, {days} — cash on delivery.',
};

// --- Delivery hub, area pages, /menu, the checkout ---------------------------------

export const HUB_LATE_LINK: Copy = 'Late-night food delivery (open till {closes}) →';
export const HUB_MAP_TITLE: Copy = '{name} delivery coverage map — DHA Karachi';
/** The hub's JSON-LD WebPage description. */
export const HUB_PAGE_DESCRIPTION: Copy = 'Delivery coverage, fees and covered streets for every {nameProse} zone across DHA Karachi and Clifton.';
/** An area page's order band heading after "HUNGRY IN <AREA>?" (upper-cased). */
export const AREA_CTA_TAIL: Copy = { text: "IT'S {name}.", when: { nameIsDefault: true }, otherwise: 'ORDER UP.' };
export const MENU_DESCRIPTION: Copy =
  'Full {name} menu with prices in PKR — five signature pizzas, regular pizzas in Medium 9" and Large 12", crispy chicken burgers, fries, wings and value deals. Cash on delivery across DHA & Clifton.';
/** /menu's JSON-LD WebPage name. */
export const MENU_PAGE_NAME: Copy = '{name} Menu & Prices';
/**
 * /menu, the line under the sections. "on delivery or at the counter" names
 * one list for both only while the rider and the counter take the same;
 * otherwise each its own.
 */
export const MENU_FOOT_LINE: Copy = taxed(
  {
    text: 'Prices in PKR · {tax} added on the bill · pay {doorPayments} on delivery or at the counter',
    when: { samePayments: true },
    otherwise: 'Prices in PKR · {tax} added on the bill · pay {doorPayments} on delivery and {pickupPayments} at the counter',
  },
  {
    text: 'Prices in PKR · pay {doorPayments} on delivery or at the counter',
    when: { samePayments: true },
    otherwise: 'Prices in PKR · pay {doorPayments} on delivery and {pickupPayments} at the counter',
  },
);
/** The checkout's last line: how the customer pays (delivery, pick-up). */
export const CHECKOUT_PAY_DELIVERY: Copy = {
  text: 'You pay the rider in cash. The printed receipt from the kitchen is the final bill.',
  when: { cashOnly: true },
  otherwise: 'You pay the rider — {doorPayments}. The printed receipt from the kitchen is the final bill.',
};
export const CHECKOUT_PAY_PICKUP: Copy = {
  text: 'You pay in cash when you collect. The printed receipt from the kitchen is the final bill.',
  when: { pickupCashOnly: true },
  otherwise: 'You pay when you collect — {pickupPayments}. The printed receipt from the kitchen is the final bill.',
};
