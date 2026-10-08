// Development only: fills a local dashboard with six weeks of MADE-UP shop
// days, sent the way a till sends them (POST /api/bridge/dashboard/push), and
// adds a test owner sign-in. Every name, item and amount here is invented.
//
//   SITE=http://localhost:3000 BRIDGE_SECRET=<the dev secret> node scripts/dev-dashboard-seed.mjs
//
// Prints the test sign-in at the end.
import { createHash, randomUUID } from 'node:crypto';

const SITE = process.env.SITE ?? 'http://localhost:3000';
// Never the real website: this makes up orders and an owner sign-in with a known password.
const HOST = new URL(SITE).hostname;
if (!['localhost', '127.0.0.1', '[::1]'].includes(HOST) && !HOST.endsWith('.localhost') && !HOST.endsWith('.test')) {
  throw new Error(`Development only: ${SITE} is not a local site`);
}
const SECRET = process.env.BRIDGE_SECRET;
if (!SECRET) throw new Error('Set BRIDGE_SECRET to the dev server’s secret');
const DAYS = Number(process.env.SEED_DAYS ?? 42);

// A small seeded random, so every run makes the same shop.
let s = 20261008;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((t, [, w]) => t + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
};

const R = (rupees) => Math.round(rupees * 100);
const CATS = [
  ['cat-sig', 'Test Signature Pizzas', 1],
  ['cat-reg', 'Test Regular Pizzas', 2],
  ['cat-bur', 'Test Burgers', 3],
  ['cat-side', 'Test Fries & Sides', 4],
  ['cat-deal', 'Test Value Deals', 5],
  ['cat-dip', 'Test Dips', 6],
  ['cat-drink', 'Test Drinks', 7],
  ['cat-fee', 'Delivery Charges', 9],
];
const ITEMS = [
  ['it-1', 'cat-sig', 'Test Star Crust — Large', 2200, 690],
  ['it-2', 'cat-sig', 'Test Crown Crust — Large', 2200, 720],
  ['it-3', 'cat-sig', 'Test Meat Feast — Large', 2200, 760],
  ['it-4', 'cat-reg', 'Test Fajita — Medium', 1500, 420],
  ['it-5', 'cat-reg', 'Test Fajita — Large', 2000, 610],
  ['it-6', 'cat-reg', 'Test Tikka — Medium', 1500, 430],
  ['it-7', 'cat-reg', 'Test Tikka — Large', 2000, 600],
  ['it-8', 'cat-reg', 'Test Veggie — Large', 2000, 520],
  ['it-9', 'cat-bur', 'Test Crispy Burger', 800, 260],
  ['it-10', 'cat-bur', 'Test Hot Burger', 950, 300],
  ['it-11', 'cat-side', 'Test Fries — Large', 450, 110],
  ['it-12', 'cat-side', 'Test Masala Fries — Large', 480, 120],
  ['it-13', 'cat-side', 'Test Nuggets', 670, 230],
  ['it-14', 'cat-deal', 'Test Big Two', 3600, 1300],
  ['it-15', 'cat-deal', 'Test Family Feast', 3100, 1050],
  ['it-16', 'cat-dip', 'Test Ranch Dip', 100, 25],
  ['it-17', 'cat-drink', 'Test Soft Drink — 1 litre', 250, 155],
];
const FEES = [['it-fee-200', 'Delivery Charge (test 200)', 200], ['it-fee-250', 'Delivery Charge (test 250)', 250]];
const AREAS = ['Test Phase 2', 'Test Phase 4', 'Test Phase 5', 'Test Phase 6', 'Test Phase 7', 'Test Clifton 4', 'Test Clifton 5'];
const PEOPLE = ['Test Ayesha', 'Test Bilal', 'Test Danish', 'Test Fatima', 'Test Hamza', 'Test Iqra', 'Test Kamran', 'Test Mehwish', 'Test Omer', 'Test Sana'];
const CASHIERS = ['Test Cashier A', 'Test Cashier B'];
const MANAGER = 'Test Manager';
const RIDERS = ['Test Rider One', 'Test Rider Two'];

const TILLS = [
  { deviceId: 'dev-till-counter', deviceName: 'Test Counter Till', share: 0.8 },
  { deviceId: 'dev-till-back', deviceName: 'Test Back Till', share: 0.2 },
];

