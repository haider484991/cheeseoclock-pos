/**
 * The sample night (test fixture, never imported by the app): the busy
 * evening shift of the shift report's corrected sample paper (the owner was
 * sent it on 2 Oct 2026), written as the facts the till reads at the close
 * (ShiftReportFacts). One till, opened 16:02 and closed 01:48 Pakistan time:
 * 62 orders paid, two cancelled, one refunded in full, two carried over
 * unpaid, the drawer counted by note and Rs 100 short.
 *
 * The menu's names, categories and prices are the shop's own (its menu is
 * public on the website). Every staff name, id, time, order and amount
 * beyond that is made up. There is no dine-in: the till no longer sells it.
 *
 * Every figure of the sample paper comes out of these orders — SALES, BY
 * CHANNEL, the money of each method, the drawer and ITEMS SOLD (the item
 * counts are the sample's, so items add up to Food). Two of the three typed
 * staff discounts carry paisa (Rs 549.13 and Rs 545.87): with the tax
 * rounded on each order, that is what lands Takeaway on 94,370.00 and the
 * own riders' deliveries on 29,600.00, as the sample prints them. The ORDERS
 * list's first rows are the sample's (#0001 to #0008), except that #0007 is
 * not refunded: the night's one refund is #0033, as the sample's CANCELLED
 * AND REFUNDED block says.
 *
 * Money in cents. Times are written as Pakistan wall-clock times and stored
 * as ISO UTC, as the till stores them.
 */
import type { OrderStatus, ReportChannel, ShiftReportDiscountKind } from '@cheeseoclock/shared-types';
import type {
  ShiftReportFacts,
  ShiftReportFactsLine,
  ShiftReportFactsOrder,
  ShiftReportFactsPayment,
  ShiftReportFactsRefund,
} from './shift-report.js';

/** The menu's categories in its own order: the place is the rank. */
export const SAMPLE_NIGHT_CATEGORIES = ['Signature Pizzas', 'Pizza', 'Burgers', 'Fries & Sides', 'Dips', 'Value Deals', 'Drinks'] as const;
type Category = (typeof SAMPLE_NIGHT_CATEGORIES)[number];

/** The items sold that night: [name on the menu, price, category]. The codes are this file's own. */
const MENU = {
  SHW: ['Shawarma Pizza — Large', 220_000, 'Signature Pizzas'],
  CRN: ['Crown Crust — Large', 220_000, 'Signature Pizzas'],
  STR: ['Cheesy Star — Large', 220_000, 'Signature Pizzas'],
  MTL: ['Meat Lovers — Large', 220_000, 'Signature Pizzas'],
  CHT: ['Cheetos — Large', 220_000, 'Signature Pizzas'],
  FJM: ['Fajita Pizza — Medium', 150_000, 'Pizza'],
  FJL: ['Fajita Pizza — Large', 200_000, 'Pizza'],
  CTL: ['Chicken Tikka Pizza — Large', 200_000, 'Pizza'],
  TML: ['Chicken Tikka Malai — Large', 200_000, 'Pizza'],
  MSM: ['Malai Supreme — Medium', 150_000, 'Pizza'],
  CSM: ['Cheesalious — Medium', 150_000, 'Pizza'],
  CPL: ['Classic Pepperoni — Large', 200_000, 'Pizza'],
  VLM: ['Veggie Lovers — Medium', 150_000, 'Pizza'],
  CSG: ['Crispy Signature', 80_000, 'Burgers'],
  NSH: ['Nashville Authentic (Hot)', 95_000, 'Burgers'],
  SCD: ['Signature Cheese Dipped', 90_000, 'Burgers'],
  CCC: ['Classic Crispy Chicken', 70_000, 'Burgers'],
  FRL: ['Fries — Large', 45_000, 'Fries & Sides'],
  SLF: ['Signature Loaded Fries', 70_000, 'Fries & Sides'],
  MMF: ['Signature Mayo Masala Fries — Large', 55_000, 'Fries & Sides'],
  NUG: ['Nuggets', 67_000, 'Fries & Sides'],
  BW: ['Baked Wings', 70_000, 'Fries & Sides'],
  ORD: ['Signature Orange Dip', 10_000, 'Dips'],
  GMD: ['Garlic Mayo Dip', 10_000, 'Dips'],
  RND: ['Ranch Dip', 10_000, 'Dips'],
  BIG: ['Big Two', 360_000, 'Value Deals'],
  PP: ['Perfect Pair', 260_000, 'Value Deals'],
  FF: ['Family Feast', 310_000, 'Value Deals'],
  SD3: ['Soft Drink — 345 ml', 12_000, 'Drinks'],
  SD1: ['Soft Drink — 1 litre', 25_000, 'Drinks'],
} as const satisfies Record<string, readonly [string, number, Category]>;
type Code = keyof typeof MENU;

