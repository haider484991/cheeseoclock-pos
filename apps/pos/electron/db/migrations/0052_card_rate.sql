-- 0052_card_rate.sql
-- Tax by how the customer pays (the owner, 6 Oct 2026: "how to set the card
-- percentage and cash percentage thing"). Sindh charges a restaurant's bill
-- one rate when it is paid in cash and a lower one when it is paid by card,
-- wallet or bank transfer; the rates are the owner's to set, Menu -> Tax.
--
--   tax_categories.digital_rate_bps
--             the category's rate when the bill is paid by card, wallet or
--             bank transfer, in basis points (800 = 8%). NULL = the same as
--             rate_bps: no card rate, and nothing about the sale changes.
--   order_items.digital_rate_bps_snapshot
--             the line's card rate frozen when the line was added, exactly
--             like tax_rate_bps_snapshot. NULL = none: every line from
--             before 0052 reads exactly as before.
--   orders.digital_total_cents
--             the bill if paid entirely by card / wallet / bank: the same
--             lines, the same discount shares, taxed at their card rates;
--             stored with the other totals each time they are worked out.
--             NULL = no card rate on this order (the total is the total).
--   orders.digital_net_cents, orders.digital_tax_cents
--             written by the sale: the part of the bill before tax that was
--             paid by card / wallet / bank, and the tax on that part
--             (pos-domain splitTender) - what Reports split the tax by, as
--             the SRB return asks for the sales at each rate. 0 on a cash
--             sale and on every order from before 0052.
--
-- No backfill, no CHECK, no index: a till from before 0052 sees nothing new,
-- and an order it wrote reads here exactly as it did there.
ALTER TABLE tax_categories ADD COLUMN digital_rate_bps INTEGER;
ALTER TABLE order_items ADD COLUMN digital_rate_bps_snapshot INTEGER;
ALTER TABLE orders ADD COLUMN digital_total_cents INTEGER;
ALTER TABLE orders ADD COLUMN digital_net_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN digital_tax_cents INTEGER NOT NULL DEFAULT 0;