const dayMs = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const dayStart = (d) => Date.parse(`${d}T00:00:00.000Z`);
const addDays = (d, n) => new Date(dayStart(d) + n * dayMs).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();

function makeOrder(till, day, idx, shiftId, nowMs) {
  // Karachi 1 pm – 1 am = UTC 08:00 – 20:00; busiest 8–11 pm.
  const hourUtc = weighted([[8, 2], [9, 3], [10, 3], [11, 2], [12, 2], [13, 3], [14, 5], [15, 8], [16, 10], [17, 9], [18, 7], [19, 4]]);
  const createdMs = dayStart(day) + hourUtc * 3_600_000 + Math.floor(rnd() * 3_600_000);
  if (createdMs > nowMs) return null;
  const channel = weighted([['takeaway', 33], ['delivery', 30], ['web_delivery', 14], ['web_pickup', 6], ['foodpanda', 17]]);
  const mode = channel === 'foodpanda' ? 'foodpanda' : channel === 'takeaway' || channel === 'web_pickup' ? 'takeaway' : 'delivery';
  const source = channel.startsWith('web_') ? 'web' : 'pos';
  const lines = [];
  const n = weighted([[1, 40], [2, 35], [3, 18], [4, 7]]);
  for (let i = 0; i < n; i++) {
    const it = weighted(ITEMS.map((x, k) => [x, [8, 6, 5, 9, 12, 7, 9, 4, 8, 6, 9, 5, 4, 5, 3, 6, 6][k]]));
    const qty = rnd() < 0.15 ? 2 : 1;
    const choices = it[1] === 'cat-reg' && rnd() < 0.3 ? [{ name: 'No onion', priceDeltaCents: 0 }] : it[1] === 'cat-bur' && rnd() < 0.25 ? [{ name: 'Add cheese', priceDeltaCents: R(100) }] : [];
    const unit = R(it[3]) + choices.reduce((t, c) => t + c.priceDeltaCents, 0);
    lines.push({ id: randomUUID(), name: it[2], category: CATS.find((c) => c[0] === it[1])[1], menuItemId: it[0], qty, unitPriceCents: unit, lineTotalCents: unit * qty, choices, note: null, isFee: false, costCents: R(it[4]) * qty });
  }
  let area = null;
  if (mode === 'delivery') {
    area = pick(AREAS);
    const fee = area.includes('Clifton') ? FEES[1] : FEES[0];
    lines.push({ id: randomUUID(), name: fee[1], category: 'Delivery Charges', menuItemId: fee[0], qty: 1, unitPriceCents: R(fee[2]), lineTotalCents: R(fee[2]), choices: [], note: null, isFee: true, costCents: null });
  }
  const subtotal = lines.reduce((t, l) => t + l.lineTotalCents, 0);
  const food = lines.filter((l) => !l.isFee).reduce((t, l) => t + l.lineTotalCents, 0);
  const discount = channel === 'web_pickup' ? Math.round(food * 0.1) : rnd() < 0.06 ? Math.round(food * 0.1) : 0;
  const tax = Math.round((subtotal - discount) * 0.15);
  const total = subtotal - discount + tax;
  const fate = weighted([['paid', 93], ['void', 3], ['refund_part', 2], ['refund_full', 1], ['test', 1]]);
  const paidMs = createdMs + (5 + Math.floor(rnd() * 40)) * 60_000;
  const method = channel === 'foodpanda' ? 'foodpanda' : weighted([['cash', 64], ['card', 18], ['easypaisa', 9], ['jazzcash', 6], ['bank_transfer', 3]]);
  const live = day === today && nowMs - createdMs < 50 * 60_000;
  let status = 'paid';
  let paidAt = iso(Math.min(paidMs, nowMs));
  let payments = [{ id: randomUUID(), method, amountCents: total, tenderedCents: method === 'cash' ? Math.ceil(total / 50000) * 50000 : null, at: paidAt, by: pick(CASHIERS), shiftId }];
  let refunded = 0;
  if (live) {
    status = weighted([['sent_to_kitchen', 2], ['preparing', 3], ['ready', 2], [mode === 'delivery' ? 'out_for_delivery' : 'ready', 2]]);
    if (rnd() < 0.5) {
      paidAt = null;
      payments = [];
    }
  } else if (fate === 'void') {
    status = 'void';
    paidAt = null;
    payments = [];
  } else if (fate === 'refund_part') {
    refunded = Math.round(total * 0.2);
    payments.push({ id: randomUUID(), method, amountCents: -refunded, tenderedCents: null, at: iso(paidMs + 600_000), by: MANAGER, shiftId });
  } else if (fate === 'refund_full') {
    status = 'refunded';
    refunded = total;
    payments.push({ id: randomUUID(), method, amountCents: -total, tenderedCents: null, at: iso(paidMs + 600_000), by: MANAGER, shiftId });
  }
  const deleted = fate === 'test' && !live ? 'test' : null;
  const counted = deleted === null && paidAt !== null && status !== 'void' && status !== 'refunded';
  const number = `${day.replaceAll('-', '')}-${String(idx).padStart(4, '0')}`;
  const cameBy = source === 'web' ? 'website' : mode === 'foodpanda' ? 'foodpanda' : mode === 'delivery' ? weighted([['phone', 55], ['whatsapp', 45]]) : rnd() < 0.85 ? 'walk_in' : null;
  return {
    id: randomUUID(),
    deviceId: till.deviceId,
    number,
    status,
    mode,
    source,
    channel,
    cameBy,
    createdAt: iso(createdMs),
    sentAt: iso(createdMs + 60_000),
    paidAt,
    dispatchedAt: mode === 'delivery' && status !== 'void' && !live ? iso(createdMs + 25 * 60_000) : null,
    deliveredAt: mode === 'delivery' && status === 'paid' ? iso(createdMs + 45 * 60_000) : null,
    voidedAt: status === 'void' ? iso(createdMs + 10 * 60_000) : null,
    docUpdatedAt: iso(Math.min(Math.max(createdMs, paidMs + 600_000), nowMs)),
    tradingDay: day,
    hour: (hourUtc + 5) % 24,
    counted,
    deleted,
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: total,
    refundedCents: refunded,
    netCents: total - refunded,
    digitalTotalCents: null,
    riderKeepsCents: mode === 'delivery' && rnd() < 0.3 ? lines.find((l) => l.isFee)?.lineTotalCents ?? null : null,
    customer: mode === 'takeaway' && source === 'pos' && rnd() < 0.6 ? null : { name: pick(PEOPLE), phone: `+92300${String(1000000 + Math.floor(rnd() * 8999999))}`, address: mode === 'delivery' ? `House ${10 + Math.floor(rnd() * 90)}, Test Street ${1 + Math.floor(rnd() * 30)}` : null, area },
    notes: rnd() < 0.08 ? 'Extra napkins please' : null,
    cashier: source === 'web' ? null : pick(CASHIERS),
    rider: mode === 'delivery' && status !== 'void' ? pick(RIDERS) : null,
    voidedBy: status === 'void' ? MANAGER : null,
    voidReason: status === 'void' ? pick(['Customer cancelled', 'Wrong order punched', 'Took too long']) : null,
    deletedBy: deleted ? 'Test Owner' : null,
    deleteReason: deleted ? 'Training order' : null,
    shiftId,
    lines,
    payments,
    discounts: discount > 0 ? [{ kind: 'percent', value: 10, amountCents: discount, reason: source === 'web' ? 'Website pick-up 10% off' : 'Regular customer', source: null, by: source === 'web' ? null : pick(CASHIERS), approvedBy: null, at: iso(createdMs) }] : [],
    foodpanda: mode === 'foodpanda' && counted ? { commissionCents: Math.round((subtotal - discount) * 0.21), expectedPayoutCents: total - Math.round((subtotal - discount) * 0.21 * 1.15), dealLabel: null } : null,
  };
}