/** The delivery charges (the area's charge, before tax). */
const RS_200 = 20_000;
const RS_250 = 25_000;

interface Off {
  kind: ShiftReportDiscountKind;
  cents: number;
}
/** foodpanda's deal on the order (Rs 540 off). */
const PANDA_DEAL: Off = { kind: 'foodpanda', cents: 54_000 };
/** The website's pick-up discount (10% of Rs 2,800). */
const PICKUP: Off = { kind: 'website', cents: 28_000 };
/** An automatic offer (10% of Rs 2,800). */
const OFFER: Off = { kind: 'offer', cents: 28_000 };
/** A staff discount typed by hand. */
const staff = (cents: number): Off => ({ kind: 'staff', cents });

/** The split payment's cash part: Rs 2,000 cash, the rest by card. */
const SPLIT_CASH = 200_000;

/**
 * How the order came: a counter takeaway, a phone delivery with the shop's
 * own rider, one sent out with an outside rider, a website pick-up or
 * delivery, a foodpanda order.
 */
type How = 'takeaway' | 'delivery' | 'outside' | 'web_pickup' | 'web_delivery' | 'foodpanda';
/**
 * How it was paid. 'easypaisa+cash' is an outside rider's EasyPaisa
 * settlement: the wallet for the order less his charge, his charge in cash
 * (paid out to him from the drawer). 'cash+card' is SPLIT_CASH in cash, the
 * rest by card.
 */
type Pay = 'cash' | 'card' | 'easypaisa' | 'jazzcash' | 'foodpanda' | 'easypaisa+cash' | 'cash+card';

interface NightOrder {
  n: number;
  paid: string;
  how: How;
  items: string;
  pay: Pay;
  charge: number;
  off: Off | null;
  status: OrderStatus | null;
}

/** One order: its number of the day, when it was paid (Pakistan time), how it came, its items ('2xSD3' = two), how it was paid. */
function o(
  n: number,
  paid: string,
  how: How,
  items: string,
  pay: Pay,
  more: { charge?: number; off?: Off; status?: OrderStatus } = {},
): NightOrder {
  return { n, paid, how, items, pay, charge: more.charge ?? 0, off: more.off ?? null, status: more.status ?? null };
}

/** A Pakistan wall-clock time of the night (16:02 on 1 Oct to 01:48 on 2 Oct) as stored: ISO UTC. */
export function sampleNightAt(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined || !Number.isInteger(h) || !Number.isInteger(m)) throw new Error(`Not a time: ${hhmm}`);
  // Pakistan is UTC+5 all year; the whole shift falls on 1 Oct in UTC.
  return new Date(Date.UTC(2026, 9, 1, (h + 24 - 5) % 24, m)).toISOString();
}

/** The order number the till gives the n-th order of the day. */
export function sampleNightOrderNumber(n: number): string {
  return `20261001-${String(n).padStart(4, '0')}`;
}

