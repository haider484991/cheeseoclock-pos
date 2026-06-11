/**
 * Delivery-area data driving the programmatic local-SEO pages at
 * /delivery/[slug]. Every field that renders as page copy is hand-written and
 * genuinely different per area — Google's doorway/scaled-content policies
 * punish synonym-swapped templates, so when adding an area, write real local
 * detail (landmarks, coverage edges, honest ETAs) or merge it into a
 * neighbouring page instead.
 *
 * ETAs are kitchen-to-door estimates from the Phase 6 kitchen — tune them to
 * real rider data as it accumulates.
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
  /** Estimated delivery window in minutes. */
  eta: { min: number; max: number };
  /** Hand-written intro paragraphs — the unique meat of the page. */
  intro: string[];
  /** Streets / commercial areas / landmarks we actually cover. */
  landmarks: string[];
  /** What people in this area order most (brand copy, links to /menu). */
  popular: Array<{ name: string; blurb: string }>;
  /** Area-specific visible FAQ. */
  faqs: Array<{ q: string; a: string }>;
  /** Slugs of bordering areas for internal linking. */
  adjacent: string[];
}

export const DELIVERY_AREAS: DeliveryArea[] = [
  {
    slug: 'dha-phase-6',
    name: 'DHA Phase 6',
    h1: 'Pizza & Burger Delivery in DHA Phase 6 — From Our Kitchen Next Door',
    title: 'Pizza & Burger Delivery in DHA Phase 6, Karachi',
    description:
      'Cheese O’Clock’s kitchen is in Phase 6 — the fastest pizza & burger delivery in the phase. Hot in 20–35 min, cash on delivery. Order online or WhatsApp.',
    eta: { min: 20, max: 35 },
    intro: [
      'Phase 6 is home turf. Our kitchen sits right here, which means your pizza comes out of the oven and onto your table faster than anywhere else we deliver — usually inside half an hour, still too hot to grab the first slice.',
      'From Bukhari Commercial lanes to the houses off Khayaban-e-Shahbaz, our riders know every street and every shortcut. Late-night study session, family dinner, or a 1am craving — we are open until 2am, every day.',
    ],
    landmarks: [
      'Bukhari Commercial',
      'Nishat Commercial',
      'Rahat Commercial',
      'Muslim Commercial',
      'Khayaban-e-Shahbaz',
      'Khayaban-e-Ittehad',
      'Khayaban-e-Bukhari',
    ],
    popular: [
      { name: 'Signature cheese-pull pizzas', blurb: 'The ones the brand is named after — extra cheese is the default here.' },
      { name: 'Double-smash burgers', blurb: 'Smashed to order, never pre-cooked, with our house sauce.' },
      { name: 'Loaded fries', blurb: 'The Phase 6 midnight favourite — cheese, sauces, crispy bits.' },
    ],
    faqs: [
      {
        q: 'How fast is delivery inside DHA Phase 6?',
        a: 'Usually 20–35 minutes door to door. Our kitchen is inside Phase 6, so you are our quickest delivery zone — most orders arrive in under half an hour.',
      },
      {
        q: 'Do you deliver to Bukhari and Nishat Commercial offices?',
        a: 'Yes — offices, shops and apartments across all Phase 6 commercial lanes. Add your building name and floor in the order notes and the rider will call when downstairs.',
      },
      {
        q: 'How late can I order in Phase 6?',
        a: 'We take orders daily until 2am. Late-night orders in Phase 6 typically arrive in 25 minutes or less since the streets are clear.',
      },
      {
        q: 'How do I pay?',
        a: 'Cash on delivery — pay the rider when your food arrives. No card or app required.',
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
      'Hot pizza & gourmet burger delivery to DHA Phase 7 and Phase 7 Ext in 25–40 min from our Phase 6 kitchen. Cash on delivery — order online or on WhatsApp.',
    eta: { min: 25, max: 40 },
    intro: [
      'Phase 7 sits a few minutes from our ovens, so your order crosses Khayaban-e-Ittehad and lands at your door while the cheese is still moving. Most Phase 7 deliveries arrive in around half an hour.',
      'We cover the whole phase — the residential streets off Khayaban-e-Sehar, the commercial strip, and Phase 7 Extension down to the Khayaban-e-Shaheen side. If you are unsure about your street, send us a WhatsApp and a rider will confirm in a minute.',
    ],
    landmarks: [
      'Khayaban-e-Sehar',
      'Sehar Commercial',
      'Phase 7 Extension',
      'Khayaban-e-Shaheen side',
      'Spinzer roundabout area',
    ],
    popular: [
      { name: 'BBQ chicken pizzas', blurb: 'Smoky, loaded, and a Phase 7 dinner-time staple.' },
      { name: 'Crispy wings', blurb: 'Tossed in house glaze — order them with extra dip.' },
      { name: 'Chocolate shakes', blurb: 'The usual add-on to a late Phase 7 order.' },
    ],
    faqs: [
      {
        q: 'Do you deliver to Phase 7 Extension?',
        a: 'Yes — Phase 7 Ext is fully covered, including the streets toward Khayaban-e-Shaheen. Expect the upper end of the 25–40 minute window for the far edge.',
      },
      {
        q: 'What is the delivery time to Khayaban-e-Sehar?',
        a: 'Around 25–35 minutes for most of the Sehar side, since it connects straight to our Phase 6 kitchen via Ittehad.',
      },
      {
        q: 'Is there a minimum order for Phase 7?',
        a: 'No minimum — though most Phase 7 orders are a deal for two. You pay cash on delivery exactly what the receipt says.',
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
      'Cheese O’Clock delivers oven-fresh pizza & smash burgers across DHA Phase 8 — Do Darya side included — in 30–45 min. Cash on delivery, open till 2am.',
    eta: { min: 30, max: 45 },
    intro: [
      'Phase 8 runs wide — from the Zulfiqar and Murtaza commercial strips out to the sea at Do Darya — and we deliver across all of it. Orders leave our Phase 6 kitchen in insulated bags so the pizza that reaches Creek-side still behaves like it just left the oven.',
      'Evening sea breeze plans at Do Darya that fell through? Skip the restaurant queue — order in, pay the rider cash, and eat with the same view from home.',
    ],
    landmarks: [
      'Zulfiqar Commercial',
      'Al-Murtaza Commercial',
      'Do Darya side',
      'Creek Vista apartments',
      'Khayaban-e-Shaheen',
    ],
    popular: [
      { name: 'Family-size loaded pizzas', blurb: 'Phase 8 orders big — our large pies feed the whole gathering.' },
      { name: 'Triple-stack burgers', blurb: 'For appetites that laugh at a single patty.' },
      { name: 'Wings + fries combos', blurb: 'The standard Phase 8 movie-night order.' },
    ],
    faqs: [
      {
        q: 'Do you deliver near Do Darya?',
        a: 'Yes — the Do Darya side and Creek Vista apartments are covered. Being our farthest Phase 8 corner, those orders land at the 40–45 minute end of the window.',
      },
      {
        q: 'Will the food still be hot in Phase 8?',
        a: 'Yes. Orders travel in insulated delivery bags, and pizzas are boxed straight from the oven. If anything ever arrives cold, message us on WhatsApp and we will make it right.',
      },
      {
        q: 'Can I order late at night in Phase 8?',
        a: 'We deliver to Phase 8 until 2am daily — one of the few kitchens still firing for the Creek side after midnight.',
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
      'Fresh pizza & loaded burgers delivered across DHA Phase 5 — Khadda Market, 26th Street & beyond — in 25–40 min. Cash on delivery, order online or WhatsApp.',
    eta: { min: 25, max: 40 },
    intro: [
      'Phase 5 neighbours our kitchen, so the ride from oven to your gate is short — usually 25 to 40 minutes across the phase, from the Khadda Market lanes to the quieter streets off Khayaban-e-Tanzeem.',
      'Phase 5 has plenty of food, but most of it means going out. We bring the gourmet side home: smashed-to-order burgers, pizzas with a proper cheese pull, and shakes — all paid in cash at your door.',
    ],
    landmarks: [
      'Khadda Market',
      '26th Street',
      'Khayaban-e-Tanzeem',
      'Khayaban-e-Bahria',
      'Saba Avenue side',
    ],
    popular: [
      { name: 'Smash burgers with fries', blurb: 'The Phase 5 lunch order — quick, hot, properly filling.' },
      { name: 'Margherita-style cheese pizzas', blurb: 'Simple, daily-proofed dough, very serious cheese.' },
      { name: 'Glazed wings', blurb: 'A Khadda-side favourite with the cricket on.' },
    ],
    faqs: [
      {
        q: 'How long does delivery to Khadda Market take?',
        a: 'The Khadda Market side is closest to us — usually 25–30 minutes. The far end toward Saba Avenue runs closer to 40.',
      },
      {
        q: 'Do you cover all of 26th Street?',
        a: 'Yes, the full stretch. For apartment buildings, add the building name in your order notes and the rider will call on arrival.',
      },
      {
        q: 'Can I pay by card?',
        a: 'We are cash on delivery for now — the rider carries change. The exact bill is printed on your receipt from the kitchen.',
      },
    ],
    adjacent: ['dha-phase-6', 'dha-phase-4', 'gizri'],
  },
  {
    slug: 'dha-phase-4',
    name: 'DHA Phase 4',
    h1: 'Pizza & Burger Delivery in DHA Phase 4, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 4, Karachi',
    description:
      'Cheese O’Clock delivers hot pizzas & gourmet burgers to DHA Phase 4 in 30–45 min — 9th Commercial, Sunset side and all residential lanes. Cash on delivery.',
    eta: { min: 30, max: 45 },
    intro: [
      'Phase 4 sits between us and the older phases, and our riders run the route all evening — across the Sunset Boulevard side, the 9th Commercial strip and the residential lanes in between. Expect your order hot in 30 to 45 minutes.',
      'Order by website in under a minute, or send a WhatsApp with what you want and your street — both land in the same kitchen queue, and both are cash on delivery.',
    ],
    landmarks: [
      '9th Commercial Street',
      'Sunset Boulevard side',
      'Khayaban-e-Badar stretch',
      'Phase 4 residential lanes',
    ],
    popular: [
      { name: 'Pepperoni-loaded pizzas', blurb: 'The most reordered Phase 4 item by a margin.' },
      { name: 'Classic cheeseburgers', blurb: 'House sauce, proper bun, no shortcuts.' },
      { name: 'Pasta in red sauce', blurb: 'For the one person in the group who is "not feeling pizza".' },
    ],
    faqs: [
      {
        q: 'What is the delivery time to Phase 4?',
        a: '30–45 minutes for most addresses. The 9th Commercial side is quickest; lanes toward Sunset Boulevard sit at the later end.',
      },
      {
        q: 'Do you deliver to offices in 9th Commercial?',
        a: 'Yes — lunch and dinner. Put the office name and floor in the notes, and keep your phone close for the rider’s call.',
      },
      {
        q: 'Is WhatsApp ordering available for Phase 4?',
        a: 'Yes. Message us your order and address on WhatsApp and we will confirm the total and ETA right away.',
      },
    ],
    adjacent: ['dha-phase-5', 'dha-phase-1-2', 'gizri'],
  },
  {
    slug: 'dha-phase-1-2',
    name: 'DHA Phase 1 & 2',
    h1: 'Pizza & Burger Delivery in DHA Phase 1 & 2, Karachi',
    title: 'Pizza & Burger Delivery in DHA Phase 1 & 2, Karachi',
    description:
      'Oven-fresh pizza & burger delivery to DHA Phase 1 and Phase 2 (incl. Phase 2 Ext) in 35–50 min from Phase 6. Cash on delivery — order online or WhatsApp.',
    eta: { min: 35, max: 50 },
    intro: [
      'The older phases are the longest ride from our Phase 6 ovens, so we are honest about it: Phase 1 and Phase 2 orders take 35 to 50 minutes. What does not change is how the food travels — boxed hot, sealed, in insulated bags.',
      'We cover both phases as one zone: the Korangi Road side, Amir Khusro Road, the Phase 2 commercial areas and Phase 2 Extension. If your street sits right on the boundary, send a WhatsApp and we will confirm before you order.',
    ],
    landmarks: [
      'Amir Khusro Road side',
      'Korangi Road stretch',
      'Phase 2 Commercial Area A & B',
      'Phase 2 Extension',
    ],
    popular: [
      { name: 'Deal-size pizza combos', blurb: 'Bigger orders make the longer ride worth it — deals are king here.' },
      { name: 'Double-smash burgers', blurb: 'Still hot after the ride — smashed patties hold their heat.' },
      { name: 'Loaded fries + shakes', blurb: 'The add-on pair on most Phase 1 & 2 orders.' },
    ],
    faqs: [
      {
        q: 'Why is the ETA longer for Phase 1 & 2?',
        a: 'Simple distance — you are the farthest DHA phases from our Phase 6 kitchen. We quote 35–50 minutes honestly rather than promising 30 and arriving late.',
      },
      {
        q: 'Do you deliver to Phase 2 Extension?',
        a: 'Yes, Phase 2 Ext is covered. For boundary streets near Korangi Road, drop us a WhatsApp first and we will confirm your address is in zone.',
      },
      {
        q: 'Is it still cash on delivery this far out?',
        a: 'Always — same as every zone. Pay the rider when the food arrives; the printed receipt is the bill.',
      },
    ],
    adjacent: ['dha-phase-4', 'gizri'],
  },
  {
    slug: 'clifton',
    name: 'Clifton',
    h1: 'Pizza & Burger Delivery in Clifton, Karachi',
    title: 'Pizza & Burger Delivery in Clifton, Karachi',
    description:
      'Cheese O’Clock delivers gourmet pizza & smash burgers to Clifton — Boat Basin, Schon Circle, Blocks 2–9 — in 35–50 min. Cash on delivery, open till 2am.',
    eta: { min: 35, max: 50 },
    intro: [
      'Clifton has no shortage of food streets — what it lacks at midnight is a kitchen still answering. We deliver across the Clifton blocks from our DHA Phase 6 kitchen until 2am, every day, cash on delivery.',
      'Coverage runs from the Boat Basin and Schon Circle side through Blocks 2, 4, 5, 7, 8 and 9. Sea View apartments and the blocks past Bilawal Chowrangi sit at the far edge of the window — we will always tell you the honest ETA when you order.',
    ],
    landmarks: [
      'Boat Basin',
      'Schon Circle',
      'Bilawal Chowrangi',
      'Clifton Block 2, 4, 5, 7, 8 & 9',
      'Sea View apartments side',
    ],
    popular: [
      { name: 'Late-night pizza deals', blurb: 'Clifton orders peak after 11pm — we are built for it.' },
      { name: 'Gourmet burger boxes', blurb: 'Burger + fries + drink, packed for the seaside breeze.' },
      { name: 'Extra-cheese everything', blurb: 'Clifton consistently out-cheeses every other zone. Respect.' },
    ],
    faqs: [
      {
        q: 'Which Clifton blocks do you deliver to?',
        a: 'Blocks 2, 4, 5, 7, 8 and 9, plus the Boat Basin and Schon Circle areas. If you are in Block 1 or right at the edge, WhatsApp us and we will confirm in a minute.',
      },
      {
        q: 'How long does delivery to Boat Basin take?',
        a: 'Around 35–45 minutes most evenings. After midnight the roads clear and Clifton deliveries often beat the quote.',
      },
      {
        q: 'Do you deliver to apartment towers?',
        a: 'Yes — most of our Clifton orders are towers. Add the tower name and apartment number in the notes; the rider calls from the lobby.',
      },
    ],
    adjacent: ['gizri', 'dha-phase-5'],
  },
  {
    slug: 'gizri',
    name: 'Gizri & Punjab Colony',
    h1: 'Fast Food Delivery in Gizri & Punjab Colony, Karachi',
    title: 'Fast Food Delivery in Gizri & Punjab Colony, Karachi',
    description:
      'Hot pizza, burgers & fries delivered to Gizri, Punjab Colony and Delhi Colony in 25–40 min from DHA Phase 6. Cash on delivery — order online or WhatsApp.',
    eta: { min: 25, max: 40 },
    intro: [
      'Gizri sits right between our kitchen and Clifton, which makes it one of our fastest zones outside DHA itself — most orders land in 25 to 40 minutes, straight down Gizri Boulevard.',
      'We deliver across Gizri, Punjab Colony and Delhi Colony. Order from the website or just WhatsApp your order and street — and pay the rider in cash when it arrives, no apps and no cards needed.',
    ],
    landmarks: [
      'Gizri Boulevard',
      'Punjab Colony',
      'Delhi Colony',
      'Ch. Khaliq-uz-Zaman Road side',
    ],
    popular: [
      { name: 'Crispy chicken burgers', blurb: 'The Gizri go-to — crunchy, saucy, generous.' },
      { name: 'Fries family packs', blurb: 'Big bags for big households; ask for extra masala.' },
      { name: 'Personal pizzas', blurb: 'One-person pies that beat the dhaaba queue.' },
    ],
    faqs: [
      {
        q: 'Do you deliver inside Punjab Colony lanes?',
        a: 'Yes — riders deliver to the main lanes; for the narrowest streets the rider may call you to meet at the lane entrance.',
      },
      {
        q: 'How fast is delivery to Gizri Boulevard?',
        a: 'Addresses on or just off the Boulevard usually see 25–35 minutes. Delhi Colony edges run slightly longer.',
      },
      {
        q: 'What if I do not have exact address details?',
        a: 'Share a nearby landmark in the notes (mosque, bakery, school) and keep your phone on — the rider will call as he enters the area.',
      },
    ],
    adjacent: ['dha-phase-5', 'clifton', 'dha-phase-4'],
  },
];

export function getArea(slug: string): DeliveryArea | undefined {
  return DELIVERY_AREAS.find((a) => a.slug === slug);
}

export function etaText(area: DeliveryArea): string {
  return `${area.eta.min}–${area.eta.max} min`;
}