async function api(path, body) {
  const res = await fetch(`${SITE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', origin: SITE, 'sec-fetch-site': 'same-origin' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const nowMs = Date.now();
for (const till of TILLS) {
  const orders = [];
  const shifts = [];
  const cashMoves = [];
  const drawerOpens = [];
  const stockMoves = [];
  const days = [];
  let openShift = null;
  for (let k = DAYS - 1; k >= 0; k--) {
    const day = addDays(today, -k);
    const shiftId = randomUUID();
    const openedMs = dayStart(day) + 7.8 * 3_600_000;
    if (openedMs > nowMs) continue;
    const count = Math.round((25 + rnd() * 30 + ([5, 6].includes(new Date(dayStart(day)).getUTCDay()) ? 15 : 0)) * till.share);
    const dayOrders = [];
    for (let i = 1; i <= count; i++) {
      const o = makeOrder(till, day, i, shiftId, nowMs);
      if (o) dayOrders.push(o);
    }
    orders.push(...dayOrders);
    const counted = dayOrders.filter((o) => o.counted);
    const cashSales = dayOrders.flatMap((o) => o.payments).filter((p) => p.method === 'cash' && p.amountCents > 0).reduce((t, p) => t + p.amountCents, 0);
    const cashRefunds = dayOrders.flatMap((o) => o.payments).filter((p) => p.method === 'cash' && p.amountCents < 0).reduce((t, p) => t - p.amountCents, 0);
    const moves = [];
    if (rnd() < 0.7) moves.push({ type: 'payout', amountCents: R(800 + Math.floor(rnd() * 12) * 100), reason: pick(['Vegetables from market', 'Gas cylinder', 'Ice', 'Cleaning supplies']), purchase: rnd() < 0.5 });
    if (rnd() < 0.3) moves.push({ type: 'payin', amountCents: R(2000), reason: 'Change from bank' });
    if (rnd() < 0.4) moves.push({ type: 'payout', amountCents: R(200), reason: 'Outside rider kept the delivery charge' });
    const cashIn = moves.filter((m) => m.type === 'payin').reduce((t, m) => t + m.amountCents, 0);
    const cashOut = moves.filter((m) => m.type !== 'payin').reduce((t, m) => t + m.amountCents, 0);
    for (const m of moves) {
      const at = iso(openedMs + (2 + rnd() * 9) * 3_600_000);
      cashMoves.push({ id: randomUUID(), shiftId, deviceId: till.deviceId, type: m.type, amountCents: m.amountCents, reason: m.reason, by: pick(CASHIERS), approvedBy: MANAGER, orderId: null, purchase: m.purchase ?? false, createdAt: at, deleted: false, updatedAt: at });
    }
    if (rnd() < 0.5) {
      const at = iso(openedMs + (3 + rnd() * 8) * 3_600_000);
      drawerOpens.push({ id: randomUUID(), shiftId, deviceId: till.deviceId, kind: 'no_sale', reason: pick(['Change for a customer', 'Checked the float']), by: pick(CASHIERS), approvedBy: MANAGER, orderId: null, amountCents: null, outcome: 'opened', createdAt: at, updatedAt: at });
    }
    const float = R(5000);
    const expected = float + cashSales - cashRefunds + cashIn - cashOut;
    const isToday = day === today;
    const closedMs = dayStart(day) + 20.2 * 3_600_000;
    if (isToday && closedMs > nowMs) {
      openShift = { id: shiftId, openedAt: iso(openedMs), openedBy: pick(CASHIERS), openingCashCents: float, cashSalesCents: cashSales, cashRefundsCents: cashRefunds, cashInCents: cashIn, cashOutCents: cashOut, expectedCashCents: expected };
      shifts.push({ id: shiftId, deviceId: till.deviceId, openedAt: iso(openedMs), openedBy: openShift.openedBy, openingCashCents: float, closedAt: null, closedBy: null, expectedCashCents: null, countedCashCents: null, varianceCents: null, openNote: null, closeNote: null, carriedUnpaidCount: 0, carryOverReason: null, countedNotes: null, closeReport: null, updatedAt: iso(openedMs) });
    } else {
      const variance = weighted([[0, 70], [R(-50), 8], [R(100), 6], [R(-300), 5], [R(-1000), 2], [R(20), 9]]);
      shifts.push({
        id: shiftId,
        deviceId: till.deviceId,
        openedAt: iso(openedMs),
        openedBy: pick(CASHIERS),
        openingCashCents: float,
        closedAt: iso(closedMs),
        closedBy: MANAGER,
        expectedCashCents: expected,
        countedCashCents: expected + variance,
        varianceCents: variance,
        openNote: null,
        closeNote: variance < R(-200) ? 'Short — checked twice' : null,
        carriedUnpaidCount: 0,
        carryOverReason: null,
        countedNotes: null,
        closeReport: {
          v: 1,
          sales: { orderCount: counted.length, netCents: counted.reduce((t, o) => t + o.netCents, 0), taxCents: counted.reduce((t, o) => t + o.taxCents, 0) },
          drawer: { openingCents: float, cashSalesCents: cashSales, cashRefundsCents: cashRefunds, expectedCents: expected, countedCents: expected + variance, varianceCents: variance },
        },
        updatedAt: iso(closedMs),
      });
    }
    // The day's food cost, waste and profit, roughly as a till would work them out.
    const foodSales = counted.reduce((t, o) => t + Math.round((o.lines.filter((l) => !l.isFee).reduce((a, l) => a + l.lineTotalCents, 0) - o.discountCents) * (1 - o.refundedCents / Math.max(1, o.totalCents))), 0);
    const feeSales = counted.reduce((t, o) => t + o.lines.filter((l) => l.isFee).reduce((a, l) => a + l.lineTotalCents, 0), 0);
    const cost = counted.reduce((t, o) => t + o.lines.reduce((a, l) => a + (l.costCents ?? 0), 0), 0);
    const waste = R(100 + Math.floor(rnd() * 600));
    const commission = counted.reduce((t, o) => t + (o.foodpanda?.commissionCents ?? 0), 0);
    const riderCost = counted.filter((o) => o.mode === 'delivery').length * R(120);
    const fees = Math.round(counted.flatMap((o) => o.payments).filter((p) => p.method === 'card').reduce((t, p) => t + p.amountCents, 0) * 0.025);
    days.push({
      day,
      shopWide: false,
      food: { foodSalesCents: foodSales, feeSalesCents: feeSales, costOfSalesCents: cost, knownSalesCents: Math.round(foodSales * 0.94), knownCostCents: Math.round(cost * 0.94), knownMenuSalesCents: Math.round(foodSales * 0.97), estimatedOrders: 0, estimatedCostCents: 0, missingSalesCents: Math.round(foodSales * 0.06), wasteCents: waste, cancelledWasteCents: Math.round(waste / 3), wasteByReason: [{ reason: 'expired', times: 1, cents: Math.round(waste * 0.6) }, { reason: 'dropped', times: 1, cents: waste - Math.round(waste * 0.6) }] },
      profit: { profitCents: foodSales + feeSales - cost - commission - riderCost - fees - waste, steps: [{ key: 'sales', cents: foodSales + feeSales }, { key: 'food_cost', cents: -cost }, { key: 'waste', cents: -waste }, { key: 'commission', cents: -commission }, { key: 'payment_fees', cents: -fees }, { key: 'rider', cents: -riderCost }], unknownSalesCents: Math.round(foodSales * 0.06), estimatedOrders: 0 },
      purchasesCents: R(3000 + Math.floor(rnd() * 5000)),
      workedOutAt: iso(Math.min(nowMs, closedMs)),
    });
    // Stock in and out.
    if (rnd() < 0.4) {
      const at = iso(openedMs + 3_600_000);
      stockMoves.push({ id: randomUUID(), deviceId: till.deviceId, ingredientId: 'ing-1', ingredient: 'Test Cheese Mix', delta: 6000, unit: 'g', reason: 'delivery', detail: null, valueCents: R(9000), orderId: null, note: 'Weekly cheese', by: MANAGER, at, deleted: false, updatedAt: at });
    }
    if (rnd() < 0.5) {
      const at = iso(openedMs + 9 * 3_600_000);
      stockMoves.push({ id: randomUUID(), deviceId: till.deviceId, ingredientId: 'ing-3', ingredient: 'Test Pizza Dough', delta: -(300 + Math.floor(rnd() * 900)), unit: 'g', reason: 'waste', detail: 'waste:expired', valueCents: -R(80 + Math.floor(rnd() * 200)), orderId: null, note: null, by: pick(CASHIERS), at, deleted: false, updatedAt: at });
    }
  }
  const stock = [
    ['ing-1', 'Test Cheese Mix', 'g', 'Fridge', 4200, 3000, 1500_00],
    ['ing-2', 'Test Chicken Fajita', 'g', 'Fridge', 1800, 2500, 1100_00],
    ['ing-3', 'Test Pizza Dough', 'g', 'Fridge', 9000, 4000, 9_00],
    ['ing-4', 'Test Tomato Sauce', 'g', 'Fridge', 2600, 1000, 100_00],
    ['ing-5', 'Test Burger Bun', 'pcs', 'Dry store', 14, 20, 3500_00],
    ['ing-6', 'Test Fries', 'g', 'Freezer', 0, 5000, 70_00],
    ['ing-7', 'Test Ranch', 'g', 'Fridge', 900, 500, 220_00],
    ['ing-8', 'Test Soft Drink 1 Litre', 'pcs', 'Drinks', 36, 24, 15500_00],
    ['ing-9', 'Test Olives', 'g', 'Dry store', 1250, 300, 540_00],
    ['ing-10', 'Test Pizza Box Large', 'pcs', 'Packaging', 120, 80, 5300_00],
  ].map(([id, name, unit, category, onHand, lowAt, price]) => ({ id, name, unit, category, onHand, lowAt, pricePerThousandCents: price, priceKind: 'set', keyItem: ['ing-1', 'ing-2', 'ing-6'].includes(id), batch: id === 'ing-4', active: true }));
  const menu = {
    categories: CATS.map(([id, name, displayOrder]) => ({ id, name, displayOrder, active: true, onWebsite: id !== 'cat-fee' })),
    items: [
      ...ITEMS.map(([id, categoryId, name, price, cost], i) => ({ id, categoryId, name, priceCents: R(price), active: true, web: id === 'it-13' ? 'pickup_only' : id === 'it-3' ? 'off' : 'on', taxRateBps: 1500, sortOrder: i, costCents: R(cost) })),
      ...FEES.map(([id, name, price], i) => ({ id, categoryId: 'cat-fee', name, priceCents: R(price), active: true, web: 'on', taxRateBps: 1500, sortOrder: 100 + i, costCents: null })),
    ],
    updatedAt: iso(nowMs - 3 * dayMs),
  };
  const live = {
    shift: openShift,
    board: { kitchen: orders.filter((o) => ['sent_to_kitchen', 'preparing'].includes(o.status)).length, ready: orders.filter((o) => o.status === 'ready').length, out: orders.filter((o) => o.status === 'out_for_delivery').length, unpaidHandedOver: 0, oldestWaitingSince: orders.filter((o) => ['sent_to_kitchen', 'preparing', 'ready'].includes(o.status)).map((o) => o.createdAt).sort()[0] ?? null },
    web: { linked: true, ordersOn: true, accepting: openShift !== null, pausedByShift: openShift === null },
    notPrinted: 0,
    lowStock: stock.filter((x) => x.lowAt !== null && x.onHand <= x.lowAt).length,
  };
  const till_ = { deviceId: till.deviceId, deviceName: till.deviceName, appVersion: '0.7.40', sentAt: iso(nowMs) };
  const cursors = { orders: iso(nowMs), shifts: iso(nowMs), cashMoves: iso(nowMs), drawerOpens: iso(nowMs), stockMoves: iso(nowMs), menu: menu.updatedAt };
  for (let i = 0; i < orders.length; i += 200) {
    const last = i + 200 >= orders.length;
    await api('/api/bridge/dashboard/push', { v: 1, till: till_, live, orders: orders.slice(i, i + 200), cursors, caughtUp: false });
    if (last) break;
  }
  const r = await api('/api/bridge/dashboard/push', { v: 1, till: till_, live, shifts, cashMoves, drawerOpens, stockMoves, stock, menu, days, cursors, caughtUp: true });
  console.log(till.deviceName, orders.length, 'orders', JSON.stringify(r.data.stored));
}

// A test owner and a test manager, set up with their own passwords.
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const code = () => Array.from({ length: 12 }, () => ALPHA[Math.floor(rnd() * 32)]).join('');
const people = [
  { username: 'testowner', displayName: 'Test Owner', role: 'owner', seesReports: true, password: 'owner-pass-123' },
  { username: 'testmanager', displayName: 'Test Manager', role: 'manager', seesReports: false, password: 'manager-pass-123' },
];
for (const p of people) {
  const c = code();
  const list = await api('/api/bridge/dashboard/logins', undefined);
  if (list.data.logins.some((l) => l.username === p.username)) continue;
  await api('/api/bridge/dashboard/logins', { change: { action: 'add', username: p.username, displayName: p.displayName, role: p.role, seesReports: p.seesReports, setupCodeHash: createHash('sha256').update(c).digest('hex') }, deviceId: 'dev-till-counter', deviceName: 'Test Counter Till', appVersion: '0.7.40', actorName: 'Test Owner' });
  const res = await fetch(`${SITE}/dashboard/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ username: p.username, code: c, password: p.password }) });
  console.log('sign-in', p.username, '/', p.password, res.status);
}