const NIGHT: readonly NightOrder[] = [
  o(1, '16:20', 'takeaway', 'SHW', 'cash'),
  o(2, '16:41', 'delivery', 'BIG', 'cash', { charge: RS_200 }),
  o(3, '17:05', 'foodpanda', 'PP 2xSD3', 'foodpanda', { off: PANDA_DEAL }),
  o(4, '17:22', 'takeaway', 'FJM', 'card'),
  o(5, '17:48', 'web_pickup', 'CTL CSG', 'cash', { off: PICKUP }),
  o(6, '18:02', 'outside', 'BIG', 'easypaisa+cash', { charge: RS_200 }),
  o(7, '18:15', 'takeaway', 'MSM', 'cash'),
  o(8, '18:31', 'takeaway', 'FF', 'jazzcash'),
  o(9, '18:44', 'takeaway', 'FF RND', 'card'),
  o(10, '18:52', 'foodpanda', 'SCD 2xFRL SLF NUG SD1', 'foodpanda', { off: PANDA_DEAL }),
  o(11, '19:03', 'takeaway', 'FJM', 'cash'),
  o(12, '19:20', 'delivery', 'CSG FRL', 'cash', { charge: RS_200 }),
  o(13, '19:12', 'takeaway', 'SHW ORD 2xSD1', 'card', { off: OFFER }),
  o(14, '19:41', 'outside', 'STR GMD', 'easypaisa+cash', { charge: RS_250 }),
  o(15, '19:26', 'takeaway', 'CHT RND SD3', 'card'),
  o(16, '19:34', 'takeaway', 'CRN', 'jazzcash'),
  o(17, '19:38', 'foodpanda', 'CSG NSH CCC SLF ORD', 'foodpanda', { off: PANDA_DEAL }),
  o(18, '19:50', 'takeaway', 'MSM CPL GMD SD3', 'cash', { off: staff(54_913) }),
  o(19, '20:15', 'delivery', 'SHW BIG SD3', 'cash', { charge: RS_200, off: staff(54_500) }),
  o(20, '20:02', 'takeaway', 'TML SD1', 'cash'),
  o(22, '20:20', 'takeaway', 'PP ORD', 'jazzcash'),
  o(23, '20:58', 'outside', 'CSG ORD GMD 2xRND', 'cash', { charge: RS_200 }),
  o(24, '20:31', 'foodpanda', 'SHW SCD CCC ORD GMD SD1', 'foodpanda', { off: PANDA_DEAL }),
  o(25, '20:39', 'takeaway', 'TML GMD SD1', 'card'),
  o(26, '20:47', 'takeaway', 'FF ORD SD1', 'cash'),
  o(27, '21:12', 'delivery', 'MTL RND', 'easypaisa', { charge: RS_200 }),
  o(28, '20:55', 'takeaway', 'CRN', 'card'),
  o(29, '21:20', 'web_delivery', 'CSM FRL 3xSD3', 'cash', { charge: RS_250 }),
  o(30, '21:05', 'takeaway', 'FJL ORD', 'card'),
  o(31, '21:40', 'outside', 'NSH MMF SD1', 'easypaisa+cash', { charge: RS_250 }),
  o(32, '21:18', 'foodpanda', 'SHW NSH GMD SD3', 'foodpanda', { off: PANDA_DEAL }),
  o(33, '21:31', 'takeaway', 'MSM', 'cash', { status: 'refunded' }),
  o(34, '21:36', 'takeaway', 'CTL', 'cash'),
  o(35, '22:02', 'delivery', 'NSH CCC 2xSD3', 'cash', { charge: RS_200 }),
  o(36, '21:47', 'takeaway', 'CPL CSG', 'card', { off: OFFER }),
  o(37, '21:55', 'takeaway', 'FJM SLF', 'card'),
  o(38, '22:00', 'foodpanda', 'BIG SLF ORD SD3', 'foodpanda', { off: PANDA_DEAL }),
  o(39, '22:09', 'takeaway', 'CRN NUG', 'cash'),
  o(40, '22:50', 'outside', 'MTL VLM MMF', 'cash', { charge: RS_200 }),
  o(41, '22:16', 'takeaway', 'FJM NUG ORD SD3', 'card'),
  o(42, '22:41', 'delivery', 'CRN', 'cash', { charge: RS_200 }),
  o(43, '22:24', 'takeaway', 'MSM', 'cash'),
  o(44, '22:31', 'takeaway', 'BIG CSG NSH GMD RND', 'card'),
  o(45, '22:50', 'outside', 'SHW', 'easypaisa+cash', { charge: RS_250 }),
  o(46, '22:44', 'foodpanda', 'CHT FRL ORD SD1', 'foodpanda', { off: PANDA_DEAL }),
  o(48, '22:58', 'takeaway', 'STR', 'cash'),
  o(49, '23:30', 'delivery', 'CRN ORD SD3', 'cash', { charge: RS_250 }),
  o(50, '23:07', 'takeaway', 'CTL SD3', 'cash'),
  o(51, '23:14', 'web_pickup', 'FJL CSG', 'cash', { off: PICKUP }),
  o(52, '23:19', 'takeaway', 'FJL CPL BW', 'cash'),
  o(53, '23:58', 'outside', 'FJL FRL', 'cash', { charge: RS_200 }),
  o(54, '23:26', 'foodpanda', 'CSM SCD FRL', 'foodpanda', { off: PANDA_DEAL }),
  o(55, '23:35', 'takeaway', 'FJM GMD', 'cash'),
  o(56, '00:12', 'delivery', 'STR SCD', 'cash', { charge: RS_250, off: staff(54_587) }),
  o(57, '23:46', 'takeaway', 'CTL ORD GMD 2xSD1', 'cash'),
  o(58, '23:52', 'takeaway', 'PP ORD', 'cash'),
  o(59, '00:31', 'outside', 'MTL FRL', 'easypaisa+cash', { charge: RS_250 }),
  o(60, '00:05', 'takeaway', 'CSM', 'cash'),
  o(61, '00:18', 'foodpanda', 'PP SLF MMF BW ORD SD1', 'foodpanda', { off: PANDA_DEAL }),
  o(62, '00:40', 'takeaway', 'STR SLF MMF', 'cash+card'),
  o(63, '01:08', 'delivery', 'SHW', 'cash', { charge: RS_250 }),
  o(65, '01:25', 'takeaway', 'SHW', 'cash'),
];

