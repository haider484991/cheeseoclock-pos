-- 0057_price_includes_tax.sql
-- Prices that include their tax (the owner, 24 Oct 2026, the yellow deal
-- menu: "THE PRICE YOU SEE IS THE PRICE YOU PAY · TAX INCLUDED · delivery
-- charges not included"; the owner chose a mark per item over typing each
-- price ÷ 1.15). Every item before this one has its tax added on top, as
-- before; a marked item's price is the bill, however it is paid, and its tax
-- is the part of the price the rate makes up (15% of a cash Rs 4,800 is
-- Rs 626.09, 8% by card Rs 355.56).
--
--   menu_items.price_includes_tax   1 = the price includes the tax (the
--                                   owner's mark: Menu → Items, or a menu
--                                   file); 0 = added on top (every item now).
--   order_items.tax_included        the item's mark when the line was added,
--                                   a snapshot like unit_price_cents and
--                                   no_discount: 1 = the line adds no tax to
--                                   the bill and holds its tax inside. 0 on
--                                   every line sold before this version.
--   orders.included_tax_cents       the tax inside the order's tax-included
--                                   lines: worked at the cash rates with the
--                                   other totals, then as the payments settle
--                                   it. tax_cents stays the tax ADDED (so
--                                   total = subtotal − discount + tax still
--                                   holds); the order's whole tax is
--                                   tax_cents + included_tax_cents.
--   orders.digital_included_tax_cents  the part of it paid a way with a rate
--                                   of its own (card / wallet / bank), beside
--                                   digital_tax_cents, for Reports' card-rate
--                                   tax and the receipt's card part.
--
-- No backfill, no CHECK, no index: old rows read 0, so every stored total
-- and every report stays what it was. Row images are built from the live
-- schema, so the columns travel without a sync-core change.
ALTER TABLE menu_items ADD COLUMN price_includes_tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN tax_included INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN included_tax_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN digital_included_tax_cents INTEGER NOT NULL DEFAULT 0;
