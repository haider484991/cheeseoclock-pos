import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { normalizePhone } from '@/lib/format';
import { validateModifierSelection } from '@/lib/order-validation';
import { checkOrderRate, clientIpHash } from '@/lib/rate-limit';
import type { PublishedMenu, WebOrderItem } from '@cheeseoclock/shared-types';

export const dynamic = 'force-dynamic';

/**
 * Public: place a COD order.
 *
 * The client sends posItemId + modifier ids + quantities. We re-price
 * EVERYTHING server-side against the published menu — the client's totals
 * are display-only and never trusted. The POS will re-price again at import
 * (its DB is authoritative), so the worst a stale menu can cause is a small
 * estimate drift on the confirmation page, never a wrong charge: COD is
 * collected against the POS receipt.
 */

const OrderItemSchema = z.object({
  posItemId: z.string().min(1),
  quantity: z.number().int().min(1).max(50),
  modifierIds: z.array(z.string()).max(30).default([]),
  notes: z.string().max(300).optional(),
});

const PlaceOrderSchema = z.object({
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().min(7).max(20),
  addressLine: z.string().trim().min(5).max(300),
  area: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  items: z.array(OrderItemSchema).min(1).max(50),
  /** Honeypot — real users never fill this hidden field. */
  website: z.string().max(0).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const body: unknown = await req.json();
    const parsed = PlaceOrderSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'validation', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const phone = normalizePhone(input.customerPhone);
    if (!phone) {
      return Response.json(
        { ok: false, error: 'validation', details: { customerPhone: ['Enter a valid Pakistani mobile number'] } },
        { status: 400 },
      );
    }

    // Flood check before any real work. Fails open — see lib/rate-limit.
    const rate = await checkOrderRate(phone, clientIpHash(req));
    if (!rate.allowed) {
      return Response.json(
        {
          ok: false,
          error: 'rate_limited',
          message:
            'That is a lot of orders in a short window. Please wait a few minutes, or call us and we will take it over the phone.',
        },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } },
      );
    }

    // Load the published menu and re-price server-side.
    const menuRows = (await sql()`
      SELECT menu_json FROM site_menu WHERE id = 1
    `) as Array<{ menu_json: PublishedMenu }>;
    const menu = menuRows[0]?.menu_json;
    if (!menu) {
      return Response.json({ ok: false, error: 'menu_not_published' }, { status: 409 });
    }
    const itemIndex = new Map(
      menu.categories.flatMap((c) => c.items.map((i) => [i.posItemId, i] as const)),
    );

    let subtotalCents = 0;
    let taxCents = 0;
    const lines: WebOrderItem[] = [];
    for (const line of input.items) {
      const item = itemIndex.get(line.posItemId);
      if (!item) {
        return Response.json(
          { ok: false, error: 'item_not_on_menu', itemId: line.posItemId },
          { status: 409 },
        );
      }
      const groupError = validateModifierSelection(item, line.modifierIds);
      if (groupError) {
        return Response.json(
          { ok: false, error: 'invalid_modifiers', message: groupError },
          { status: 409 },
        );
      }
      const allMods = item.modifierGroups.flatMap((g) => g.modifiers);
      const modIndex = new Map(allMods.map((m) => [m.posModifierId, m] as const));
      const mods = [];
      let unit = item.basePriceCents;
      for (const modId of line.modifierIds) {
        const mod = modIndex.get(modId);
        if (!mod) {
          return Response.json(
            { ok: false, error: 'modifier_not_on_item', modifierId: modId },
            { status: 409 },
          );
        }
        unit += mod.priceDeltaCents;
        mods.push({
          posModifierId: mod.posModifierId,
          name: mod.name,
          priceDeltaCents: mod.priceDeltaCents,
        });
      }
      const lineTotal = unit * line.quantity;
      subtotalCents += lineTotal;
      // Exclusive tax estimate (mirrors the POS): line total × rate.
      taxCents += Math.round((lineTotal * item.taxRateBps) / 10_000);
      lines.push({
        posItemId: item.posItemId,
        name: item.name,
        quantity: line.quantity,
        unitPriceCents: unit,
        modifiers: mods,
        notes: line.notes?.trim() || null,
      });
    }
    const totalCents = subtotalCents + taxCents;

    const id = uuidv7();
    await sql()`
      INSERT INTO web_orders
        (id, status, customer_name, customer_phone, address_line, area, notes,
         items_json, subtotal_cents, tax_cents, total_cents, payment_method)
      VALUES
        (${id}, 'new', ${input.customerName.trim()}, ${phone},
         ${input.addressLine.trim()}, ${input.area?.trim() || null},
         ${input.notes?.trim() || null}, ${JSON.stringify(lines)},
         ${subtotalCents}, ${taxCents}, ${totalCents}, 'cod')
    `;

    return Response.json({
      ok: true,
      data: { orderId: id, subtotalCents, taxCents, totalCents },
    });
  } catch (e) {
    console.error('POST /api/orders failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