function linesOf(orderId: string, items: string): ShiftReportFactsLine[] {
  return items.split(' ').map((token) => {
    const x = token.indexOf('x');
    const quantity = x < 0 ? 1 : Number(token.slice(0, x));
    const code = x < 0 ? token : token.slice(x + 1);
    if (!(code in MENU) || !Number.isInteger(quantity) || quantity < 1) throw new Error(`Not an item: ${token}`);
    const [name, cents, category] = MENU[code as Code];
    return {
      orderId,
      menuItemId: `mi-${code.toLowerCase()}`,
      name,
      categoryName: category,
      categoryRank: SAMPLE_NIGHT_CATEGORIES.indexOf(category),
      quantity,
      lineTotalCents: quantity * cents,
      taxRateBps: 1500,
    };
  });
}

/** 15% of a whole number of cents, rounded half up, as the till rounds an order's tax. */
function taxOf(cents: number): number {
  return Math.floor((cents * 15 + 50) / 100);
}

const settled: ShiftReportFactsOrder[] = [];
const lines: ShiftReportFactsLine[] = [];
const payments: ShiftReportFactsPayment[] = [];
for (const r of NIGHT) {
  const number = String(r.n).padStart(4, '0');
  const id = `ord-${number}`;
  const orderLines = linesOf(id, r.items);
  const food = orderLines.reduce((a, l) => a + l.lineTotalCents, 0);
  const subtotal = food + r.charge;
  const discount = r.off?.cents ?? 0;
  const total = subtotal - discount + taxOf(subtotal - discount);
  const rows: Array<[string, number]> =
    r.pay === 'easypaisa+cash'
      ? [['easypaisa', total - r.charge], ['cash', r.charge]]
      : r.pay === 'cash+card'
        ? [['cash', SPLIT_CASH], ['card', total - SPLIT_CASH]]
        : [[r.pay, total]];
  const channel: ReportChannel = r.how === 'outside' ? 'delivery' : r.how;
  const delivered = channel === 'delivery' || channel === 'web_delivery';
  const status: OrderStatus = r.status ?? (delivered ? 'delivered' : 'paid');
  settled.push({
    id,
    orderNumber: sampleNightOrderNumber(r.n),
    channel,
    outside: r.how === 'outside',
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: total - (subtotal - discount),
    totalCents: total,
    deliveryChargeCents: r.charge,
    discountKind: r.off?.kind ?? null,
    paidAt: sampleNightAt(r.paid),
    status,
    methods: rows.map(([m]) => m),
    hasRefund: status === 'refunded',
  });
  lines.push(...orderLines);
  for (const [method, cents] of rows) payments.push({ orderId: id, method, cents });
}

