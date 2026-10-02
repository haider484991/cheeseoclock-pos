/**
 * The sample night as a saved ShiftReport (test fixture, never imported by
 * the app): the busy evening shift of the shift report's sample paper (the
 * owner was sent it on 2 Oct 2026). One till, opened 16:02 and closed 01:48
 * Pakistan time: 62 orders paid, two cancelled, one refunded in full, two
 * carried over unpaid, the drawer counted by note and Rs 100 short.
 *
 * It is pos-domain's sample night (packages/pos-domain/src/
 * shift-report.fixture.ts SAMPLE_NIGHT) put through buildShiftReport, written
 * out here as static data: printer-core depends on shared-types only. Both
 * packages' tests pin the same fingerprint of its JSON
 * (SAMPLE_SHIFT_REPORT_FINGERPRINT), so the two cannot drift apart.
 *
 * Where it differs from the hand-made sample paper, it is the till that is
 * right:
 *  - MONEY TAKEN 'Cash (38)', not (32): an order counts under every method
 *    it was paid by, and the split cash + card order and the five outside
 *    riders' EasyPaisa + cash settlements each have a cash part;
 *  - the night's one refund is #0033 (as CANCELLED AND REFUNDED says), so
 *    the ORDERS list flags #0033, not #0007 as the ORDERS excerpt did;
 *  - item names carry the menu's '—', which prints '-'.
 *
 * The menu's names, categories and prices are the shop's own (its menu is
 * public on the website). Every staff name, id, time, order and amount
 * beyond that is made up. Money in cents; times stored as ISO UTC.
 */
import {
  SHIFT_REPORT_VERSION,
  type ReportChannel,
  type ShiftReport,
  type ShiftReportCategory,
  type ShiftReportOrder,
  type ShiftReportOrderRefunded,
} from '@cheeseoclock/shared-types';

/**
 * The fingerprint (escpos fingerprint() over the UTF-8 bytes) of
 * JSON.stringify(SAMPLE_SHIFT_REPORT), which is
 * shiftReportJson(buildShiftReport(SAMPLE_NIGHT)) in pos-domain. If the
 * builder's figures for the sample night change, both tests fail until this
 * file is written out again from the builder.
 */
export const SAMPLE_SHIFT_REPORT_FINGERPRINT = '15105:fb520c02:b4f549ec';

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

/**
 * Every order paid, in the order paid: number, when paid (Pakistan time),
 * channel, sent out with an outside rider, methods ('easypaisa+cash' = two),
 * total, refunded.
 */