/** The night's one refund: #0033 handed back in full, in cash, at 22:05. */
const REFUND: ShiftReportFactsRefund = {
  orderId: 'ord-0033',
  orderNumber: sampleNightOrderNumber(33),
  at: sampleNightAt('22:05'),
  method: 'cash',
  cents: 172_500,
  full: true,
  reason: 'Cold pizza',
};
payments.push({ orderId: REFUND.orderId, method: REFUND.method, cents: -REFUND.cents });

/** The sample night as the till reads it at the close: orders and lines in number order, payments as taken. */
export const SAMPLE_NIGHT: ShiftReportFacts = {
  shiftId: 'shift-sample-night',
  deviceId: 'till-sample-1',
  tillName: 'DESKTOP-7Q2M1KD',
  shopName: "Cheese O'Clock",
  openedAt: sampleNightAt('16:02'),
  closedAt: sampleNightAt('01:48'),
  openedBy: 'Ali Raza',
  closedBy: 'Imran Ali',
  pinOnLoginOf: 'Ali Raza',
  settled,
  lines,
  payments,
  refunds: [REFUND],
  cancelled: [
    { orderNumber: sampleNightOrderNumber(21), at: sampleNightAt('21:14'), cents: 207_000, made: 'made', reason: 'Customer left' },
    { orderNumber: sampleNightOrderNumber(47), at: sampleNightAt('23:40'), cents: 138_000, made: 'not_made', reason: 'Wrong item rung' },
  ],
  drawer: {
    openingCents: 500_000,
    cashSalesCents: 9_635_000,
    cashRefundsCents: 172_500,
    cashIn: { count: 1, cents: 200_000 },
    // Two payouts typed by hand (Rs 3,150) and three rider tips (Rs 600).
    payouts: { count: 2, cents: 315_000 },
    tips: { count: 3, cents: 60_000 },
    // The eight outside riders' charges: 4 x Rs 200 + 4 x Rs 250.
    riderKept: { count: 8, cents: 180_000, tripCount: 0 },
    // 5,000 + 96,350 − 1,725 + 2,000 − 3,750 − 1,800 = 96,075.00, counted 95,975.00.
    expectedCents: 9_607_500,
    countedCents: 9_597_500,
    varianceCents: -10_000,
    countedNotes: {
      notes: [
        { faceCents: 500_000, count: 12 },
        { faceCents: 100_000, count: 24 },
        { faceCents: 50_000, count: 15 },
        { faceCents: 10_000, count: 31 },
        { faceCents: 5_000, count: 14 },
        { faceCents: 2_000, count: 18 },
        { faceCents: 1_000, count: 23 },
      ],
      otherCents: 8_500,
    },
  },
  unpaid: {
    orders: [
      { orderNumber: sampleNightOrderNumber(64), createdAt: sampleNightAt('01:12'), totalCents: 247_000, takenBy: 'Ali Raza' },
      { orderNumber: sampleNightOrderNumber(66), createdAt: sampleNightAt('01:30'), totalCents: 159_000, takenBy: 'Website' },
    ],
    reason: 'Rider still out',
  },
};