const ORDERS: ReadonlyArray<readonly [number, string, ReportChannel, boolean, string, number, ShiftReportOrderRefunded]> = [
  [1, '16:20', 'takeaway', false, 'cash', 253_000, 'no'],
  [2, '16:41', 'delivery', false, 'cash', 437_000, 'no'],
  [3, '17:05', 'foodpanda', false, 'foodpanda', 264_500, 'no'],
  [4, '17:22', 'takeaway', false, 'card', 172_500, 'no'],
  [5, '17:48', 'web_pickup', false, 'cash', 289_800, 'no'],
  [6, '18:02', 'delivery', true, 'easypaisa+cash', 437_000, 'no'],
  [7, '18:15', 'takeaway', false, 'cash', 172_500, 'no'],
  [8, '18:31', 'takeaway', false, 'jazzcash', 356_500, 'no'],
  [9, '18:44', 'takeaway', false, 'card', 368_000, 'no'],
  [10, '18:52', 'foodpanda', false, 'foodpanda', 331_200, 'no'],
  [11, '19:03', 'takeaway', false, 'cash', 172_500, 'no'],
  [13, '19:12', 'takeaway', false, 'card', 289_800, 'no'],
  [12, '19:20', 'delivery', false, 'cash', 166_750, 'no'],
  [15, '19:26', 'takeaway', false, 'card', 278_300, 'no'],
  [16, '19:34', 'takeaway', false, 'jazzcash', 253_000, 'no'],
  [17, '19:38', 'foodpanda', false, 'foodpanda', 311_650, 'no'],
  [14, '19:41', 'delivery', true, 'easypaisa+cash', 293_250, 'no'],
  [18, '19:50', 'takeaway', false, 'cash', 364_650, 'no'],
  [20, '20:02', 'takeaway', false, 'cash', 258_750, 'no'],
  [19, '20:15', 'delivery', false, 'cash', 641_125, 'no'],
  [22, '20:20', 'takeaway', false, 'jazzcash', 310_500, 'no'],
  [24, '20:31', 'foodpanda', false, 'foodpanda', 426_650, 'no'],
  [25, '20:39', 'takeaway', false, 'card', 270_250, 'no'],
  [26, '20:47', 'takeaway', false, 'cash', 396_750, 'no'],
  [28, '20:55', 'takeaway', false, 'card', 253_000, 'no'],
  [23, '20:58', 'delivery', true, 'cash', 161_000, 'no'],
  [30, '21:05', 'takeaway', false, 'card', 241_500, 'no'],
  [27, '21:12', 'delivery', false, 'easypaisa', 287_500, 'no'],
  [32, '21:18', 'foodpanda', false, 'foodpanda', 325_450, 'no'],
  [29, '21:20', 'web_delivery', false, 'cash', 294_400, 'no'],
  [33, '21:31', 'takeaway', false, 'cash', 172_500, 'full'],
  [34, '21:36', 'takeaway', false, 'cash', 230_000, 'no'],
  [31, '21:40', 'delivery', true, 'easypaisa+cash', 230_000, 'no'],
  [36, '21:47', 'takeaway', false, 'card', 289_800, 'no'],
  [37, '21:55', 'takeaway', false, 'card', 253_000, 'no'],
  [38, '22:00', 'foodpanda', false, 'foodpanda', 457_700, 'no'],
  [35, '22:02', 'delivery', false, 'cash', 240_350, 'no'],
  [39, '22:09', 'takeaway', false, 'cash', 330_050, 'no'],
  [41, '22:16', 'takeaway', false, 'card', 274_850, 'no'],
  [43, '22:24', 'takeaway', false, 'cash', 172_500, 'no'],
  [44, '22:31', 'takeaway', false, 'card', 638_250, 'no'],
  [42, '22:41', 'delivery', false, 'cash', 276_000, 'no'],
  [46, '22:44', 'foodpanda', false, 'foodpanda', 282_900, 'no'],
  [40, '22:50', 'delivery', true, 'cash', 511_750, 'no'],
  [45, '22:50', 'delivery', true, 'easypaisa+cash', 281_750, 'no'],
  [48, '22:58', 'takeaway', false, 'cash', 253_000, 'no'],
  [50, '23:07', 'takeaway', false, 'cash', 243_800, 'no'],
  [51, '23:14', 'web_pickup', false, 'cash', 289_800, 'no'],
  [52, '23:19', 'takeaway', false, 'cash', 540_500, 'no'],
  [54, '23:26', 'foodpanda', false, 'foodpanda', 265_650, 'no'],
  [49, '23:30', 'delivery', false, 'cash', 307_050, 'no'],
  [55, '23:35', 'takeaway', false, 'cash', 184_000, 'no'],
  [57, '23:46', 'takeaway', false, 'cash', 310_500, 'no'],
  [58, '23:52', 'takeaway', false, 'cash', 310_500, 'no'],
  [53, '23:58', 'delivery', true, 'cash', 304_750, 'no'],
  [60, '00:05', 'takeaway', false, 'cash', 172_500, 'no'],
  [56, '00:12', 'delivery', false, 'cash', 322_475, 'no'],
  [61, '00:18', 'foodpanda', false, 'foodpanda', 501_400, 'no'],
  [59, '00:31', 'delivery', true, 'easypaisa+cash', 333_500, 'no'],
  [62, '00:40', 'takeaway', false, 'cash+card', 396_750, 'no'],
  [63, '01:08', 'delivery', false, 'cash', 281_750, 'no'],
  [65, '01:25', 'takeaway', false, 'cash', 253_000, 'no'],
];

/** ITEMS SOLD: the menu's categories in its own order, each item most sold first: [name, how many, cents]. */
const ITEMS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number, number]>]> = [
  ['Signature Pizzas', [
    ['Shawarma Pizza — Large', 8, 1_760_000],
    ['Crown Crust — Large', 5, 1_100_000],
    ['Cheesy Star — Large', 4, 880_000],
    ['Meat Lovers — Large', 3, 660_000],
    ['Cheetos — Large', 2, 440_000],
  ]],
  ['Pizza', [
    ['Fajita Pizza — Medium', 5, 750_000],
    ['Chicken Tikka Pizza — Large', 4, 800_000],
    ['Fajita Pizza — Large', 4, 800_000],
    ['Malai Supreme — Medium', 4, 600_000],
    ['Classic Pepperoni — Large', 3, 600_000],
    ['Cheesalious — Medium', 3, 450_000],
    ['Chicken Tikka Malai — Large', 2, 400_000],
    ['Veggie Lovers — Medium', 1, 150_000],
  ]],
  ['Burgers', [
    ['Crispy Signature', 7, 560_000],
    ['Nashville Authentic (Hot)', 5, 475_000],
    ['Signature Cheese Dipped', 4, 360_000],
    ['Classic Crispy Chicken', 3, 210_000],
  ]],
  ['Fries & Sides', [
    ['Fries — Large', 8, 360_000],
    ['Signature Loaded Fries', 6, 420_000],
    ['Signature Mayo Masala Fries — Large', 4, 220_000],
    ['Nuggets', 3, 201_000],
    ['Baked Wings', 2, 140_000],
  ]],
  ['Dips', [
    ['Signature Orange Dip', 14, 140_000],
    ['Garlic Mayo Dip', 9, 90_000],
    ['Ranch Dip', 6, 60_000],
  ]],
  ['Value Deals', [
    ['Big Two', 5, 1_800_000],
    ['Perfect Pair', 4, 1_040_000],
    ['Family Feast', 3, 930_000],
  ]],
  ['Drinks', [
    ['Soft Drink — 345 ml', 15, 180_000],
    ['Soft Drink — 1 litre', 12, 300_000],
  ]],
];

const categories: ShiftReportCategory[] = ITEMS.map(([category, items]) => ({
  category,
  quantity: items.reduce((a, [, q]) => a + q, 0),
  cents: items.reduce((a, [, , c]) => a + c, 0),
  items: items.map(([name, quantity, cents]) => ({ name, quantity, cents })),
}));

const orders: ShiftReportOrder[] = ORDERS.map(([n, paid, channel, outside, methods, totalCents, refunded]) => ({
  orderNumber: sampleNightOrderNumber(n),
  paidAt: sampleNightAt(paid),
  channel,
  outside,
  methods: methods.split('+'),
  totalCents,
  refunded,
}));

/** The sample night as saved at its close; the keys in the saved JSON's order. */
export const SAMPLE_SHIFT_REPORT: ShiftReport = {
  v: SHIFT_REPORT_VERSION,
  shiftId: 'shift-sample-night',
  deviceId: 'till-sample-1',
  tillName: 'DESKTOP-7Q2M1KD',
  shopName: "Cheese O'Clock",
  openedAt: sampleNightAt('16:02'),
  closedAt: sampleNightAt('01:48'),
  openedBy: 'Ali Raza',
  closedBy: 'Imran Ali',
  pinOnLoginOf: 'Ali Raza',
  sales: {
    orderCount: 62,
    foodCents: 16_876_000,
    delivery: { orderCount: 18, cents: 400_000 },
    discounts: [
      { kind: 'foodpanda', orderCount: 9, cents: 486_000 },
      { kind: 'staff', orderCount: 3, cents: 164_000 },
      { kind: 'website', orderCount: 2, cents: 56_000 },
      { kind: 'offer', orderCount: 2, cents: 56_000 },
    ],
    taxCents: 2_477_100,
    taxRateBps: 1500,
    billedCents: 18_991_100,
    refunds: { orderCount: 1, cents: 172_500 },
    netCents: 18_818_600,
    averageCents: 306_308,
  },
  payments: [
    { method: 'cash', orderCount: 38, cents: 9_635_000 },
    { method: 'card', orderCount: 12, cents: 3_526_000 },
    { method: 'easypaisa', orderCount: 6, cents: 1_743_000 },
    { method: 'jazzcash', orderCount: 3, cents: 920_000 },
    { method: 'foodpanda', orderCount: 9, cents: 3_167_100 },
  ],
  paymentRefunds: [{ method: 'cash', orderCount: 1, cents: 172_500 }],
  moneyTakenCents: 18_818_600,
  partPaymentsCents: 0,
  channels: [
    { channel: 'takeaway', orderCount: 33, billedCents: 9_437_000, outside: null },
    { channel: 'delivery', orderCount: 17, billedCents: 5_513_000, outside: { orderCount: 8, billedCents: 2_553_000 } },
    { channel: 'web_pickup', orderCount: 2, billedCents: 579_600, outside: null },
    { channel: 'web_delivery', orderCount: 1, billedCents: 294_400, outside: null },
    { channel: 'foodpanda', orderCount: 9, billedCents: 3_167_100, outside: null },
  ],
  cancelled: [
    { orderNumber: sampleNightOrderNumber(21), at: sampleNightAt('21:14'), cents: 207_000, made: 'made', reason: 'Customer left' },
    { orderNumber: sampleNightOrderNumber(47), at: sampleNightAt('23:40'), cents: 138_000, made: 'not_made', reason: 'Wrong item rung' },
  ],
  refunds: [
    { orderNumber: sampleNightOrderNumber(33), at: sampleNightAt('22:05'), method: 'cash', cents: 172_500, full: true, reason: 'Cold pizza' },
  ],
  drawer: {
    openingCents: 500_000,
    cashSalesCents: 9_635_000,
    cashRefundsCents: 172_500,
    cashIn: { count: 1, cents: 200_000 },
    // Two payouts typed by hand (Rs 3,150) and three rider tips (Rs 600).
    cashOut: { count: 5, cents: 375_000 },
    riderTips: { count: 3, cents: 60_000 },
    // The eight outside riders' charges: 4 x Rs 200 + 4 x Rs 250.
    riderKept: { count: 8, cents: 180_000, tripCount: 0 },
    otherCents: 0,
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
      { orderNumber: sampleNightOrderNumber(64), at: sampleNightAt('01:12'), takenBy: 'Ali Raza', cents: 247_000 },
      { orderNumber: sampleNightOrderNumber(66), at: sampleNightAt('01:30'), takenBy: 'Website', cents: 159_000 },
    ],
    reason: 'Rider still out',
  },
  items: categories,
  orders,
};
